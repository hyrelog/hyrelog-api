/**
 * Request logging plugin
 *
 * Writes every request and response to stderr so traffic is always visible
 * in the terminal, regardless of log level or pino buffering.
 */

import { FastifyPluginAsync } from 'fastify';

function now(): string {
  return new Date().toISOString();
}

export const requestLogPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', (request, _reply, done) => {
    const url = request.url.split('?')[0];
    (request as any).__requestLogStart = Date.now();
    process.stderr.write(`[API] ${now()} -> ${request.method} ${url}\n`);
    done();
  });

  fastify.addHook('onResponse', (request, reply, _payload, done) => {
    const url = request.url.split('?')[0];
    const elapsed = (request as any).__requestLogStart != null
      ? Date.now() - (request as any).__requestLogStart
      : 0;
    process.stderr.write(
      `[API] ${now()} <- ${reply.statusCode} ${request.method} ${url} ${elapsed}ms\n`
    );
    done();
  });
};
