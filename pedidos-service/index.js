// ============================================================
// APLICACIÓN 2: Microservicio de Pedidos
// Capa de datos: PostgreSQL (Docker)
// Mensajería: RabbitMQ (productor de eventos - patrón OBSERVER/COMMAND)
// Patrones de comportamiento (GoF / refactoring.guru):
//   - STATE: el pedido altera su comportamiento según su estado interno.
//     Cada estado es una clase que define qué transiciones permite
//     (CREADO -> CONFIRMADO -> ENVIADO -> ENTREGADO, con CANCELADO).
//   - OBSERVER: publica eventos a RabbitMQ; los suscriptores (worker de
//     notificaciones) reaccionan sin acoplamiento directo.
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

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
let channel;

// ---------------- PATRÓN STATE ----------------
// Clase base: define la interfaz de acciones. Por defecto toda acción
// es inválida; cada estado concreto habilita solo sus transiciones.
class EstadoPedido {
  constructor(nombre) {
    this.nombre = nombre;
  }
  confirmar() { this._invalida('confirmar'); }
  enviar() { this._invalida('enviar'); }
  entregar() { this._invalida('entregar'); }
  cancelar() { this._invalida('cancelar'); }
  _invalida(accion) {
    const err = new Error(`Acción "${accion}" no permitida en estado ${this.nombre}`);
    err.status = 409;
    throw err;
  }
}

class EstadoCreado extends EstadoPedido {
  constructor() { super('CREADO'); }
  confirmar() { return 'CONFIRMADO'; }
  cancelar() { return 'CANCELADO'; }
}

class EstadoConfirmado extends EstadoPedido {
  constructor() { super('CONFIRMADO'); }
  enviar() { return 'ENVIADO'; }
  cancelar() { return 'CANCELADO'; }
}

class EstadoEnviado extends EstadoPedido {
  constructor() { super('ENVIADO'); }
  entregar() { return 'ENTREGADO'; }
}

class EstadoEntregado extends EstadoPedido {
  constructor() { super('ENTREGADO'); } // estado final: ninguna acción permitida
}

class EstadoCancelado extends EstadoPedido {
  constructor() { super('CANCELADO'); } // estado final
}

const ESTADOS = {
  CREADO: EstadoCreado,
  CONFIRMADO: EstadoConfirmado,
  ENVIADO: EstadoEnviado,
  ENTREGADO: EstadoEntregado,
  CANCELADO: EstadoCancelado,
};

const ACCIONES = ['confirmar', 'enviar', 'entregar', 'cancelar'];
// ------------------------------------------------

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
    CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos (cliente);
    CREATE INDEX IF NOT EXISTS idx_pedidos_estado  ON pedidos (estado);
    CREATE INDEX IF NOT EXISTS idx_pedidos_fecha   ON pedidos (creado_en DESC);
  `);
  console.log('[pedidos] Tabla e índices listos');
}

async function initRabbit(retries = 10) {
  for (let i = 1; i <= retries; i++) {
    try {
      const conn = await amqp.connect(RABBIT_URL);
      channel = await conn.createChannel();
      await channel.assertQueue(QUEUE, { durable: true });
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
  channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify(evento)), { persistent: true });
}

// ---------- Rutas ----------
app.get('/health', (_req, res) =>
  res.json({ status: 'UP', service: 'pedidos-service', ts: new Date().toISOString() })
);

app.post('/pedidos', async (req, res) => {
  const { cliente, productoId, cantidad } = req.body;
  if (!cliente || !productoId || !cantidad) {
    return res.status(400).json({ error: 'cliente, productoId y cantidad son obligatorios' });
  }
  try {
    const { data: prodRes } = await axios.get(`${CATALOGO_URL}/productos/${productoId}`);
    const producto = prodRes.data;

    await axios.post(`${CATALOGO_URL}/productos/${productoId}/descontar`, { cantidad });

    const total = (producto.precio * cantidad).toFixed(2);
    const { rows } = await pool.query(
      `INSERT INTO pedidos (cliente, producto_id, producto_nombre, cantidad, total)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [cliente, productoId, producto.nombre, cantidad, total]
    );
    const pedido = rows[0];

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
      return res.status(err.response.status).json(err.response.data);
    }
    res.status(500).json({ error: err.message });
  }
});

// PATRÓN STATE en acción: cambiar el estado de un pedido mediante una acción.
// El estado actual (objeto) decide si la acción es válida; el servicio no
// tiene condicionales dispersos sobre estados.
// PATCH /pedidos/:id/estado  body: { "accion": "confirmar" | "enviar" | "entregar" | "cancelar" }
app.patch('/pedidos/:id/estado', async (req, res) => {
  const { accion } = req.body;
  if (!ACCIONES.includes(accion)) {
    return res.status(400).json({ error: `Acción inválida. Use una de: ${ACCIONES.join(', ')}` });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    const pedido = rows[0];

    const ClaseEstado = ESTADOS[pedido.estado];
    if (!ClaseEstado) return res.status(500).json({ error: `Estado desconocido: ${pedido.estado}` });

    const estadoActual = new ClaseEstado();
    const nuevoEstado = estadoActual[accion](); // lanza 409 si la transición no está permitida

    const { rows: updated } = await pool.query(
      'UPDATE pedidos SET estado = $1 WHERE id = $2 RETURNING *',
      [nuevoEstado, pedido.id]
    );

    // OBSERVER: se notifica el cambio de estado a los suscriptores
    publicarEvento({
      tipo: 'pedido.estado_cambiado',
      pedido: {
        id: pedido.id,
        cliente: pedido.cliente,
        estadoAnterior: pedido.estado,
        estado: nuevoEstado,
      },
      ts: new Date().toISOString(),
    });

    res.json({ data: updated[0], transicion: `${pedido.estado} -> ${nuevoEstado}` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/pedidos', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const offset = Number(req.query.offset || 0);
  const { rows } = await pool.query(
    'SELECT * FROM pedidos ORDER BY creado_en DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  res.json({ data: rows, limit, offset });
});

app.get('/pedidos/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ data: rows[0] });
});

async function main() {
  await initDb();
  await initRabbit();
  app.listen(PORT, () => console.log(`[pedidos] Escuchando en puerto ${PORT}`));
}

main().catch((e) => {
  console.error('Error fatal:', e);
  process.exit(1);
});
