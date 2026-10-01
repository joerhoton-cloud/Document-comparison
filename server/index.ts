import { serve } from '@hono/node-server';
import { createApp } from './app';
import { env } from './env';
import { checkEmailSetup } from './mailer';
import { migrate } from './migrate';

await migrate();
void checkEmailSetup();
serve({ fetch: createApp().fetch, port: env.port }, (info) => {
  console.log(`${env.appName} listening on http://localhost:${info.port} (public URL ${env.baseUrl})`);
});
