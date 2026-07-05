// ============================================================
// Handlers de funciones serverless (Lambdas)
// Las notificaciones se almacenan en Redis (capa de datos ligera),
// alimentadas por el worker que consume la cola RabbitMQ.
// ============================================================
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
let redis;

async function getRedis() {
  if (!redis || !redis.isOpen) {
    redis = createClient({ url: REDIS_URL });
    await redis.connect();
  }
  return redis;
}

const respuesta = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

// GET /notificaciones — lista todas las notificaciones generadas
module.exports.listarNotificaciones = async () => {
  try {
    const r = await getRedis();
    const raw = await r.lRange('notificaciones', 0, 49); // últimas 50
    const data = raw.map((x) => JSON.parse(x));
    return respuesta(200, { total: data.length, data });
  } catch (e) {
    return respuesta(500, { error: e.message });
  }
};

// GET /notificaciones/{id} — obtiene una notificación por id de pedido
module.exports.obtenerNotificacion = async (event) => {
  try {
    const id = event.pathParameters && event.pathParameters.id;
    const r = await getRedis();
    const raw = await r.get(`notificacion:pedido:${id}`);
    if (!raw) return respuesta(404, { error: 'Notificación no encontrada' });
    return respuesta(200, { data: JSON.parse(raw) });
  } catch (e) {
    return respuesta(500, { error: e.message });
  }
};

// GET /health
module.exports.health = async () =>
  respuesta(200, { status: 'UP', service: 'notificaciones-lambda', ts: new Date().toISOString() });
