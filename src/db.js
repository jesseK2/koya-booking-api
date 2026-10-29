import { mkdir, readFile } from 'node:fs/promises';

const SCHEMA_URL = new URL('./schema.sql', import.meta.url);

let driverPromise;

async function createDriver() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
      max: 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    return {
      kind: 'postgres',
      query: (sql, params) => pool.query(sql, params),
      exec: (sql) => pool.query(sql),
      close: () => pool.end(),
    };
  }

  // Local development / tests: an in-process Postgres (PGlite) so the SQL ran
  // locally is the same dialect that runs against the hosted Postgres.
  const specifier = '@electric-sql/pglite';
  const { PGlite } = await import(specifier);
  const dir = process.env.PGLITE_DIR || '.data/pg';
  await mkdir(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

function driver() {
  driverPromise ??= createDriver();
  return driverPromise;
}

let schemaPromise;

export async function query(text, params = []) {
  const d = await driver();
  schemaPromise ??= d.exec(await readFile(SCHEMA_URL, 'utf8'));
  await schemaPromise;
  return d.query(text, params);
}

export async function closeDb() {
  if (!driverPromise) return;
  const d = await driverPromise;
  await d.close();
}

export async function resetSchema() {
  await query(`
    TRUNCATE TABLE bookings, idempotency, rate_events, slots RESTART IDENTITY;
  `);
}
