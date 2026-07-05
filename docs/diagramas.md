# Diagramas de la solución MediStock

> Todos los diagramas están en **Mermaid**: se renderizan directo en GitHub, o puedes pegarlos en https://mermaid.live para exportarlos como PNG/SVG e insertarlos en el informe.

---

## 1. Diagrama de Arquitectura (estilo/patrones seleccionados)

```mermaid
flowchart TB
    subgraph Clientes
        U[Cliente / Farmacia]
        A[Administrador]
    end

    subgraph Ecosistema MediStock
        GW["API Gateway<br/>(Express + Swagger UI)<br/>Rate limiting · Health agregado"]

        subgraph App1["App 1: Catálogo (Microservicio)"]
            CAT[catalogo-service<br/>Node.js]
        end
        subgraph App2["App 2: Pedidos (Microservicio)"]
            PED[pedidos-service<br/>Node.js]
        end
        subgraph App3["App 3: Notificaciones (Serverless)"]
            LAM["Lambdas HTTP<br/>listar / obtener / health"]
            WRK["Worker<br/>(consumidor de cola)"]
        end

        MQ[("RabbitMQ<br/>cola: pedidos.eventos")]

        subgraph Datos["Capas de datos (Docker)"]
            MG[("MongoDB<br/>catalogo_db")]
            PG[("PostgreSQL<br/>pedidos_db")]
            RD[("Redis<br/>caché + notificaciones")]
        end
    end

    U -->|REST/HTTPS| GW
    A -->|REST/HTTPS| GW
    GW -->|/api/productos| CAT
    GW -->|/api/pedidos| PED
    GW -->|/api/notificaciones| LAM

    CAT --> MG
    CAT -->|Cache-Aside| RD
    PED --> PG
    PED -->|"REST: validar + descontar stock"| CAT
    PED -->|"publica pedido.creado"| MQ
    MQ -->|consume| WRK
    WRK --> RD
    LAM --> RD
```

---

## 2. Diagrama de Secuencia — Flujo "Crear pedido"

```mermaid
sequenceDiagram
    actor C as Cliente
    participant GW as API Gateway
    participant P as pedidos-service
    participant CA as catalogo-service
    participant MG as MongoDB
    participant PG as PostgreSQL
    participant MQ as RabbitMQ
    participant W as Worker (Lambda app)
    participant R as Redis

    C->>GW: POST /api/pedidos {cliente, productoId, cantidad}
    GW->>P: proxy /pedidos
    P->>CA: GET /productos/:id
    CA->>MG: findById (o caché Redis)
    CA-->>P: producto {precio, stock}
    P->>CA: POST /productos/:id/descontar {cantidad}
    CA->>MG: findOneAndUpdate atómico (stock >= cantidad)
    CA-->>P: 200 OK (o 409 stock insuficiente)
    P->>PG: INSERT INTO pedidos
    P->>MQ: publish "pedido.creado" (persistente)
    P-->>GW: 201 {pedido}
    GW-->>C: 201 {pedido}

    Note over MQ,W: Procesamiento asíncrono
    MQ->>W: consume evento
    W->>R: LPUSH notificaciones + SET notificacion:pedido:id
    W->>MQ: ack
```

---

## 3. Diagrama de Infraestructura (entorno local — Docker Compose)

```mermaid
flowchart TB
    subgraph HOST["Host (máquina local) — Docker Engine"]
        subgraph NET["Red bridge: medistock_default"]
            GW["api-gateway<br/>node:20-alpine<br/>:8080→8080"]
            C1["catalogo-service<br/>node:20-alpine<br/>:3001"]
            C2["pedidos-service<br/>node:20-alpine<br/>:3002"]
            C3["notificaciones-lambda<br/>node:20-alpine<br/>serverless-offline :3003"]
            MQ["rabbitmq:3-management<br/>:5672 / :15672"]
            MG["mongo:7<br/>:27017"]
            PG["postgres:16-alpine<br/>:5432"]
            RD["redis:7-alpine<br/>:6379"]
        end
        V1[/"volumen mongo_data"/]
        V2[/"volumen postgres_data"/]
        V3[/"volumen redis_data"/]
    end
    MG --- V1
    PG --- V2
    RD --- V3
    GW --> C1 & C2 & C3
    C1 --> MG & RD
    C2 --> PG & MQ & C1
    C3 --> MQ & RD
```

---

## 4. Diagrama de Despliegue (proyección a producción en AWS)

```mermaid
flowchart TB
    U[Usuarios] --> CF["CloudFront + WAF"]
    CF --> ALB["Application Load Balancer"]

    subgraph VPC["VPC — región us-east-1"]
        subgraph AZ1["Zona de disponibilidad A"]
            E1["ECS Fargate<br/>catalogo-service (réplica 1)"]
            E3["ECS Fargate<br/>pedidos-service (réplica 1)"]
        end
        subgraph AZ2["Zona de disponibilidad B"]
            E2["ECS Fargate<br/>catalogo-service (réplica 2)"]
            E4["ECS Fargate<br/>pedidos-service (réplica 2)"]
        end

        APIGW["Amazon API Gateway"]
        L1["AWS Lambda<br/>listarNotificaciones"]
        L2["AWS Lambda<br/>obtenerNotificacion"]

        AMQ["Amazon MQ<br/>(RabbitMQ) multi-AZ"]
        DOC[("DocumentDB / Atlas<br/>replica set x3")]
        RDS[("RDS PostgreSQL<br/>Multi-AZ + read replica")]
        EC[("ElastiCache Redis<br/>primario + réplica")]
    end

    ALB --> E1 & E2 & E3 & E4
    CF --> APIGW --> L1 & L2
    E1 & E2 --> DOC
    E1 & E2 --> EC
    E3 & E4 --> RDS
    E3 & E4 --> AMQ
    AMQ --> L1
    L1 & L2 --> EC

    CW["CloudWatch<br/>logs + métricas + alarmas"]
    E1 & E3 & L1 & AMQ -.-> CW
```

---

## 5. Diagrama del pipeline CI/CD

```mermaid
flowchart LR
    DEV[Developer] -->|push / PR| GH[GitHub Repo]
    GH --> CI["GitHub Actions: CI<br/>· npm install<br/>· node --check (lint sintáctico)<br/>· docker build x4"]
    CI -->|solo en main| CD["CD<br/>· push imágenes a GHCR<br/>· serverless deploy (Lambdas)"]
    CD --> REG[(GitHub Container Registry)]
    CD --> AWS["AWS Lambda + API Gateway"]
    REG -->|pull| PROD["Entorno de despliegue<br/>(docker compose / ECS)"]
```
