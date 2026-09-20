import express from 'express';
import cors from 'cors';
import { SignalingServer } from './signaling.js';
import { createApiRouter } from './api.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HTTP_PORT = parseInt(process.env.PORT    ?? '4000', 10);
const WS_PORT   = parseInt(process.env.WS_PORT ?? '4001', 10);

// ---------------------------------------------------------------------------
// WebSocket signaling server (port 4001)
// ---------------------------------------------------------------------------

const signaling = new SignalingServer(WS_PORT);

// ---------------------------------------------------------------------------
// Express HTTP server (port 4000)
// ---------------------------------------------------------------------------

const app = express();

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN ?? '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
app.use(express.json({ limit: '1mb' }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

// API routes
app.use('/api', createApiRouter(signaling));

// Health check (outside /api so load balancers can ping it without auth)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    devicesOnline: signaling.onlineCount(),
    uptime: process.uptime(),
  });
});

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[http] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(HTTP_PORT, () => {
  console.log(`[http] REST API listening on port ${HTTP_PORT}`);
  console.log(`[http] Health: http://localhost:${HTTP_PORT}/health`);
  console.log(`[http] API base: http://localhost:${HTTP_PORT}/api`);
});
