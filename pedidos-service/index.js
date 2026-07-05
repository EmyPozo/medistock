// ============================================================
// APLICACIÓN 2: Microservicio de Pedidos
// Capa de datos: PostgreSQL (Docker)
// Mensajería: RabbitMQ (productor de eventos "pedido.creado")
// Patrones: Database-per-Service, Publisher/Subscriber, Saga (coreografía simple)
// ============================================================
const express = require('express');
const { Pool } = require('pg');
const amqp = require('amqplib');
const axios = require('axios');

const PORT = process.env.PORT || 3002;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://medistock:medistock123@localhost:5432/pedidos_db';
const RABBIT_URL = process.env.RABBIT_URL || 'amqp://localhost:5672';
const CATALOGO_URL = process.env.CATALOGO_URL || 'http://localhost:3001';
const QUEUE = 'pedidos.eventos';

const app = express();
app.use(express.json());

// Pool de conexiones = manejo de CONCURRENCIA y reutilización (menor LATENCIA)
const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

let channel; // canal AMQP

// ---------- Inicialización de la base ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      cliente VARCHAR(120) NOT NULL,
      producto_id VARCHAR(64) NOT NULL,
      producto_nombre VARCHAR(200),
      cantidad INTEGER NOT NULL CHECK (cantidad > 0),
      total NUMERIC(10,2) NOT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'CREADO',
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- INDEXACIÓN: acelera consultas por cliente y por estado
    CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos (cliente);
    CREATE INDEX IF NOT EXISTS idx_pedidos_estado  ON pedidos (estado);
    CREATE INDEX IF NOT EXISTS idx_pedidos_fecha   ON pedidos (creado_en DESC);
  `);
  console.log('[pedidos] Tabla e índices listos');
}

// ---------- Conexión a RabbitMQ con reintentos ----------
async function initRabbit(retries = 10) {
  for (let i = 1; i <= retries; i++) {
    try {
      const conn = await amqp.connect(RABBIT_URL);
      channel = await conn.createChannel();
      await channel.assertQueue(QUEUE, { durable: true }); // durable = REDUNDANCIA de mensajes
      console.log('[pedidos] Conectado a RabbitMQ');
      return;
    } catch (e) {
      console.log(`[pedidos] RabbitMQ no disponible (intento ${i}/${retries})...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('No se pudo conectar a RabbitMQ');
}

function publicarEvento(evento) {
  channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify(evento)), {
    persistent: true, // el mensaje sobrevive reinicios del broker
  });
}

// ---------- Rutas ----------
app.get('/health', (_req, res) =>
  res.json({ status: 'UP', service: 'pedidos-service', ts: new Date().toISOString() })
);

// Crear pedido: valida producto en catálogo, descuenta stock, persiste y publica evento
app.post('/pedidos', async (req, res) => {
  const { cliente, productoId, cantidad } = req.body;
  if (!cliente || !productoId || !cantidad) {
    return res.status(400).json({ error: 'cliente, productoId y cantidad son obligatorios' });
  }
  try {
    // 1) Consultar producto al microservicio de catálogo (comunicación síncrona REST)
    const { data: prodRes } = await axios.get(`${CATALOGO_URL}/productos/${productoId}`);
    const producto = prodRes.data;

    // 2) Descontar stock de forma atómica (el catálogo controla la concurrencia)
    await axios.post(`${CATALOGO_URL}/productos/${productoId}/descontar`, { cantidad });

    // 3) Persistir el pedido en PostgreSQL
    const total = (producto.precio * cantidad).toFixed(2);
    const { rows } = await pool.query(
      `INSERT INTO pedidos (cliente, producto_id, producto_nombre, cantidad, total)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [cliente, productoId, producto.nombre, cantidad, total]
    );
    const pedido = rows[0];

    // 4) Publicar evento asíncrono a la cola (lo consume la Lambda de notificaciones)
    publicarEvento({
      tipo: 'pedido.creado',
      pedido: {
        id: pedido.id,
        cliente: pedido.cliente,
        producto: pedido.producto_nombre,
        cantidad: pedido.cantidad,
        total: pedido.total,
      },
      ts: new Date().toISOString(),
    });

    res.status(201).json({ data: pedido });
  } catch (err) {
    if (err.response) {
      // Error propagado desde el catálogo (404 producto, 409 stock insuficiente)
      return res.status(err.response.status).json(err.response.data);
    }
    res.status(500).json({ error: err.message });
  }
});

// Listar pedidos (paginado -> control de LATENCIA en tablas grandes)
app.get('/pedidos', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const offset = Number(req.query.offset || 0);
  const { rows } = await pool.query(
    'SELECT * FROM pedidos ORDER BY creado_en DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  res.json({ data: rows, limit, offset });
});

// Obtener pedido por id
app.get('/pedidos/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ data: rows[0] });
});

// ---------- Arranque ----------
async function main() {
  await initDb();
  await initRabbit();
  app.listen(PORT, () => console.log(`[pedidos] Escuchando en puerto ${PORT}`));
}

main().catch((e) => {
  console.error('Error fatal:', e);
  process.exit(1);
});
