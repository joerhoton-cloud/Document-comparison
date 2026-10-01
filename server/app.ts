import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { api } from './api';
import { auth } from './auth';
import { publicConfig } from './config';
import { planChangeBlocker } from './plans';
import { env } from './env';

/** Same policy as the static build: the page may only talk to this server. */
const CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' allows WebAssembly only (the in-browser OCR engine); JavaScript eval stays blocked.
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp(staticRoot = join(import.meta.dirname, '..', 'dist')) {
  const app = new Hono();

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: undefined,
      strictTransportSecurity: env.isProd ? 'max-age=63072000; includeSubDomains' : false,
      referrerPolicy: 'no-referrer',
      xFrameOptions: 'DENY',
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'same-origin',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
    }),
  );
  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Robots-Tag', 'noindex, nofollow');
  });

  app.get('/healthz', (c) => c.text('ok\n'));

  // Small JSON bodies only: documents are never sent here.
  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024 }));

  // Switching to a plan with a lower member limit than the workspace currently has is refused.
  app.post('/api/auth/subscription/upgrade', async (c, next) => {
    const body = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as { referenceId?: unknown; plan?: unknown } | null;
    if (body?.referenceId && typeof body.plan === 'string') {
      const reason = await planChangeBlocker(String(body.referenceId), body.plan);
      if (reason) return c.json({ error: 'too_many_members', message: reason }, 409);
    }
    await next();
    return undefined;
  });

  // Better Auth handles its own CSRF/origin checks; Stripe webhooks arrive from Stripe.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // CSRF: every state-changing API request must come from this app's own origin.
  const allowedOrigins = new Set([env.baseUrl, ...env.devOrigins]);
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      if (!origin || !allowedOrigins.has(origin) || (site && site !== 'same-origin' && site !== 'none'))
        return c.json({ error: 'forbidden', message: 'Cross-site request blocked.' }, 403);
    }
    await next();
    return undefined;
  });
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.get('/api/config', async (c) => c.json(await publicConfig()));
  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  // Static single-page app.
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use(
    '*',
    serveStatic({ root: staticRoot }),
  );
  let indexHtml: string | undefined;
  app.get('*', (c) => {
    indexHtml ??= readFileSync(join(staticRoot, 'index.html'), 'utf8');
    c.header('Cache-Control', 'no-cache');
    return c.html(indexHtml);
  });

  return app;
}
