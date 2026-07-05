# MediStock — Ecosistema de Gestión de Insumos Médicos

**ISWZ2202 — Diseño y Arquitectura de Software**
**Estudiante:** Emily Pozo — Universidad de las Américas

Solución de arquitectura basada en **microservicios + serverless**, compuesta por un ecosistema de **3 aplicaciones**, **3 capas de datos dockerizadas**, un **gestor de colas (RabbitMQ)** y un **API Gateway** centralizado documentado con **Swagger/OpenAPI**.

---

## 1. Visión general del ecosistema

| # | Aplicación | Tecnología | Capa de datos | Rol |
|---|------------|-----------|---------------|-----|
| 1 | **catalogo-service** | Node.js + Express | **MongoDB** (Docker) + **Redis** (caché) | Catálogo de insumos médicos, control atómico de stock |
| 2 | **pedidos-service** | Node.js + Express | **PostgreSQL** (Docker) | Registro de pedidos, **productor** de eventos a RabbitMQ |
| 3 | **notificaciones-lambda** | **Serverless Framework (Lambdas)** | **Redis** (Docker) | **Consumidor** de la cola; genera notificaciones y las expone vía funciones HTTP |
| — | **api-gateway** | Node.js + http-proxy-middleware | — | Punto único de entrada REST + Swagger UI + rate limiting |
| — | **rabbitmq** | RabbitMQ 3 (management) | — | Gestor de colas para mensajería asíncrona |

**Estilos y patrones aplicados:** Microservicios, Serverless (FaaS), API Gateway, Database-per-Service, Publisher/Subscriber, Competing Consumers, Cache-Aside, Repository, Rate Limiting/Throttling, Health Check, Saga (coreografía simple para el flujo de pedido).

---

## 2. Flujo principal (crear un pedido)

1. El cliente llama `POST /api/pedidos` en el **API Gateway** (puerto 8080).
2. El gateway enruta al **pedidos-service**, que consulta el producto al **catalogo-service** (REST síncrono).
3. El catálogo **descuenta stock de forma atómica** en MongoDB (evita condiciones de carrera).
4. El pedido se persiste en **PostgreSQL**.
5. Se publica el evento `pedido.creado` en la cola **RabbitMQ** (mensaje persistente).
6. El **worker** de la app serverless consume el evento y genera la notificación en **Redis**.
7. Las **Lambdas** (`GET /api/notificaciones`) exponen las notificaciones al exterior a través del gateway.

---

## 3. Cómo ejecutar

```bash
docker compose up --build
```

| Recurso | URL |
|---|---|
| API Gateway | http://localhost:8080 |
| **Swagger UI** | http://localhost:8080/docs |
| Health del ecosistema | http://localhost:8080/health |
| RabbitMQ Management | http://localhost:15672 (guest/guest) |

### Prueba end-to-end

```bash
# 1) Listar productos (primera vez: source=db; segunda: source=cache)
curl http://localhost:8080/api/productos

# 2) Crear pedido (usa un _id real del paso anterior)
curl -X POST http://localhost:8080/api/pedidos \
  -H "Content-Type: application/json" \
  -d '{"cliente":"Emily Pozo","productoId":"<ID_PRODUCTO>","cantidad":2}'

# 3) Ver la notificación generada por la Lambda vía la cola
curl http://localhost:8080/api/notificaciones
```

### Publicar la API en SwaggerHub
1. Ir a https://app.swaggerhub.com → **Create New → Import API**.
2. Subir `gateway/openapi.yaml` (o pegar su contenido).
3. Publicar como `MediStock-API v1.0.0`.

---

## 4. Análisis de la arquitectura

### 4.1 Caché
- Se implementa el patrón **Cache-Aside** con **Redis** en el catálogo: los listados y productos individuales se sirven desde caché con **TTL de 60 s**; las escrituras (crear producto, descontar stock) **invalidan** las claves afectadas.
- Impacto: las lecturas del catálogo (la operación más frecuente) pasan de ~15–30 ms (Mongo) a **<1–2 ms** (Redis), reduciendo carga sobre MongoDB.
- Evolución: en producción, Redis se desplegaría como **ElastiCache** con réplicas; también se agregaría caché HTTP en el gateway/CDN (CloudFront) para respuestas públicas.

### 4.2 Balanceo de carga
- **Local:** el API Gateway centraliza el tráfico; cada servicio es *stateless*, por lo que se puede escalar con `docker compose up --scale catalogo-service=3` detrás de un Nginx/HAProxy.
- **Producción:** un **Application Load Balancer (ALB)** distribuiría tráfico entre réplicas de cada microservicio (ECS/Kubernetes) usando round-robin + health checks (`/health`). Las Lambdas balancean automáticamente (AWS gestiona la concurrencia).
- La cola RabbitMQ balancea el trabajo de fondo entre **consumidores competidores** (`prefetch(1)`): agregar más workers reparte los mensajes sin duplicarlos.

### 4.3 Indexación
- **MongoDB (catálogo):** índices simples en `nombre` y `categoria`, más un **índice compuesto `{categoria, precio}`** que cubre la consulta más frecuente (listado por categoría ordenado por precio) → evita *collection scans*.
- **PostgreSQL (pedidos):** índices B-tree en `cliente`, `estado` y `creado_en DESC` para consultas de historial y paginación.
- **Redis:** acceso O(1) por clave; la lista `notificaciones` se recorta a 200 elementos (`LTRIM`) para mantener lecturas acotadas.

### 4.4 Redundancia
- **Datos:** volúmenes Docker persistentes por cada base; los mensajes de RabbitMQ son **durables + persistentes**, sobreviven reinicios del broker.
- **Producción:** MongoDB en **replica set** (3 nodos), PostgreSQL con **réplica de lectura + standby síncrono (Multi-AZ)**, Redis con réplica y RabbitMQ en clúster con **quorum queues**. Cada microservicio con mínimo **2 réplicas en zonas de disponibilidad distintas**.

### 4.5 Disponibilidad
- **Health checks** en cada servicio (`/health`) y un **health agregado** en el gateway que reporta el estado global del ecosistema; Docker Compose usa `healthcheck` + `depends_on: condition: service_healthy` para arranque ordenado.
- El desacoplamiento por cola aumenta la disponibilidad percibida: si Notificaciones cae, **los pedidos siguen funcionando** y los mensajes quedan encolados hasta su recuperación.
- Objetivo de producción: **99.9 % (SLA)** con multi-AZ, auto-restart (ECS) y reintentos con backoff.

### 4.6 Concurrencia
- **Stock:** `findOneAndUpdate({stock: {$gte: n}}, {$inc: {stock: -n}})` es **atómico** en MongoDB → dos pedidos simultáneos jamás dejan stock negativo (control optimista sin locks).
- **PostgreSQL:** pool de 10 conexiones reutilizables; las transacciones ACID garantizan consistencia de los pedidos.
- **Cola:** `prefetch(1)` + `ack` manual permite procesar en paralelo con N workers manteniendo entrega *at-least-once*.
- **Lambdas:** AWS escala instancias concurrentes automáticamente por invocación.

### 4.7 Latencia
- Lecturas calientes servidas por Redis (**<2 ms**); paginación obligatoria en pedidos (máx. 100 filas) evita respuestas gigantes.
- La notificación es **asíncrona**: el usuario recibe respuesta del pedido en ~50–100 ms sin esperar el envío del email (ese costo se traslada al worker).
- Presupuesto de latencia estimado (p95, local): gateway +2 ms, catálogo con caché 2 ms / sin caché 20 ms, creación de pedido 80–120 ms (incluye 2 llamadas REST + INSERT + publish).
- En la nube: servicios en la **misma VPC/región**, keep-alive en el gateway, y CDN para estáticos.

### 4.8 Costo y proyección
**Escenario producción en AWS (estimado mensual, ~10 000 pedidos/mes):**

| Componente | Servicio | Costo aprox. |
|---|---|---|
| 2 microservicios (2 réplicas c/u) | ECS Fargate (0.5 vCPU/1 GB) | ~$35–45 |
| Lambdas notificaciones | AWS Lambda + API Gateway | **~$0–2** (capa gratuita cubre <1 M invocaciones) |
| MongoDB | Atlas M10 / DocumentDB | ~$60 |
| PostgreSQL | RDS t4g.micro Multi-AZ | ~$30 |
| Redis | ElastiCache t4g.micro | ~$12 |
| RabbitMQ | Amazon MQ mq.t3.micro | ~$25 |
| ALB + tráfico | ALB | ~$20 |
| **Total** | | **~$180–200/mes** |

**Proyección:** al crecer 10× (100 000 pedidos/mes) solo escalan linealmente Fargate y Lambda (~$300–350/mes); las bases se redimensionan por etapas. El componente serverless es el más eficiente en costo porque **se paga solo por invocación** — ideal para cargas variables como notificaciones.

### 4.9 Performance y escalabilidad
- **Escalado horizontal:** todos los servicios son *stateless* (el estado vive en las capas de datos), por lo que se replican sin cambios de código.
- **Escalado independiente (ventaja clave de microservicios):** si el catálogo recibe 10× más lecturas, se escala solo ese servicio + Redis, sin tocar pedidos.
- **Backpressure natural:** picos de pedidos se absorben en la cola; los workers procesan a su ritmo (nivelación de carga / *queue-based load leveling*).
- **Capacidad estimada local:** ~500–800 req/s en listados cacheados; ~100–150 pedidos/s limitado por PostgreSQL y las llamadas síncronas al catálogo.
- **Cuello de botella identificado y mitigación:** la validación síncrona catálogo↔pedidos; a futuro se reemplazaría por reserva de stock vía eventos (Saga completa con compensaciones).

---

## 5. CI/CD (mantenibilidad y despliegue continuo)

Pipeline en `.github/workflows/ci-cd.yml`:
1. **CI:** en cada push/PR — instala dependencias, valida sintaxis y construye las imágenes Docker de los 4 componentes.
2. **CD:** en push a `main` — publica las imágenes a GitHub Container Registry (GHCR) etiquetadas con el SHA del commit; job de despliegue de las Lambdas con `serverless deploy` (requiere secrets de AWS).
3. Estrategia de ramas: `main` (producción) + ramas `feature/*` con PR obligatorio.

## 6. Monitoreo
- **Health checks** por servicio + endpoint agregado `/health` en el gateway (apto para UptimeRobot/CloudWatch Synthetics).
- **Logs estructurados** por servicio (stdout → `docker compose logs -f`; en producción CloudWatch Logs).
- **RabbitMQ Management UI** (puerto 15672): profundidad de cola, tasa de mensajes, consumidores activos — la métrica clave para detectar atascos del worker.
- Evolución: Prometheus + Grafana con métricas de latencia p95/p99 y alertas sobre profundidad de cola > umbral.

## 7. Documentación adicional
- `docs/c4-icepanel.md` — modelo C4 completo (niveles 1–3) listo para replicar en IcePanel.
- `docs/diagramas.md` — diagramas de arquitectura, secuencia, infraestructura y despliegue (Mermaid).
- `gateway/openapi.yaml` — especificación OpenAPI 3.0 para SwaggerHub.
