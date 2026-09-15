import { Pool, type QueryResultRow } from "pg";
import { importSept2026 } from "./seed-sept2026";

// One pool per warm serverless instance. Neon's pooled connection string
// (the "-pooler" host) is recommended for DATABASE_URL on Vercel.
declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __schemaReady: Promise<void> | undefined;
}

/** Find the Postgres connection string under any name the Neon/Vercel integration might use. */
export function databaseUrl(): string {
  const env = process.env;
  const preferred = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "NEON_DATABASE_URL"];
  for (const k of preferred) if (env[k]) return env[k]!;
  // Prefixed variants, e.g. NEON_DATABASE_URL_POOLED, STORAGE_POSTGRES_URL
  const candidates = Object.keys(env).filter((k) => /(DATABASE|POSTGRES)_URL/.test(k) && /^postgres(ql)?:\/\//.test(env[k] ?? ""));
  if (candidates.length) return env[candidates.sort()[0]]!;
  const seen = Object.keys(env).filter((k) => /(PG|POSTGRES|DATABASE|NEON)/i.test(k)).sort();
  throw new Error(
    `no database connection string found. Looked for DATABASE_URL or POSTGRES_URL. ` +
    (seen.length ? `Database-looking variables present: ${seen.join(", ")}.` : `No database-related environment variables are present at all: check that the Neon store is connected to this project for the Production environment, and that the project was redeployed afterwards.`),
  );
}

function getPool(): Pool {
  if (!global.__pgPool) {
    const url = databaseUrl();
    global.__pgPool = new Pool({
      connectionString: url,
      max: 3,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true },
    });
  }
  return global.__pgPool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  is_admin    BOOLEAN NOT NULL DEFAULT FALSE,
  is_voting   BOOLEAN NOT NULL DEFAULT TRUE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS motions (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  moved_by     TEXT NOT NULL DEFAULT '',
  seconded_by  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closes_at    TIMESTAMPTZ,
  closed_at    TIMESTAMPTZ,
  created_by   INTEGER REFERENCES members(id)
);
CREATE TABLE IF NOT EXISTS votes (
  motion_id  INTEGER NOT NULL REFERENCES motions(id) ON DELETE CASCADE,
  member_id  INTEGER NOT NULL REFERENCES members(id),
  choice     TEXT NOT NULL CHECK (choice IN ('aye','nay','abstain')),
  cast_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (motion_id, member_id)
);
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT ''
);
-- v2: draft -> moved -> open -> closed life cycle, with real mover/seconder identities.
ALTER TABLE motions ADD COLUMN IF NOT EXISTS drafted_by    INTEGER REFERENCES members(id);
ALTER TABLE motions ADD COLUMN IF NOT EXISTS moved_by_id   INTEGER REFERENCES members(id);
ALTER TABLE motions ADD COLUMN IF NOT EXISTS seconded_by_id INTEGER REFERENCES members(id);
ALTER TABLE motions ADD COLUMN IF NOT EXISTS drafted_at    TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE motions ADD COLUMN IF NOT EXISTS moved_at      TIMESTAMPTZ;
ALTER TABLE motions ADD COLUMN IF NOT EXISTS seconded_at   TIMESTAMPTZ;
ALTER TABLE motions ADD COLUMN IF NOT EXISTS amended       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE motions ADD COLUMN IF NOT EXISTS draft_note    TEXT NOT NULL DEFAULT '';
ALTER TABLE motions ALTER COLUMN opened_at DROP NOT NULL;
ALTER TABLE motions ALTER COLUMN opened_at DROP DEFAULT;
ALTER TABLE motions ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE motions DROP CONSTRAINT IF EXISTS motions_status_check;
ALTER TABLE motions ADD CONSTRAINT motions_status_check CHECK (status IN ('draft','moved','open','closed','withdrawn'));
ALTER TABLE votes ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','email'));
`;

/**
 * Initial roster, applied only when the members table is empty. It comes from the BOARD_ROSTER
 * environment variable (JSON) so that no personal email addresses live in this repository:
 *   [{"key":"chris","email":"...","name":"Chris Friedel (ED)","admin":true,"voting":false}, ...]
 * "key" is a short stable handle used by one-time imports; it never changes even if the email does.
 */
export type RosterEntry = { key: string; email: string; name: string; admin?: boolean; voting?: boolean };
export function boardRoster(): RosterEntry[] {
  const raw = process.env.BOARD_ROSTER;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r) => r && r.email && r.name) : [];
  } catch {
    console.error("BOARD_ROSTER is not valid JSON; ignoring it");
    return [];
  }
}

export async function ensureSchema(): Promise<void> {
  if (!global.__schemaReady) {
    global.__schemaReady = (async () => {
      const pool = getPool();
      await pool.query(SCHEMA);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM members");
      if (rows[0].n === 0) {
        for (const r of boardRoster()) {
          await pool.query(
            "INSERT INTO members (email, name, is_admin, is_voting) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [r.email.trim().toLowerCase(), r.name, !!r.admin, r.voting !== false],
          );
        }
      }
      // Anyone listed in ADMIN_EMAILS is always an admin.
      const admins = (process.env.ADMIN_EMAILS ?? "")
        .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (admins.length) {
        await pool.query("UPDATE members SET is_admin = TRUE WHERE lower(email) = ANY($1)", [admins]);
      }
      // One-time import of the September 2026 email-thread motions (no-op after the first run).
      await importSept2026(pool, boardRoster());
    })().catch((e) => { global.__schemaReady = undefined; throw e; });
  }
  return global.__schemaReady;
}

export async function q<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  await ensureSchema();
  const { rows } = await getPool().query<T>(text, params);
  return rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function audit(actor: string, action: string, detail = "") {
  await q("INSERT INTO audit_log (actor, action, detail) VALUES ($1,$2,$3)", [actor, action, detail]);
}

export type Member = {
  id: number; email: string; name: string; is_admin: boolean; is_voting: boolean; active: boolean;
};
export type MotionStatus = "draft" | "moved" | "open" | "closed" | "withdrawn";
export type Motion = {
  id: number; title: string; body: string; draft_note: string;
  moved_by: string; seconded_by: string;               // display names, frozen at the time of the action
  drafted_by: number | null; moved_by_id: number | null; seconded_by_id: number | null;
  status: MotionStatus; amended: boolean;
  drafted_at: Date; moved_at: Date | null; seconded_at: Date | null;
  opened_at: Date | null; closes_at: Date | null; closed_at: Date | null;
  created_by: number | null;
};
export type Vote = { motion_id: number; member_id: number; choice: "aye" | "nay" | "abstain"; cast_at: Date; source: "app" | "email" };
