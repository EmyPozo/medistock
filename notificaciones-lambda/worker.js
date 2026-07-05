// ============================================================
// Worker: CONSUMIDOR del gestor de colas (RabbitMQ)
// Escucha la cola "pedidos.eventos" y genera notificaciones
// (simula envío de email/SMS y las persiste en Redis).
// Patrón: Competing Consumers / Publisher-Subscriber
// ============================================================
const amqp = require('amqplib');
const { createClient } = require('redis');

const RABBIT_URL = process.env.RABBIT_URL || 'amqp://localhost:5672';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE = 'pedidos.eventos';

async function main() {
  const redis = createClient({ url: REDIS_URL });
  await redis.connect();
  console.log('[worker] Conectado a Redis');

  // Reintentos de conexión a RabbitMQ
  let channel;
  for (let i = 1; i <= 15; i++) {
    try {
      const conn = await amqp.connect(RABBIT_URL);
      channel = await conn.createChannel();
      await channel.assertQueue(QUEUE, { durable: true });
      break;
    } catch (e) {
      console.log(`[worker] Esperando RabbitMQ (${i}/15)...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!channel) throw new Error('No se pudo conectar a RabbitMQ');

  // prefetch(1): procesa un mensaje a la vez -> permite escalar horizontalmente
  // agregando más workers (Competing Consumers) sin duplicar trabajo.
  channel.prefetch(1);
  console.log(`[worker] Consumiendo cola "${QUEUE}"`);

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const evento = JSON.parse(msg.content.toString());
      console.log('[worker] Evento recibido:', evento.tipo);

      if (evento.tipo === 'pedido.creado') {
        const notificacion = {
          id: `NOTIF-${evento.pedido.id}`,
          pedidoId: evento.pedido.id,
          canal: 'email',
          destinatario: evento.pedido.cliente,
          mensaje: `Hola ${evento.pedido.cliente}, tu pedido #${evento.pedido.id} de ${evento.pedido.cantidad} x "${evento.pedido.producto}" por $${evento.pedido.total} fue registrado con éxito.`,
          enviadoEn: new Date().toISOString(),
        };

        // Persistencia en Redis (lista para el feed + clave individual)
        await redis.lPush('notificaciones', JSON.stringify(notificacion));
        await redis.lTrim('notificaciones', 0, 199);
        await redis.set(`notificacion:pedido:${evento.pedido.id}`, JSON.stringify(notificacion));

        console.log('[worker] Notificación generada:', notificacion.id);
      }

      channel.ack(msg); // confirma el procesamiento (at-least-once delivery)
    } catch (e) {
      console.error('[worker] Error procesando mensaje:', e.message);
      channel.nack(msg, false, false); // descarta mensajes corruptos (podría ir a una DLQ)
    }
  });
}

main().catch((e) => {
  console.error('Error fatal del worker:', e);
  process.exit(1);
});
