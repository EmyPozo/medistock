// ============================================================
// API GATEWAY — Punto único de entrada del ecosistema MediStock
// Patrones: API Gateway, Proxy, Rate Limiting (Throttling)
// Expone: /api/productos, /api/pedidos, /api/notificaciones
// Documentación: /docs (Swagger UI) · Cliente web: / (dashboard)
// ============================================================
const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 8080;
const CATALOGO_URL = process.env.CATALOGO_URL || 'http://localhost:3001';
const PEDIDOS_URL = process.env.PEDIDOS_URL || 'http://localhost:3002';
const NOTIFICACIONES_URL = process.env.NOTIFICACIONES_URL || 'http://localhost:3003';

const app = express();

// ---------- Rate limiting: protege los servicios internos ----------
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 300, // ampliado: el dashboard hace polling de notificaciones y salud
    standardHeaders: true,
    message: { error: 'Demasiadas solicitudes, intente más tarde' },
  })
);

// ---------- Logging simple (base para MONITOREO) ----------
app.use((req, _res, next) => {
  console.log(`[gateway] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// ---------- Cliente web (dashboard) ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Documentación Swagger ----------
const openapi = YAML.load('./openapi.yaml');
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.get('/openapi.yaml', (_req, res) => res.sendFile(path.join(__dirname, 'openapi.yaml')));

// ---------- Health agregado del ecosistema ----------
app.get('/health', async (_req, res) => {
  const servicios = {
    catalogo: `${CATALOGO_URL}/health`,
    pedidos: `${PEDIDOS_URL}/health`,
    notificaciones: `${NOTIFICACIONES_URL}/dev/health`,
  };
  const estado = {};
  await Promise.all(
    Object.entries(servicios).map(async ([nombre, url]) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        estado[nombre] = r.ok ? 'UP' : 'DEGRADED';
      } catch {
        estado[nombre] = 'DOWN';
      }
    })
  );
  const global = Object.values(estado).every((s) => s === 'UP') ? 'UP' : 'DEGRADED';
  res.json({ gateway: 'UP', global, servicios: estado, ts: new Date().toISOString() });
});

// ---------- Proxies hacia cada aplicación ----------
// http-proxy-middleware v3: pathFilter para reescritura correcta de rutas
app.use(
  createProxyMiddleware({
    pathFilter: '/api/productos',
    target: CATALOGO_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/productos': '/productos' },
  })
);
app.use(
  createProxyMiddleware({
    pathFilter: '/api/pedidos',
    target: PEDIDOS_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/pedidos': '/pedidos' },
  })
);
// serverless-offline publica las rutas bajo el stage /dev
app.use(
  createProxyMiddleware({
    pathFilter: '/api/notificaciones',
    target: NOTIFICACIONES_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/notificaciones': '/dev/notificaciones' },
  })
);

// ---------- Info de la API (la raíz ahora la ocupa el dashboard) ----------
app.get('/info', (_req, res) =>
  res.json({
    nombre: 'MediStock API Gateway',
    cliente_web: '/',
    documentacion: '/docs',
    endpoints: ['/api/productos', '/api/pedidos', '/api/notificaciones', '/health'],
  })
);

app.listen(PORT, () => console.log(`[gateway] Escuchando en puerto ${PORT} — dashboard en / · docs en /docs`));
