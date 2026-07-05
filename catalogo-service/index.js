// ============================================================
// APLICACIÓN 1: Microservicio de Catálogo de Insumos Médicos
// Capa de datos: MongoDB (Docker) | Caché: Redis (Docker)
// Patrones: Repository, Cache-Aside, Database-per-Service
// ============================================================
const express = require('express');
const mongoose = require('mongoose');
const { createClient } = require('redis');

const PORT = process.env.PORT || 3001;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/catalogo_db';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CACHE_TTL = 60; // segundos

const app = express();
app.use(express.json());

// ---------- Modelo (con INDEXACIÓN) ----------
const productoSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, index: true },      // índice simple
    categoria: { type: String, required: true, index: true },   // índice simple
    descripcion: String,
    precio: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true }
);
// Índice compuesto para la consulta más frecuente: buscar por categoría ordenado por precio
productoSchema.index({ categoria: 1, precio: 1 });
const Producto = mongoose.model('Producto', productoSchema);

// ---------- Cliente Redis (patrón Cache-Aside) ----------
let redis;
async function initRedis() {
  redis = createClient({ url: REDIS_URL });
  redis.on('error', (e) => console.error('[redis]', e.message));
  await redis.connect();
  console.log('[catalogo] Conectado a Redis');
}

// ---------- Rutas ----------
app.get('/health', (_req, res) =>
  res.json({ status: 'UP', service: 'catalogo-service', ts: new Date().toISOString() })
);

// Listar productos (con caché)
app.get('/productos', async (req, res) => {
  try {
    const { categoria } = req.query;
    const cacheKey = `productos:${categoria || 'all'}`;

    // 1) Intentar leer de caché
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json({ source: 'cache', data: JSON.parse(cached) });
    }

    // 2) Cache miss -> leer de MongoDB (usa índice categoria+precio)
    const filtro = categoria ? { categoria } : {};
    const productos = await Producto.find(filtro).sort({ precio: 1 }).lean();

    // 3) Guardar en caché con TTL
    await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(productos));
    res.json({ source: 'db', data: productos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener un producto por id (con caché)
app.get('/productos/:id', async (req, res) => {
  try {
    const cacheKey = `producto:${req.params.id}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json({ source: 'cache', data: JSON.parse(cached) });

    const producto = await Producto.findById(req.params.id).lean();
    if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });

    await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(producto));
    res.json({ source: 'db', data: producto });
  } catch (err) {
    res.status(400).json({ error: 'ID inválido' });
  }
});

// Crear producto (invalida caché de listados)
app.post('/productos', async (req, res) => {
  try {
    const producto = await Producto.create(req.body);
    await redis.del(`productos:all`);
    if (producto.categoria) await redis.del(`productos:${producto.categoria}`);
    res.status(201).json({ data: producto });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Descontar stock (lo usa el servicio de pedidos) — control de CONCURRENCIA
// findOneAndUpdate con condición stock >= cantidad es atómico en MongoDB,
// evita condiciones de carrera entre pedidos simultáneos.
app.post('/productos/:id/descontar', async (req, res) => {
  try {
    const cantidad = Number(req.body.cantidad || 0);
    if (cantidad <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

    const producto = await Producto.findOneAndUpdate(
      { _id: req.params.id, stock: { $gte: cantidad } },
      { $inc: { stock: -cantidad } },
      { new: true }
    );
    if (!producto) return res.status(409).json({ error: 'Stock insuficiente' });

    await redis.del(`producto:${req.params.id}`);
    await redis.del('productos:all');
    await redis.del(`productos:${producto.categoria}`);
    res.json({ data: producto });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Arranque ----------
async function main() {
  await mongoose.connect(MONGO_URL);
  console.log('[catalogo] Conectado a MongoDB');
  await initRedis();

  // Datos semilla si la colección está vacía
  if ((await Producto.countDocuments()) === 0) {
    await Producto.insertMany([
      { nombre: 'Guantes de nitrilo (caja x100)', categoria: 'proteccion', precio: 8.5, stock: 200 },
      { nombre: 'Mascarilla KN95', categoria: 'proteccion', precio: 0.75, stock: 1000 },
      { nombre: 'Jeringa 5ml', categoria: 'insumos', precio: 0.2, stock: 5000 },
      { nombre: 'Tensiómetro digital', categoria: 'equipos', precio: 35.0, stock: 40 },
      { nombre: 'Oxímetro de pulso', categoria: 'equipos', precio: 18.9, stock: 60 },
    ]);
    console.log('[catalogo] Datos semilla insertados');
  }

  app.listen(PORT, () => console.log(`[catalogo] Escuchando en puerto ${PORT}`));
}

main().catch((e) => {
  console.error('Error fatal:', e);
  process.exit(1);
});
