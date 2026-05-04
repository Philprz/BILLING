import './env';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { prisma } from '@pa-sap-bridge/database';
import { authRoutes } from './routes/auth';
import { invoiceRoutes } from './routes/invoices';
import { supplierRoutes } from './routes/suppliers';
import { settingRoutes } from './routes/settings';
import { auditRoutes } from './routes/audit';
import { invoiceGeneratorRoutes } from './routes/invoice-generator';
import { mappingRuleRoutes } from './routes/mapping-rules';
import { paChannelRoutes } from './routes/pa-channels';
import { uploadRoutes } from './routes/upload';
import { workerStatusRoutes } from './routes/worker-status';
import { sapRoutes } from './routes/sap';
import { diagnosticsRoutes } from './routes/diagnostics';
import { SAP_IGNORE_SSL } from './config';
import { assertSapPolicyConfig } from './services/sap-policy.service';
import { verifyCsrf } from './middleware/csrf';

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
  assertSapPolicyConfig();

  const app = Fastify({
    logger: {
      level: LOG_LEVEL,
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // ── Sécurité HTTP (CDC §3.3) ────────────────────────────────────────────────
  app.register(helmet, {
    // L'API renvoie du JSON : pas besoin de CSP sur les réponses JSON.
    // La CSP HTML est gérée par nginx devant le frontend.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    dnsPrefetchControl: { allow: false },
    frameguard: { action: 'sameorigin' }, // X-Frame-Options: SAMEORIGIN (iframe viewer même origine)
    hsts:
      process.env.NODE_ENV === 'production'
        ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
        : false, // HSTS uniquement en prod (HTTPS requis)
    ieNoOpen: true,
    noSniff: true, // X-Content-Type-Options: nosniff
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xssFilter: false, // obsolète — désactivé volontairement
  });

  // ── Rate limiting global (CDC §3.3) ─────────────────────────────────────────
  app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_req, ctx) => ({
      success: false,
      error: `Trop de requêtes — réessayez dans ${ctx.after}`,
    }),
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

  app.addHook('preHandler', verifyCsrf);

  // ── OpenAPI (CDC §2) ────────────────────────────────────────────────────────
  app.register(swagger, {
    openapi: {
      info: {
        title: 'PA-SAP Bridge API',
        description: 'API de passerelle entre la Piste d’Audit (PA) et SAP Business One.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'pa_sap_sid' },
        },
      },
      security: [{ cookieAuth: [] }],
    },
  });
  app.register(swaggerUi, { routePrefix: '/api/docs', uiConfig: { deepLinking: true } });

  app.register(authRoutes);
  app.register(invoiceRoutes);
  app.register(supplierRoutes);
  app.register(settingRoutes);
  app.register(auditRoutes);
  app.register(invoiceGeneratorRoutes);
  app.register(mappingRuleRoutes);
  app.register(paChannelRoutes);
  app.register(uploadRoutes);
  app.register(workerStatusRoutes);
  app.register(sapRoutes);
  app.register(diagnosticsRoutes);

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
