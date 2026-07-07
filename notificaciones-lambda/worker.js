// ============================================================
// Worker: CONSUMIDOR del gestor de colas (RabbitMQ)
// Patrones de comportamiento (GoF / refactoring.guru):
//   - OBSERVER: este worker es el "suscriptor" del evento pedido.creado
//     que publica pedidos-service (el "sujeto"). RabbitMQ implementa el
//     mecanismo de suscripción de forma distribuida.
//   - COMMAND: cada mensaje de la cola es una solicitud convertida en un
//     objeto independiente, encolada para su ejecución posterior.
//   - STRATEGY: el envío de la notificación se delega a una familia de
//     algoritmos intercambiables (canales Email / SMS), seleccionables
//     en tiempo de ejecución sin modificar el worker.
// ============================================================
const amqp = require('amqplib');
const { createClient } = require('redis');

const RABBIT_URL = process.env.RABBIT_URL || 'amqp://localhost:5672';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE = 'pedidos.eventos';

// ---------------- PATRÓN STRATEGY ----------------
// Interfaz común: toda estrategia implementa enviar(pedido) y devuelve
// la notificación generada. Cada algoritmo vive en su propia clase.
class CanalNotificacion {
  enviar(_pedido) {
    throw new Error('Método enviar() no implementado');
  }
}

// Estrategia concreta 1: correo electrónico
class CanalEmail extends CanalNotificacion {
  enviar(pedido) {
    return {
      canal: 'email',
      destinatario: pedido.cliente,
      mensaje: `Hola ${pedido.cliente}, tu pedido #${pedido.id} de ${pedido.cantidad} x "${pedido.producto}" por $${pedido.total} fue registrado con éxito. Recibirás actualizaciones en tu correo.`,
    };
  }
}

// Estrategia concreta 2: SMS (mensaje corto)
class CanalSMS extends CanalNotificacion {
  enviar(pedido) {
    return {
      canal: 'sms',
      destinatario: pedido.cliente,
      mensaje: `MediStock: pedido #${pedido.id} confirmado. Total $${pedido.total}.`,
    };
  }
}

// Contexto: usa una estrategia sin conocer su implementación.
// La estrategia es intercambiable en tiempo de ejecución (setEstrategia).
class Notificador {
  constructor(estrategia) {
    this.estrategia = estrategia;
  }
  setEstrategia(estrategia) {
    this.estrategia = estrategia;
  }
  notificar(pedido) {
    return this.estrategia.enviar(pedido);
  }
}

// Regla de negocio para elegir estrategia: pedidos de alto valor se
// notifican por SMS (más inmediato); el resto, por email.
function elegirEstrategia(pedido) {
  return Number(pedido.total) >= 50 ? new CanalSMS() : new CanalEmail();
}
// --------------------------------------------------

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

  channel.prefetch(1);
  console.log(`[worker] Consumiendo cola "${QUEUE}"`);

  const notificador = new Notificador(new CanalEmail());

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const evento = JSON.parse(msg.content.toString());
      console.log('[worker] Evento recibido:', evento.tipo);

      if (evento.tipo === 'pedido.creado') {
        // STRATEGY en acción: se selecciona el algoritmo de envío
        // según el pedido, sin tocar la lógica del worker.
        notificador.setEstrategia(elegirEstrategia(evento.pedido));
        const envio = notificador.notificar(evento.pedido);

        const notificacion = {
          id: `NOTIF-${evento.pedido.id}`,
          pedidoId: evento.pedido.id,
          ...envio,
          enviadoEn: new Date().toISOString(),
        };

        await redis.lPush('notificaciones', JSON.stringify(notificacion));
        await redis.lTrim('notificaciones', 0, 199);
        await redis.set(`notificacion:pedido:${evento.pedido.id}`, JSON.stringify(notificacion));

        console.log(`[worker] Notificación generada: ${notificacion.id} vía ${notificacion.canal}`);
      }

      if (evento.tipo === 'pedido.estado_cambiado') {
        // Los cambios de estado (patrón State en pedidos-service) también
        // generan notificación, siempre por email.
        notificador.setEstrategia(new CanalEmail());
        const notificacion = {
          id: `NOTIF-${evento.pedido.id}-${evento.pedido.estado}`,
          pedidoId: evento.pedido.id,
          canal: 'email',
          destinatario: evento.pedido.cliente,
          mensaje: `Hola ${evento.pedido.cliente}, tu pedido #${evento.pedido.id} cambió de estado: ${evento.pedido.estadoAnterior} → ${evento.pedido.estado}.`,
          enviadoEn: new Date().toISOString(),
        };
        await redis.lPush('notificaciones', JSON.stringify(notificacion));
        await redis.lTrim('notificaciones', 0, 199);
        console.log(`[worker] Notificación de cambio de estado: ${notificacion.id}`);
      }

      channel.ack(msg);
    } catch (e) {
      console.error('[worker] Error procesando mensaje:', e.message);
      channel.nack(msg, false, false);
    }
  });
}

main().catch((e) => {
  console.error('Error fatal del worker:', e);
  process.exit(1);
});
