import os
import time

import psycopg2

DB_HOST     = os.getenv("DB_HOST", "localhost")
DB_PORT     = int(os.getenv("DB_PORT", "5432"))
DB_NAME     = os.getenv("DB_NAME", "cimubb")
DB_USER     = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")

conn = None


def conectar():
    global conn
    max_intentos = 5
    for intento in range(max_intentos):
        try:
            conn = psycopg2.connect(
                host=DB_HOST, port=DB_PORT, database=DB_NAME,
                user=DB_USER, password=DB_PASSWORD,
                connect_timeout=5
            )
            conn.autocommit = True
            print(f"[DB] Conectado a PostgreSQL: {DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}")
            _crear_tablas()
            return True
        except psycopg2.OperationalError as e:
            print(f"[DB] Intento {intento+1}/{max_intentos} falló: {e}")
            if intento < max_intentos - 1:
                time.sleep(2)
    print("[DB] No se pudo conectar a PostgreSQL — los datos no se persistirán")
    return False


def conectado():
    return conn is not None


def _crear_tablas():
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS alertas (
            id SERIAL PRIMARY KEY,
            node_id VARCHAR(64),
            zona VARCHAR(64),
            nivel VARCHAR(20),
            alertas TEXT[],
            temperatura FLOAT,
            humedad FLOAT,
            presion_bar FLOAT,
            humo_ppm INT,
            detector_activo BOOLEAN,
            fuga_detectada BOOLEAN,
            creado_en TIMESTAMPTZ DEFAULT now()
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS nodos (
            node_id VARCHAR(64) PRIMARY KEY,
            zona VARCHAR(64) NOT NULL,
            sensores TEXT[] NOT NULL,
            creado_en TIMESTAMPTZ DEFAULT now(),
            actualizado_en TIMESTAMPTZ DEFAULT now()
        )
    """)
    cursor.close()
    print("[DB] Tablas 'alertas' y 'nodos' verificadas")


def guardar_alerta(processed: dict):
    if not conn or not processed.get("alert"):
        return
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO alertas
            (node_id, zona, nivel, alertas, temperatura, humedad, presion_bar, humo_ppm, detector_activo, fuga_detectada)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            processed.get("node_id"),
            processed.get("zona"),
            processed.get("nivel"),
            processed.get("alertas"),
            processed.get("temperatura"),
            processed.get("humedad"),
            processed.get("presion_bar"),
            processed.get("humo_ppm"),
            processed.get("detector_activo"),
            processed.get("fuga_detectada"),
        ))
        cursor.close()
    except Exception as e:
        print(f"[DB ERROR] No se pudo guardar alerta: {e}")


def obtener_alertas(limite=50):
    if not conn:
        return []
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, node_id, zona, nivel, alertas, temperatura, humedad, presion_bar, humo_ppm,
                   detector_activo, fuga_detectada, creado_en
            FROM alertas
            ORDER BY creado_en DESC
            LIMIT %s
        """, (limite,))
        rows = cursor.fetchall()
        cursor.close()

        alertas = []
        for row in rows:
            alertas.append({
                "id": row[0],
                "node_id": row[1],
                "zona": row[2],
                "nivel": row[3],
                "alertas": row[4] or [],
                "temperatura": row[5],
                "humedad": row[6],
                "presion_bar": row[7],
                "humo_ppm": row[8],
                "detector_activo": row[9],
                "fuga_detectada": row[10],
                "creado_en": row[11].isoformat() if row[11] else None,
            })
        return alertas
    except Exception as e:
        print(f"[DB ERROR] No se pudieron obtener alertas: {e}")
        return []


def guardar_nodo(node_id: str, zona: str, sensores: list):
    if not conn:
        return
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO nodos (node_id, zona, sensores)
            VALUES (%s, %s, %s)
            ON CONFLICT (node_id) DO UPDATE
            SET zona = EXCLUDED.zona,
                sensores = EXCLUDED.sensores,
                actualizado_en = now()
        """, (node_id, zona, sensores))
        cursor.close()
    except Exception as e:
        print(f"[DB ERROR] No se pudo guardar nodo: {e}")


def obtener_nodos():
    if not conn:
        return []
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT node_id, zona, sensores FROM nodos ORDER BY node_id")
        rows = cursor.fetchall()
        cursor.close()
        return [
            {"node_id": r[0], "zona": r[1], "sensores": list(r[2] or [])}
            for r in rows
        ]
    except Exception as e:
        print(f"[DB ERROR] No se pudieron obtener nodos: {e}")
        return []


def eliminar_nodo(node_id: str):
    if not conn:
        return
    try:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM nodos WHERE node_id = %s", (node_id,))
        cursor.close()
    except Exception as e:
        print(f"[DB ERROR] No se pudo eliminar nodo: {e}")
