import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getRateLimiter } from '../lib/rateLimit.js';

/**
 * Rate Limiting Plugin
 * 
 * Applies rate limits per API key and per IP address.
 * Adds rate limit headers to all responses.
 */
export const rateLimitPlugin: FastifyPluginAsync = async (fastify) => {
  const rateLimiter = getRateLimiter();

  fastify.addHook('onRequest', async (request: FastifyRequest, reply) => {
    // Skip rate limiting for internal routes
    if (request.url.startsWith('/internal')) {
      return;
    }

    // Skip rate limiting for root route
    if (request.url === '/') {
      return;
    }

    // Get client IP
    const clientIp = request.ip || request.headers['x-forwarded-for'] || 'unknown';
    const ip = Array.isArray(clientIp) ? clientIp[0] : clientIp.split(',')[0].trim();

    // Check IP rate limit
    const ipCheck = rateLimiter.check(ip, 'ip');
    if (!ipCheck.allowed) {
      reply.header('X-RateLimit-Limit', ipCheck.resetAt.getTime().toString());
      reply.header('X-RateLimit-Remaining', '0');
      reply.header('X-RateLimit-Reset', ipCheck.resetAt.toISOString());
      reply.header('Retry-After', ipCheck.retryAfter?.toString() || '60');

      return reply.code(429).send({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
      });
    }

    // Check API key rate limit (if authenticated)
    if (request.apiKey) {
      const { loadConfig } = await import('../lib/config.js');
      const config = loadConfig();
      const path = request.url.split('?')[0];
      const isEventIngest = request.method === 'POST' && path === '/v1/events';
      const customLimit = isEventIngest ? config.rateLimitEventsPerMin : undefined;
      const bucketKey = isEventIngest ? `${request.apiKey.id}:events` : request.apiKey.id;
      const keyCheck = rateLimiter.check(bucketKey, 'apiKey', customLimit);
      if (!keyCheck.allowed) {
        reply.header('X-RateLimit-Limit', keyCheck.resetAt.getTime().toString());
        reply.header('X-RateLimit-Remaining', '0');
        reply.header('X-RateLimit-Reset', keyCheck.resetAt.toISOString());
        reply.header('Retry-After', keyCheck.retryAfter?.toString() || '60');

        return reply.code(429).send({
          error: 'Rate limit exceeded',
          code: 'RATE_LIMITED',
        });
      }

      // Store rate limit info for response headers
      (request as any).rateLimitInfo = keyCheck;
    } else {
      // Store IP rate limit info for response headers
      (request as any).rateLimitInfo = ipCheck;
    }
  });

  fastify.addHook('onSend', async (request: FastifyRequest, reply, payload) => {
    // Add rate limit headers to all responses
    const rateLimitInfo = (request as any).rateLimitInfo;
    if (rateLimitInfo) {
      const { loadConfig } = await import('../lib/config.js');
      const config = loadConfig();
      
      const limit = request.apiKey 
        ? config.rateLimitApiKeyPerMin 
        : config.rateLimitIpPerMin;

      reply.header('X-RateLimit-Limit', limit.toString());
      reply.header('X-RateLimit-Remaining', rateLimitInfo.remaining.toString());
      reply.header('X-RateLimit-Reset', rateLimitInfo.resetAt.toISOString());
    }

    return payload;
  });
};

