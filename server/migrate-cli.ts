// `npm run migrate`: create or update tables without starting the server.
import { db } from './db';
import { migrate } from './migrate';

try {
  await migrate();
  console.log('Database is up to date.');
} finally {
  await db.destroy();
}
