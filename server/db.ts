import { Kysely, PostgresDialect, type Generated, type ColumnType } from 'kysely';
import pg from 'pg';
import { env } from './env';

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/** App tables. Auth tables (user, session, organization, member, …) are owned by Better Auth. */
export interface Database {
  comparison: {
    id: string;
    organization_id: string;
    created_by: string;
    created_at: Timestamp;
    updated_at: Timestamp;
    save_level: 'activity' | 'progress';
    left_name: string;
    left_sha256: string;
    left_size: number;
    left_format: string;
    right_name: string;
    right_sha256: string;
    right_size: number;
    right_format: string;
    options: unknown;
    stats: unknown;
  };
  review: {
    comparison_id: string;
    change_key: string;
    status: 'reviewed' | 'flagged';
    note: string | null;
    updated_by: string;
    updated_at: Timestamp;
  };
  activity: {
    id: Generated<number>;
    organization_id: string;
    comparison_id: string | null;
    user_id: string;
    action: string;
    detail: unknown;
    created_at: Timestamp;
  };
  // Minimal views of Better Auth tables used in joins.
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; slug: string };
  member: { id: string; organizationId: string; userId: string; role: string };
  subscription: { id: string; referenceId: string; stripeSubscriptionId: string | null; status: string | null; plan: string; seats: number | null; periodEnd: Date | null; trialEnd: Date | null; cancelAtPeriodEnd: boolean | null };
}

export const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
