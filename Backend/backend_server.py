import asyncio
import csv
import os
import json
import math
import random
import statistics
from collections import deque
from datetime import datetime

import paho.mqtt.client as mqtt

import db

try:
    from websockets.legacy.server import serve as _ws_serve
    from websockets.exceptions import ConnectionClosed
except ImportError:
    from websockets import serve as _ws_serve
    from websockets.exceptions import ConnectionClosed

MQTT_HOST      = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT      = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC_SUB = "cimubb/+/sensores"

WS_HOST = "0.0.0.0"
WS_PORT = 8766

ARCHIVO_CSV = os.getenv("CSV_PATH", "registro_sensores.csv")
BUFFER_SIZE = 200

NODO_TIMEOUT_S  = 60.0
WATCHDOG_TICK_S = 10.0

UMBRAL_TEMP    = 55.0
UMBRAL_HUM     = 20.0
UMBRAL_PRESION = 1.5
UMBRAL_HUMO    = 300

SENSORES_VALIDOS = ["temperatura", "humedad", "presion", "humo", "detector", "fuga"]

CAMPO_POR_SENSOR = {
    "temperatura": "temperatura",
    "humedad":     "humedad",
    "presion":     "presion_bar",
    "humo":        "humo_ppm",
    "detector":    "detector_activo",
    "fuga":        "fuga_detectada",
}

COLUMNAS_CSV = [
    "Fecha/Hora", "NodeID", "Zona",
    "Temperatura", "Humedad", "Presion_bar",
    "Humo_ppm", "Detector_activo", "Fuga_detectada",
]

dashboards     = set()
buffer_datos   = deque(maxlen=BUFFER_SIZE)
pkt_counter    = 0
stats_nodo     = {}
nodos_estado   = {}
nodos_registro = {}
demo_activo    = False
demo_task      = None
_loop          = None


def sensores_de_paquete(raw: dict) -> list:
    return [s for s, campo in CAMPO_POR_SENSOR.items() if campo in raw]


def lista_nodos_registro() -> list:
    return [
        {"node_id": nid, "zona": info["zona"], "sensores": info["sensores"]}
        for nid, info in sorted(nodos_registro.items())
    ]


def registrar_nodo(node_id: str, zona: str, sensores: list):
    nodos_registro[node_id] = {"zona": zona, "sensores": sensores}
    db.guardar_nodo(node_id, zona, sensores)
    if node_id in nodos_estado:
        nodos_estado[node_id]["zona"] = zona
    else:
        nodos_estado[node_id] = {"online": False, "last_seen": None, "zona": zona}


def cargar_nodos_registro():
    for n in db.obtener_nodos():
        nodos_registro[n["node_id"]] = {"zona": n["zona"], "sensores": n["sensores"]}
        if n["node_id"] not in nodos_estado:
            nodos_estado[n["node_id"]] = {"online": False, "last_seen": None, "zona": n["zona"]}
    if nodos_registro:
        print(f"[NODOS] {len(nodos_registro)} nodo(s) cargados del registro")


def guardar_csv(datos: dict):
    def celda(v):
        return "" if v is None else v

    existe = os.path.isfile(ARCHIVO_CSV)
    with open(ARCHIVO_CSV, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNAS_CSV, extrasaction="ignore")
        if not existe:
            w.writeheader()
        w.writerow({
            "Fecha/Hora":      datos.get("timestamp", datetime.now().isoformat()),
            "NodeID":          datos.get("node_id", "?"),
            "Zona":            datos.get("zona", "—"),
            "Temperatura":     celda(datos.get("temperatura")),
            "Humedad":         celda(datos.get("humedad")),
            "Presion_bar":     celda(datos.get("presion_bar")),
            "Humo_ppm":        celda(datos.get("humo_ppm")),
            "Detector_activo": celda(datos.get("detector_activo")),
            "Fuga_detectada":  celda(datos.get("fuga_detectada")),
        })


def procesar_paquete(raw: dict) -> dict:
    global pkt_counter
    pkt_counter += 1

    nid     = raw.get("node_id", "?")
    temp    = raw.get("temperatura")
    hum     = raw.get("humedad")
    presion = raw.get("presion_bar")
    humo    = raw.get("humo_ppm")
    det_ok  = raw.get("detector_activo")
    fuga    = raw.get("fuga_detectada")

    if nid not in stats_nodo:
        stats_nodo[nid] = {
            "temperatura": deque(maxlen=20),
            "humedad":     deque(maxlen=20),
            "presion_bar": deque(maxlen=20),
            "humo_ppm":    deque(maxlen=20),
        }

    s = stats_nodo[nid]
    if temp    is not None: s["temperatura"].append(float(temp))
    if hum     is not None: s["humedad"].append(float(hum))
    if presion is not None: s["presion_bar"].append(float(presion))
    if humo    is not None: s["humo_ppm"].append(int(humo))

    def avg(d): return round(statistics.mean(d), 2) if d else None

    alertas = []
    nivel   = "OK"
    if temp    is not None and float(temp)    > UMBRAL_TEMP:    alertas.append(f"TEMP_ALTA: {temp}°C");        nivel = "CRITICO"
    if hum     is not None and float(hum)     < UMBRAL_HUM:     alertas.append(f"HUMEDAD_BAJA: {hum}%");       nivel = "CRITICO"
    if presion is not None and float(presion) < UMBRAL_PRESION: alertas.append(f"PRESION_BAJA: {presion}bar"); nivel = "CRITICO"
    if humo    is not None and int(humo)      > UMBRAL_HUMO:    alertas.append(f"HUMO_ALTO: {humo}ppm");       nivel = "CRITICO"
    if det_ok  is not None and not det_ok:                      alertas.append("DETECTOR_SIN_RESPUESTA");      nivel = nivel if nivel == "CRITICO" else "ADVERTENCIA"
    if fuga    is not None and fuga:                            alertas.append("FUGA_DETECTADA");              nivel = "CRITICO"

    return {
        **raw,
        "pkt_num":     pkt_counter,
        "server_ts":   datetime.now().isoformat(),
        "nivel":       nivel,
        "alert":       bool(alertas),
        "alertas":     alertas,
        "avg_temp":    avg(s["temperatura"]),
        "avg_hum":     avg(s["humedad"]),
        "avg_presion": avg(s["presion_bar"]),
        "avg_humo":    avg(s["humo_ppm"]),
        "nodos_activos": len([n for n in nodos_estado.values() if n["online"]]),
    }


def entrada_alerta(processed: dict) -> dict:
    return {
        "node_id":         processed.get("node_id"),
        "zona":            processed.get("zona"),
        "nivel":           processed.get("nivel"),
        "alertas":         processed.get("alertas"),
        "temperatura":     processed.get("temperatura"),
        "humedad":         processed.get("humedad"),
        "presion_bar":     processed.get("presion_bar"),
        "humo_ppm":        processed.get("humo_ppm"),
        "detector_activo": processed.get("detector_activo"),
        "fuga_detectada":  processed.get("fuga_detectada"),
        "creado_en":       processed.get("server_ts"),
    }


async def broadcast(msg: str):
    if not dashboards:
        return
    dead = set()
    for ws in dashboards:
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    dashboards.difference_update(dead)


async def broadcast_node_status():
    await broadcast(json.dumps({"type": "node_status", "nodes": nodos_estado}))


async def broadcast_nodos_config():
    await broadcast(json.dumps({"type": "nodos_config", "nodos": lista_nodos_registro()}))


async def watchdog_nodos():
    while True:
        await asyncio.sleep(WATCHDOG_TICK_S)
        ahora = datetime.now()
        cambio = False
        for nid, info in nodos_estado.items():
            if not info.get("online"):
                continue
            try:
                last = datetime.fromisoformat(info["last_seen"])
            except (KeyError, TypeError, ValueError):
                continue
            if (ahora - last).total_seconds() > NODO_TIMEOUT_S:
                info["online"] = False
                cambio = True
                print(f"[WATCHDOG] {nid} sin datos por >{NODO_TIMEOUT_S:.0f}s -> offline")
        if cambio:
            await broadcast_node_status()


def _on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f"[MQTT] Conectado a {MQTT_HOST}:{MQTT_PORT}")
        client.subscribe(MQTT_TOPIC_SUB)
        print(f"[MQTT] Suscrito a {MQTT_TOPIC_SUB}")
    else:
        print(f"[MQTT] Error de conexión (rc={rc})")


def _on_message(client, userdata, msg):
    try:
        raw = json.loads(msg.payload.decode())
        nid = raw.get("node_id", "?")

        nuevo = nid not in nodos_registro
        if nuevo:
            registrar_nodo(nid, raw.get("zona", "—"), sensores_de_paquete(raw))
            print(f"[NODOS] Nodo detectado y registrado: {nid}")
        else:
            raw["zona"] = nodos_registro[nid]["zona"]

        nodos_estado[nid] = {
            "online":    True,
            "last_seen": datetime.now().isoformat(),
            "zona":      raw.get("zona", "—"),
        }

        processed = procesar_paquete(raw)
        guardar_csv(raw)
        db.guardar_alerta(processed)
        buffer_datos.append(processed)

        det  = raw.get("detector_activo")
        fuga = raw.get("fuga_detectada")
        det_str  = "--" if det  is None else ("OK" if det else "FALLA")
        fuga_str = "--" if fuga is None else ("SI" if fuga else "NO")
        print(f"[PKT #{processed['pkt_num']:04d}] {nid}: "
              f"T={raw.get('temperatura', '--')}  H={raw.get('humedad', '--')}  "
              f"P={raw.get('presion_bar', '--')}  Humo={raw.get('humo_ppm', '--')}  "
              f"Det={det_str}  Fuga={fuga_str}")
        if processed["alert"]:
            print(f"  *** {' | '.join(processed['alertas'])}")

        ack = json.dumps({"status": "OK", "pkt_num": processed["pkt_num"], "nivel": processed["nivel"]})
        client.publish(f"cimubb/{nid}/ack", ack)

        if _loop:
            asyncio.run_coroutine_threadsafe(broadcast(json.dumps(processed)), _loop)
            asyncio.run_coroutine_threadsafe(broadcast_node_status(), _loop)
            if nuevo:
                asyncio.run_coroutine_threadsafe(broadcast_nodos_config(), _loop)
            if processed["alert"]:
                asyncio.run_coroutine_threadsafe(
                    broadcast(json.dumps({"type": "alert_log_entry", "entry": entrada_alerta(processed)})), _loop
                )

    except Exception as e:
        print(f"[MQTT ERROR] {e}")


def _on_disconnect(client, userdata, rc):
    print(f"[MQTT] Desconectado del broker (rc={rc})")


async def _demo_loop():
    t = 0
    demo_nodes = [
        {"node_id": "ESP32-Demo-01", "zona": "Zona-A", "tb": 23.0, "hb": 55.0},
        {"node_id": "ESP32-Demo-02", "zona": "Zona-B", "tb": 25.0, "hb": 50.0},
    ]
    print("[DEMO] Modo demo iniciado — generando datos simulados")
    while demo_activo:
        t += 1
        for n in demo_nodes:
            fire = random.random() > 0.97
            raw = {
                "node_id":          n["node_id"],
                "zona":             n["zona"],
                "timestamp":        datetime.now().isoformat(),
                "temperatura":      round(n["tb"] + 4 * math.sin(t / 10) + random.gauss(0, 0.3), 1) if not fire else round(random.uniform(57, 75), 1),
                "humedad":          round(max(15, min(80, n["hb"] + 8 * math.cos(t / 12))), 1)       if not fire else round(random.uniform(8, 18), 1),
                "presion_bar":      round(random.uniform(2.5, 5.5) + 0.5 * math.sin(t / 40), 1),
                "humo_ppm":         random.randint(50, 150) if not fire else random.randint(310, 600),
                "detector_activo":  random.random() > 0.05,
                "fuga_detectada":   random.random() > 0.97,
                "pkt_num":          t,
            }
            nodos_estado[n["node_id"]] = {
                "online":    True,
                "last_seen": datetime.now().isoformat(),
                "zona":      n["zona"],
            }
            processed = procesar_paquete(raw)
            buffer_datos.append(processed)
            await broadcast(json.dumps(processed))
        await broadcast_node_status()
        await asyncio.sleep(15.0)
    print("[DEMO] Modo demo detenido")


async def handler_dashboard(ws):
    global demo_activo, demo_task
    addr = ws.remote_address
    print(f"[DASH] Conectado: {addr}")
    dashboards.add(ws)

    if buffer_datos:
        await ws.send(json.dumps({
            "type":  "history",
            "data":  list(buffer_datos)[-50:],
            "total": pkt_counter,
        }))

    await ws.send(json.dumps({
        "type": "alert_log",
        "data": db.obtener_alertas(50),
    }))

    await ws.send(json.dumps({"type": "nodos_config", "nodos": lista_nodos_registro()}))
    await ws.send(json.dumps({"type": "node_status", "nodes": nodos_estado}))

    try:
        async for raw_msg in ws:
            try:
                cmd = json.loads(raw_msg)
                action = cmd.get("cmd")

                if action == "demo_start" and not demo_activo:
                    demo_activo = True
                    demo_task = asyncio.create_task(_demo_loop())

                elif action == "demo_stop":
                    demo_activo = False
                    if demo_task:
                        demo_task.cancel()
                        demo_task = None

                elif action == "sim_alerta":
                    raw_alert = {
                        "node_id":         "ESP32-Nodo-01",
                        "zona":            nodos_registro.get("ESP32-Nodo-01", {}).get("zona", "Zona-A"),
                        "timestamp":       datetime.now().isoformat(),
                        "temperatura":     68.5,
                        "humedad":         12.0,
                        "presion_bar":     1.1,
                        "humo_ppm":        450,
                        "detector_activo": False,
                        "fuga_detectada":  True,
                    }
                    proc = procesar_paquete(raw_alert)
                    db.guardar_alerta(proc)
                    await broadcast(json.dumps(proc))
                    if proc.get("alert"):
                        await broadcast(json.dumps({"type": "alert_log_entry", "entry": entrada_alerta(proc)}))

                elif action in ("crear_nodo", "editar_nodo"):
                    nid = (cmd.get("node_id") or "").strip()
                    zona = (cmd.get("zona") or "").strip() or "—"
                    sensores = [s for s in (cmd.get("sensores") or []) if s in SENSORES_VALIDOS]
                    if nid:
                        registrar_nodo(nid, zona, sensores)
                        print(f"[NODOS] Nodo {'creado' if action == 'crear_nodo' else 'editado'}: {nid} ({zona})")
                        await broadcast_nodos_config()
                        await broadcast_node_status()

                elif action == "eliminar_nodo":
                    nid = cmd.get("node_id")
                    if nid:
                        nodos_registro.pop(nid, None)
                        nodos_estado.pop(nid, None)
                        stats_nodo.pop(nid, None)
                        db.eliminar_nodo(nid)
                        print(f"[NODOS] Nodo eliminado: {nid}")
                        await broadcast_nodos_config()
                        await broadcast_node_status()

            except json.JSONDecodeError:
                pass

    except ConnectionClosed:
        pass
    finally:
        dashboards.discard(ws)
        print(f"[DASH] Desconectado: {addr}")


async def main():
    global _loop
    _loop = asyncio.get_running_loop()

    db.conectar()
    cargar_nodos_registro()

    mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
    mqtt_client.on_connect    = _on_connect
    mqtt_client.on_message    = _on_message
    mqtt_client.on_disconnect = _on_disconnect

    try:
        mqtt_client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
        mqtt_client.loop_start()
    except Exception as e:
        print(f"[MQTT] No se pudo conectar al broker: {e}")
        print("[MQTT] Corriendo solo WebSocket — usa Modo Demo en el dashboard\n")

    print(f"\n{'='*55}")
    print(f"  Backend IoT — Sistema Prevención Incendios CIMUBB")
    print(f"  MQTT subscriber: {MQTT_HOST}:{MQTT_PORT}")
    print(f"  WebSocket dashboard: ws://{WS_HOST}:{WS_PORT}")
    print(f"  CSV: {ARCHIVO_CSV}")
    if db.conectado():
        print(f"  PostgreSQL: {db.DB_USER}@{db.DB_HOST}:{db.DB_PORT}/{db.DB_NAME}")
    print(f"{'='*55}\n")

    asyncio.create_task(watchdog_nodos())

    async with _ws_serve(handler_dashboard, WS_HOST, WS_PORT):
        print("[WS] Esperando conexiones del dashboard...\n")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
