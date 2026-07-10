# Plataforma IoT de Supervisión de Continuidad Operativa y Gestión para la Prevención de Incendios

Entrega: orquestación con Docker Compose (fullstack IoT). Nodos ESP32 simulados que publican por MQTT, backend en Python que procesa y detecta alertas, base de datos PostgreSQL para el registro histórico y dashboard web en tiempo real.

Repositorio: https://github.com/RezeLover/TesisMatiasPacheco-MonitoreoRedesDeIncendios.git

Requisitos:

Tener instalado Docker Desktop.

Cómo levantar el proyecto (Windows PowerShell):

1. Clona el repositorio: git clone https://github.com/RezeLover/TesisMatiasPacheco-MonitoreoRedesDeIncendios.git

2. Entra a la carpeta: cd TesisMatiasPacheco-MonitoreoRedesDeIncendios

3. Levanta los contenedores: docker compose up

La primera vez tarda unos minutos construyendo las imágenes. Cuando los contenedores estén arriba, abrir http://localhost:8080 en el navegador.

Opcional: si se quieren cambiar los puertos publicados, copiar el archivo de ejemplo con Copy-Item .env.example .env y editarlo. Sin este archivo se usan los puertos por defecto (8080 y 8766).

Dónde se ve:

- Dashboard: http://localhost:8080
- WebSocket del dashboard: ws://localhost:8766
- Broker MQTT (nodos ESP32): puerto 1883

Servicios:

- mosquitto: broker MQTT que recibe los datos de los nodos.
- backend (backend_server.py): procesa las lecturas, detecta alertas por umbral, las guarda en PostgreSQL y las retransmite al dashboard.
- nodo-01 a nodo-04: simuladores de nodos ESP32 que publican lecturas de sensores por MQTT.
- postgres: base de datos con el historial de alertas y el registro de nodos.
- dashboard (nginx): visualiza en vivo las lecturas, alertas y estado de cada nodo.

Nota: los nodos simulados (nodo-01 a nodo-04) reemplazan a los ESP32 físicos, que se integrarán después conectándolos al mismo broker MQTT.
