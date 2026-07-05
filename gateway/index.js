// ============================================================
// API GATEWAY — Punto único de entrada del ecosistema MediStock
// Patrones: API Gateway, Proxy, Rate Limiting (Throttling)
// Expone: /api/productos, /api/pedidos, /api/notificaciones
// Documentación: /docs (Swagger UI con openapi.yaml)
// ============================================================
const express = require('express');
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
    max: 100, // 100 req/min por IP
    standardHeaders: true,
    message: { error: 'Demasiadas solicitudes, intente más tarde' },
  })
);

// ---------- Logging simple (base para MONITOREO) ----------
app.use((req, _res, next) => {
  console.log(`[gateway] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// ---------- Documentación Swagger ----------
const openapi = YAML.load('./openapi.yaml');
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.get('/openapi.yaml', (_req, res) => res.sendFile(__dirname + '/openapi.yaml'));

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
app.use(
  '/api/productos',
  createProxyMiddleware({ target: CATALOGO_URL, changeOrigin: true, pathRewrite: { '^/api/productos': '/productos' } })
);
app.use(
  '/api/pedidos',
  createProxyMiddleware({ target: PEDIDOS_URL, changeOrigin: true, pathRewrite: { '^/api/pedidos': '/pedidos' } })
);
// serverless-offline publica las rutas bajo el stage /dev
app.use(
  '/api/notificaciones',
  createProxyMiddleware({
    target: NOTIFICACIONES_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/notificaciones': '/dev/notificaciones' },
  })
);

app.get('/', (_req, res) =>
  res.json({
    nombre: 'MediStock API Gateway',
    documentacion: '/docs',
    endpoints: ['/api/productos', '/api/pedidos', '/api/notificaciones', '/health'],
  })
);

app.listen(PORT, () => console.log(`[gateway] Escuchando en puerto ${PORT} — docs en /docs`));
