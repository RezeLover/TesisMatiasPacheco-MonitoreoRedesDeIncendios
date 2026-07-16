import argparse
import json
import math
import os
import random
import threading
import time
from datetime import datetime

import paho.mqtt.client as mqtt

MQTT_HOST     = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT     = int(os.getenv("MQTT_PORT", "1883"))
SIM_CONTROL   = "cimubb/sim/control"
SEND_INTERVAL = 15.0

ZONA_DEFAULT = {1: "Zona-A", 2: "Zona-B", 3: "Zona-C", 4: "Zona-D"}

CAMPO_POR_SENSOR = {
    "temperatura": "temperatura",
    "humedad":     "humedad",
    "presion":     "presion_bar",
    "humo":        "humo_ppm",
    "detector":    "detector_activo",
    "fuga":        "fuga_detectada",
}
TODOS_SENSORES = ",".join(CAMPO_POR_SENSOR.keys())


class SensorSimulator:

    def __init__(self, node_id: str, zona: str):
        self.node_id   = node_id
        self.zona      = zona
        self.t         = 0
        self.temp_base = 20.0 + random.uniform(0, 5)
        self.hum_base  = 50.0 + random.uniform(0, 10)

    def tick(self) -> dict:
        self.t += 1
        fire = random.random() > 0.97

        temp    = round(self.temp_base + 3.0 * math.sin(self.t / 30) + random.gauss(0, 0.3), 1)
        hum     = round(max(15, min(85, self.hum_base + 8.0 * math.cos(self.t / 20))), 1)
        presion = round(random.uniform(2.5, 5.5) + 0.5 * math.sin(self.t / 40), 1)
        humo    = random.randint(50, 150)
        det_ok  = random.random() > 0.05
        fuga    = random.random() > 0.97

        if fire:
            temp    = round(random.uniform(57, 75), 1)
            hum     = round(random.uniform(8, 18), 1)
            humo    = random.randint(310, 600)
            det_ok  = False
            fuga    = True

        return {
            "node_id":         self.node_id,
            "zona":            self.zona,
            "timestamp":       datetime.now().isoformat(),
            "temperatura":     temp,
            "humedad":         hum,
            "presion_bar":     presion,
            "humo_ppm":        humo,
            "detector_activo": det_ok,
            "fuga_detectada":  fuga,
            "pkt_num":         self.t,
            "uptime_s":        round(self.t * SEND_INTERVAL, 1),
        }


def main():
    parser = argparse.ArgumentParser(description="Simulador nodo ESP32 — Prevención Incendios CIMUBB")
    parser.add_argument("--nodo", type=int, default=1, metavar="N",
                        help="Número de nodo (default: 1)")
    parser.add_argument("--zona", type=str, default=None,
                        help="Zona personalizada (ej: E). Si se omite, se asigna según el nodo")
    parser.add_argument("--sensores", type=str, default=TODOS_SENSORES,
                        help=f"Sensores del nodo separados por coma (default: {TODOS_SENSORES})")
    args = parser.parse_args()

    sensores = [s.strip() for s in args.sensores.split(",") if s.strip() in CAMPO_POR_SENSOR]
    campos_activos = {CAMPO_POR_SENSOR[s] for s in sensores}
    campos_sensor  = set(CAMPO_POR_SENSOR.values())

    node_id   = f"ESP32-Nodo-{args.nodo:02d}"
    zona      = f"Zona-{args.zona.upper()}" if args.zona else ZONA_DEFAULT.get(args.nodo, f"Zona-N{args.nodo}")
    topic_pub = f"cimubb/{node_id}/sensores"
    topic_ack = f"cimubb/{node_id}/ack"

    sensor    = SensorSimulator(node_id, zona)
    ack_event = threading.Event()
    sim_on    = threading.Event()

    print(f"\n{'='*55}")
    print(f"  Simulador ESP32: {node_id}  |  {zona}")
    print(f"  Sensores:        {', '.join(sensores)}")
    print(f"  Publicando en:   {topic_pub}")
    print(f"  ACK en:          {topic_ack}")
    print(f"  Intervalo:       {SEND_INTERVAL}s")
    print(f"{'='*55}\n")

    def on_connect(client, userdata, flags, rc):
        if rc == 0:
            print(f"[{node_id}] Conectado al broker MQTT {MQTT_HOST}:{MQTT_PORT}")
            client.subscribe(topic_ack)
            client.subscribe(SIM_CONTROL)
        else:
            print(f"[{node_id}] Error de conexión MQTT (rc={rc})")

    def on_message(client, userdata, msg):
        try:
            data = json.loads(msg.payload.decode())
            if msg.topic == SIM_CONTROL:
                if data.get("activo"):
                    if not sim_on.is_set():
                        print(f"[{node_id}] Simulación iniciada desde el dashboard")
                    sim_on.set()
                else:
                    if sim_on.is_set():
                        print(f"[{node_id}] Simulación detenida desde el dashboard")
                    sim_on.clear()
                return
            print(f"  <- ACK pkt#{data.get('pkt_num')}  nivel={data.get('nivel', '?')}")
            ack_event.set()
        except Exception:
            pass

    def on_disconnect(client, userdata, rc):
        print(f"[{node_id}] Desconectado del broker (rc={rc})")

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
    client.on_connect    = on_connect
    client.on_message    = on_message
    client.on_disconnect = on_disconnect

    while True:
        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
            break
        except Exception as e:
            print(f"[{node_id}] Broker no disponible ({e}). Reintentando en 5s...")
            time.sleep(5)

    client.loop_start()
    print(f"[{node_id}] En espera — la simulación se inicia desde el dashboard\n")

    avisado = False
    try:
        while True:
            if not sim_on.is_set():
                if not avisado:
                    print(f"[{node_id}] En espera de la orden de simulación...")
                    avisado = True
                sim_on.wait(timeout=2.0)
                continue
            avisado = False

            packet = sensor.tick()
            packet = {k: v for k, v in packet.items() if k not in campos_sensor or k in campos_activos}
            client.publish(topic_pub, json.dumps(packet))

            ts   = packet["timestamp"][11:19]
            det  = packet.get("detector_activo")
            fuga = packet.get("fuga_detectada")
            det_str  = "--" if det  is None else ("OK" if det else "FALLA")
            fuga_str = "--" if fuga is None else ("SI" if fuga else "NO")

            print(f"[{ts}] -> T={packet.get('temperatura', '--')}  "
                  f"H={packet.get('humedad', '--')}  "
                  f"P={packet.get('presion_bar', '--')}  "
                  f"Humo={packet.get('humo_ppm', '--')}  "
                  f"Det={det_str}  Fuga={fuga_str}")

            ack_event.clear()
            ack_event.wait(timeout=3.0)
            time.sleep(SEND_INTERVAL)

    except KeyboardInterrupt:
        print(f"\n[{node_id}] Deteniendo simulador...")
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
