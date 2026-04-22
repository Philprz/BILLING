import './env';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { prisma } from '@pa-sap-bridge/database';
import { authRoutes } from './routes/auth';
import { invoiceRoutes } from './routes/invoices';
import { supplierRoutes } from './routes/suppliers';
import { settingRoutes } from './routes/settings';
import { auditRoutes } from './routes/audit';
import { invoiceGeneratorRoutes } from './routes/invoice-generator';
import { SAP_IGNORE_SSL } from './config';

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const COOKIE_SECRET =
  process.env.SESSION_COOKIE_SECRET ?? 'dev-pa-sap-bridge-secret-change-in-production-32chars';

if (process.env.NODE_ENV === 'production' && COOKIE_SECRET.startsWith('dev-')) {
  throw new Error('SESSION_COOKIE_SECRET must be changed from the default value in production');
}

if (SAP_IGNORE_SSL) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: LOG_LEVEL,
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  app.register(cors, {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  app.register(cookie, {
    secret: COOKIE_SECRET,
    hook: 'onRequest',
  });

  app.register(authRoutes);
  app.register(invoiceRoutes);
  app.register(supplierRoutes);
  app.register(settingRoutes);
  app.register(auditRoutes);
  app.register(invoiceGeneratorRoutes);

  app.get('/api/health', async (_req, reply) => {
    let dbStatus: 'ok' | 'error' = 'error';
    let dbLatencyMs: number | null = null;

    try {
      const t0 = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      dbLatencyMs = Date.now() - t0;
      dbStatus = 'ok';
    } catch {
      // dbStatus reste "error"
    }

    const healthy = dbStatus === 'ok';
    return reply.code(healthy ? 200 : 503).send({
      success: healthy,
      data: {
        status: healthy ? 'ok' : 'degraded',
        service: 'pa-sap-bridge-api',
        version: '0.1.0',
        timestamp: new Date().toISOString(),
        checks: {
          database: { status: dbStatus, latencyMs: dbLatencyMs },
        },
      },
    });
  });

  return app;
}
