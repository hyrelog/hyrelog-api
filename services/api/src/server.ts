import Fastify from 'fastify';
import { loadConfig } from './lib/config.js';
import { getLogger } from './lib/logger.js';
import { getTraceId } from './lib/trace.js';
import { errorHandlerPlugin } from './plugins/errorHandler.js';
import { requestLogPlugin } from './plugins/requestLog.js';
import { internalAuthPlugin } from './plugins/internalAuth.js';
import { rateLimitPlugin } from './plugins/rateLimit.js';
import { setupAuthHook } from './plugins/auth.js';
import { dashboardAuthPlugin } from './plugins/dashboardAuth.js';
import fp from 'fastify-plugin';
import { openapiPlugin } from './plugins/openapi.js';
import { healthRoutes } from './routes/internal/health.js';
import { metricsRoutes } from './routes/internal/metrics.js';
import { v1Routes } from './routes/v1/index.js';
import { dashboardRoutes } from './routes/dashboard/index.js';

async function buildServer() {
  const logger = getLogger();

  const server = Fastify({
    logger: logger.child({ service: 'hyrelog-api' }),
    requestIdLogLabel: 'traceId',
    genReqId: (request) => getTraceId(request),
  });

  // Add trace ID to all responses
  server.addHook('onSend', async (request, reply, payload) => {
    const traceId = getTraceId(request);
    reply.header('X-Trace-Id', traceId);
    return payload;
  });

  // Register plugins – request log first so every request is visible in terminal
  await server.register(requestLogPlugin);
  await server.register(errorHandlerPlugin);
  await server.register(internalAuthPlugin);
  
  // Setup auth hook directly on server (before routes)
  setupAuthHook(server);
  
  // Note: rateLimitPlugin should run AFTER auth so it can access request.apiKey
  await server.register(rateLimitPlugin);

  // OpenAPI + CORS. Wrap with fastify-plugin so swagger's onRoute runs on root and sees v1 routes.
  await server.register(fp(openapiPlugin));

  // Register routes
  await server.register(healthRoutes, { prefix: '/internal' });
  await server.register(metricsRoutes, { prefix: '/internal' });
  // v1 routes registered without prefix so @fastify/swagger discovers them; paths use /v1/... inside route files
  await server.register(v1Routes);
  // Dashboard: apply auth hook directly on the prefixed instance, then register routes
  // beneath that same instance. Registering the auth plugin as a sibling child plugin
  // would encapsulate the hook away from the dashboard routes.
  await server.register(
    async (dashboardApp) => {
      await dashboardAuthPlugin(dashboardApp, {});
      await dashboardApp.register(dashboardRoutes);
    },
    { prefix: '/dashboard' }
  );

  // Root route
  server.get('/', async (request, reply) => {
    return reply.send({
      service: 'hyrelog-api',
      version: '0.1.0',
      status: 'running',
    });
  });

  return server;
}

async function start() {
  const config = loadConfig();
  const logger = getLogger();

  try {
    const server = await buildServer();

    await server.listen({
      port: config.port,
      host: '0.0.0.0',
    });

    logger.info(
      {
        port: config.port,
        nodeEnv: config.nodeEnv,
      },
      'HyreLog API server started'
    );
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

// Start server if this file is run directly
// Check if this module is the main module
const isMainModule =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.includes('server.ts') ||
  process.argv[1]?.includes('server.js');

if (isMainModule) {
  start();
}

export { buildServer, start };
