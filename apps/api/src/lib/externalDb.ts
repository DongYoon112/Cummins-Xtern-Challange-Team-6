import Database from "better-sqlite3";

type QueryParams = {
  connectionString: string;
  query: string;
  params?: unknown[];
  maxRows?: number;
  allowWrite?: boolean;
};

type QueryResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  engine: "postgres" | "sqlite";
};

const postgresPoolByConn = new Map<string, any>();

function isReadOnlyQuery(query: string) {
  const normalized = query.trim().toLowerCase();
  return normalized.startsWith("select") || normalized.startsWith("with") || normalized.startsWith("pragma");
}

function hasLikelyWriteKeyword(query: string) {
  const normalized = query.trim().toLowerCase();
  return /(^|\s)(insert|update|delete|create|alter|drop|truncate|replace)(\s|$)/.test(normalized);
}

function resolveEngine(connectionString: string): "postgres" | "sqlite" {
  const normalized = connectionString.trim().toLowerCase();
  if (normalized.startsWith("postgres://") || normalized.startsWith("postgresql://")) {
    return "postgres";
  }
  return "sqlite";
}

async function getPostgresPool(connectionString: string) {
  const existing = postgresPoolByConn.get(connectionString);
  if (existing) {
    return existing;
  }

  const moduleName = "pg";
  const pg = (await import(moduleName)) as { Pool: new (args: Record<string, unknown>) => any };
  const pool = new pg.Pool({
    connectionString,
    max: 5
  });
  postgresPoolByConn.set(connectionString, pool);
  return pool;
}

export async function executeExternalQuery(input: QueryParams): Promise<QueryResult> {
  const { connectionString, query, params = [], maxRows = 200, allowWrite = false } = input;
  if (!connectionString.trim()) {
    throw new Error("Missing database connection string.");
  }
  if (!query.trim()) {
    throw new Error("Missing SQL query.");
  }
  if (!allowWrite && !isReadOnlyQuery(query)) {
    throw new Error("Only read-only SQL is allowed. Use SELECT or WITH.");
  }
  if (allowWrite && !hasLikelyWriteKeyword(query) && !isReadOnlyQuery(query)) {
    throw new Error("Query is neither recognized read-only nor recognized write SQL.");
  }

  const engine = resolveEngine(connectionString);
  if (engine === "postgres") {
    const pool = await getPostgresPool(connectionString);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = 5000");
      if (!allowWrite) {
        await client.query("SET LOCAL TRANSACTION READ ONLY");
      }
      const readMode = isReadOnlyQuery(query);
      const text = readMode
        ? `SELECT * FROM (${query}) AS t LIMIT ${Math.max(1, Math.min(maxRows, 2000))}`
        : query;
      const result = await client.query(text, params);
      await client.query("COMMIT");
      return {
        rows: readMode ? ((result.rows ?? []) as Array<Record<string, unknown>>) : [],
        rowCount: Number(result.rowCount ?? 0),
        engine
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const db = new Database(connectionString, { readonly: !allowWrite, fileMustExist: true });
  try {
    const stmt = db.prepare(query);
    const readMode = isReadOnlyQuery(query);
    const rows = readMode ? (stmt.all(...params) as Array<Record<string, unknown>>) : [];
    const bounded = rows.slice(0, Math.max(1, Math.min(maxRows, 2000)));
    let rowCount = bounded.length;
    if (!readMode) {
      const info = stmt.run(...params) as { changes?: number };
      rowCount = Number(info.changes ?? 0);
    }
    return {
      rows: bounded,
      rowCount,
      engine
    };
  } finally {
    db.close();
  }
}

export async function executeReadOnlyExternalQuery(input: QueryParams): Promise<QueryResult> {
  return executeExternalQuery({
    ...input,
    allowWrite: false
  });
}
