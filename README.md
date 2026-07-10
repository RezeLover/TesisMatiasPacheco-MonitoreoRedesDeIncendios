# Plataforma IoT de Prevención de Incendios — CIMUBB

Sistema de monitoreo en tiempo real para la prevención de incendios. Nodos ESP32 (simulados) publican lecturas de sensores por MQTT, un backend en Python procesa los datos, detecta alertas por umbral y las persiste en PostgreSQL, y un dashboard web muestra todo en vivo.

## Arquitectura

```
Nodos ESP32 ──MQTT──> Mosquitto ──> Backend Python ──WebSocket──> Dashboard web
                                         │
                                         ├──> PostgreSQL (alertas y registro de nodos)
                                         └──> CSV (lecturas crudas)
```

| Servicio | Descripción | Puerto |
|----------|-------------|--------|
| mosquitto | Broker MQTT | 1883 |
| backend | Procesamiento, detección de alertas y WebSocket | 8766 |
| nodo-01 a nodo-04 | Simuladores de nodos ESP32 | — |
| dashboard | Interfaz web (nginx) | 8080 |
| postgres | Base de datos | interno |

## Requisitos

- Docker Desktop instalado y corriendo.
- Puertos 1883, 8766 y 8080 libres.

## Cómo levantarlo

```
git clone https://github.com/USUARIO/REPOSITORIO.git
cd REPOSITORIO
docker compose up
```

La primera vez tarda unos minutos construyendo las imágenes. Cuando terminen de arrancar los contenedores, abrir:

**http://localhost:8080**

Para detener: `Ctrl+C` y luego `docker compose down`.

## Funcionalidades

- Monitoreo en vivo de temperatura, humedad, presión de agua, humo, detector y fuga por zona.
- Detección de alertas por umbral (temperatura > 55 °C, humedad < 20 %, presión < 1.5 bar, humo > 300 ppm, falla de detector, fuga de agua).
- Registro histórico de alertas persistido en PostgreSQL.
- Gestión de nodos desde el dashboard: crear, editar y eliminar nodos, con selección de qué sensores tiene cada uno.
- Auto-detección: cualquier nodo nuevo que publique por MQTT se registra automáticamente.
- Nodos con conjuntos de sensores variables (un nodo puede tener solo algunos sensores).
- Alarma sonora y visual mientras haya un estado crítico activo.
- Carga y reproducción de registros históricos desde Excel.

## Simular un evento crítico

Botón "SIMULAR CRÍTICO" en el panel izquierdo del dashboard, o esperar: los simuladores generan eventos críticos aleatorios (~3 % de probabilidad por lectura).

## Configuración opcional

Los puertos publicados pueden cambiarse creando un archivo `.env` (ver `.env.example`):

```
WS_PORT=8766
DASHBOARD_PORT=8080
```

Sin `.env`, se usan los valores por defecto.

## Consultar la base de datos

```
docker exec -it iot-postgres-v4 psql -U cimubb -d cimubb
```

Tablas: `alertas` (historial de alertas) y `nodos` (registro de nodos y sus sensores).
