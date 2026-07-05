# Modelo C4 — MediStock (guía para IcePanel)

Este documento define los tres niveles del modelo C4. Cada elemento incluye el **tipo de objeto que debes crear en IcePanel** (System, Actor, App, Store, Component) y sus conexiones, para que puedas replicarlo 1:1.

---

## Nivel 1 — Contexto (System Context)

**Objetos en IcePanel:**

| Objeto | Tipo IcePanel | Descripción |
|---|---|---|
| Cliente / Personal de farmacia | **Actor** | Usuario que consulta el catálogo y registra pedidos de insumos médicos |
| Administrador | **Actor** | Gestiona el catálogo de productos |
| **MediStock** | **System** | Ecosistema de gestión de insumos médicos: catálogo, pedidos y notificaciones |
| Servicio de Email/SMS | **System (External)** | Proveedor externo al que se enviarían las notificaciones (simulado) |

**Conexiones (flechas):**
- Cliente → MediStock: *"Consulta productos y crea pedidos [HTTPS/REST]"*
- Administrador → MediStock: *"Administra el catálogo [HTTPS/REST]"*
- MediStock → Servicio Email/SMS: *"Envía notificaciones de pedidos [SMTP/API]"*

---

## Nivel 2 — Contenedores (dentro del System MediStock)

**Objetos en IcePanel (tipo App o Store dentro del sistema MediStock):**

| Objeto | Tipo IcePanel | Tecnología | Descripción |
|---|---|---|---|
| API Gateway | **App** | Node.js + Express | Punto único de entrada; enruta REST, rate limiting, Swagger UI |
| Catálogo Service | **App** | Node.js + Express | Microservicio de productos e inventario |
| Pedidos Service | **App** | Node.js + Express | Microservicio de pedidos; productor de eventos |
| Notificaciones Lambda | **App (Serverless)** | Serverless Framework / AWS Lambda | Funciones HTTP + worker consumidor de la cola |
| MongoDB Catálogo | **Store** | MongoDB 7 (Docker) | Base documental de productos |
| PostgreSQL Pedidos | **Store** | PostgreSQL 16 (Docker) | Base relacional de pedidos |
| Redis | **Store** | Redis 7 (Docker) | Caché del catálogo + almacenamiento de notificaciones |
| RabbitMQ | **App (Message Broker)** | RabbitMQ 3 | Gestor de colas `pedidos.eventos` |

**Conexiones:**
- Cliente → API Gateway: *"REST/JSON [HTTPS]"*
- API Gateway → Catálogo Service: *"Proxy /api/productos [HTTP]"*
- API Gateway → Pedidos Service: *"Proxy /api/pedidos [HTTP]"*
- API Gateway → Notificaciones Lambda: *"Proxy /api/notificaciones [HTTP]"*
- Catálogo Service → MongoDB Catálogo: *"Lee/escribe productos [Mongoose/TCP 27017]"*
- Catálogo Service → Redis: *"Cache-Aside con TTL 60s [RESP/6379]"*
- Pedidos Service → PostgreSQL Pedidos: *"Persiste pedidos [SQL/5432]"*
- Pedidos Service → Catálogo Service: *"Valida producto y descuenta stock [REST síncrono]"*
- Pedidos Service → RabbitMQ: *"Publica evento pedido.creado [AMQP 5672]"*
- RabbitMQ → Notificaciones Lambda: *"Entrega eventos al worker [AMQP]"*
- Notificaciones Lambda → Redis: *"Persiste y lee notificaciones [RESP]"*

---

## Nivel 3 — Componentes

### 3a. Componentes de Catálogo Service
| Componente | Descripción |
|---|---|
| Express Router (Productos) | Endpoints CRUD + `/descontar` |
| Controlador de Productos | Lógica de negocio y validaciones |
| Repositorio Mongoose | Acceso a MongoDB (patrón Repository) |
| Módulo de Caché | Implementa Cache-Aside sobre Redis (get/setEx/del) |
| Health Check | `/health` |

Flujo: Router → Controlador → (Caché ⇄ Repositorio) → MongoDB/Redis

### 3b. Componentes de Pedidos Service
| Componente | Descripción |
|---|---|
| Express Router (Pedidos) | `POST /pedidos`, `GET /pedidos`, `GET /pedidos/:id` |
| Controlador de Pedidos | Orquesta validación, persistencia y publicación |
| Cliente HTTP Catálogo | Axios → catalogo-service (validación + descuento de stock) |
| Repositorio PG | Pool de conexiones + consultas parametrizadas |
| Publicador AMQP | Publica `pedido.creado` (mensajes persistentes) |

### 3c. Componentes de Notificaciones Lambda
| Componente | Descripción |
|---|---|
| Función `listarNotificaciones` | Lambda HTTP GET /notificaciones |
| Función `obtenerNotificacion` | Lambda HTTP GET /notificaciones/{id} |
| Función `health` | Lambda HTTP GET /health |
| Worker Consumidor | Consume `pedidos.eventos`, genera la notificación (patrón Competing Consumers) |
| Cliente Redis | Persistencia ligera de notificaciones |

---

## Pasos en IcePanel

1. Crear **Landscape** "MediStock" → agregar los 2 Actores y los 2 Systems del Nivel 1 con sus conexiones.
2. Entrar al System MediStock → agregar las 8 Apps/Stores del Nivel 2 y dibujar las conexiones con sus etiquetas de protocolo.
3. Entrar a cada App → agregar los componentes del Nivel 3.
4. Crear un **Flow** llamado "Crear pedido" con la secuencia: Cliente → Gateway → Pedidos → Catálogo → PostgreSQL → RabbitMQ → Worker → Redis (IcePanel permite numerar los pasos del flujo).
5. Etiquetar (tags) cada elemento con su patrón: `microservicio`, `serverless`, `cache`, `message-broker`, `database-per-service`.
