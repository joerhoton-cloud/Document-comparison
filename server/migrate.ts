import { getMigrations } from 'better-auth/db/migration';
import { sql } from 'kysely';
import { authOptions } from './auth';
import { db } from './db';

/** Create or update all tables. Safe to run on every start (additive only). */
export async function migrate(): Promise<void> {
  const { runMigrations } = await getMigrations(authOptions);
  await runMigrations();

  await sql`
    CREATE TABLE IF NOT EXISTS comparison (
      id              text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
      created_by      text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      save_level      text NOT NULL CHECK (save_level IN ('activity', 'progress')),
      left_name       text NOT NULL,
      left_sha256     char(64) NOT NULL,
      left_size       bigint NOT NULL,
      left_format     text NOT NULL,
      right_name      text NOT NULL,
      right_sha256    char(64) NOT NULL,
      right_size      bigint NOT NULL,
      right_format    text NOT NULL,
      options         jsonb NOT NULL,
      stats           jsonb NOT NULL
    )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS comparison_org_created ON comparison (organization_id, created_at DESC)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS comparison_org_files ON comparison (organization_id, left_sha256, right_sha256)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS review (
      comparison_id text NOT NULL REFERENCES comparison(id) ON DELETE CASCADE,
      change_key    text NOT NULL,
      status        text NOT NULL CHECK (status IN ('reviewed', 'flagged')),
      note          text,
      updated_by    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      updated_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (comparison_id, change_key)
    )`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS activity (
      id              bigserial PRIMARY KEY,
      organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
      comparison_id   text REFERENCES comparison(id) ON DELETE SET NULL,
      user_id         text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      action          text NOT NULL,
      detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at      timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS activity_org_created ON activity (organization_id, created_at DESC)`.execute(db);
}
