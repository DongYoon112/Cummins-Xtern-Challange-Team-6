import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { DEFAULT_MODELS } from "@agentfoundry/shared";

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(fileURLToPath(new URL("../../../../data/agentfoundry.db", import.meta.url)));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

export type DbUser = {
  id: string;
  username: string;
  password_hash: string;
  role: "ADMIN" | "BUILDER" | "OPERATOR" | "APPROVER" | "AUDITOR";
  team_id: string;
};

export function initApiDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      team_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_settings (
      team_id TEXT PRIMARY KEY,
      default_provider TEXT NOT NULL,
      default_model TEXT NOT NULL,
      openai_key_enc TEXT,
      anthropic_key_enc TEXT,
      gemini_key_enc TEXT,
      external_db_url_enc TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repo_settings (
      team_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      default_provider TEXT NOT NULL,
      default_model TEXT NOT NULL,
      openai_key_enc TEXT,
      anthropic_key_enc TEXT,
      gemini_key_enc TEXT,
      external_db_url_enc TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, repo_id)
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      context_json TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT,
      decision_comment TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_status_requested ON approvals(status, requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id);

    CREATE TABLE IF NOT EXISTS optimization_proposals (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      run_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_drafts (
      team_id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory (
      sku TEXT PRIMARY KEY,
      on_hand INTEGER NOT NULL,
      reserved INTEGER NOT NULL,
      reorder_days INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      supplier_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      risk_score REAL NOT NULL,
      on_time_pct REAL NOT NULL,
      region TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      qty INTEGER NOT NULL,
      destination TEXT NOT NULL,
      requested_date TEXT NOT NULL,
      unit_price REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shipping_rates (
      carrier TEXT NOT NULL,
      mode TEXT NOT NULL,
      region TEXT NOT NULL,
      rate_usd REAL NOT NULL,
      lead_days INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      run_id TEXT,
      workflow_id TEXT,
      vendor_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      qty INTEGER NOT NULL,
      status TEXT NOT NULL,
      draft_payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_vendor_orders (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL,
      vendor_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO teams (id, name, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING
    `
  ).run("team-default", "Default Manufacturing Team", now);

  const usersCount = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (usersCount.count === 0) {
    const seedUsers = [
      { id: "u-admin", username: "admin", password: "admin123", role: "ADMIN" as const },
      { id: "u-builder", username: "builder", password: "builder123", role: "BUILDER" as const },
      { id: "u-operator", username: "operator", password: "operator123", role: "OPERATOR" as const },
      { id: "u-approver", username: "approver", password: "approver123", role: "APPROVER" as const },
      { id: "u-auditor", username: "auditor", password: "auditor123", role: "AUDITOR" as const }
    ];

    const insertUser = db.prepare(
      "INSERT INTO users (id, username, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?)"
    );

    const tx = db.transaction(() => {
      for (const user of seedUsers) {
        insertUser.run(
          user.id,
          user.username,
          bcrypt.hashSync(user.password, 10),
          user.role,
          "team-default"
        );
      }
    });

    tx();
  }

  const existingAdmin = db
    .prepare("SELECT id FROM users WHERE username = ? LIMIT 1")
    .get("admin") as { id: string } | undefined;
  if (!existingAdmin) {
    db.prepare("INSERT INTO users (id, username, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?)").run(
      "u-admin",
      "admin",
      bcrypt.hashSync("admin123", 10),
      "ADMIN",
      "team-default"
    );
  }

  db.prepare(
    `
    INSERT INTO team_settings (team_id, default_provider, default_model, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(team_id) DO NOTHING
    `
  ).run("team-default", "openai", DEFAULT_MODELS.openai, now);

  const settingColumns = db.prepare("PRAGMA table_info(team_settings)").all() as Array<{ name: string }>;
  const hasExternalDbColumn = settingColumns.some((column) => column.name === "external_db_url_enc");
  if (!hasExternalDbColumn) {
    db.exec("ALTER TABLE team_settings ADD COLUMN external_db_url_enc TEXT");
  }

  const inventoryCount = db.prepare("SELECT COUNT(*) AS count FROM inventory").get() as { count: number };
  if (inventoryCount.count === 0) {
    const tx = db.transaction(() => {
      db.prepare("INSERT INTO inventory (sku, on_hand, reserved, reorder_days) VALUES (?, ?, ?, ?)").run(
        "SKU-100",
        42,
        35,
        7
      );
      db.prepare("INSERT INTO inventory (sku, on_hand, reserved, reorder_days) VALUES (?, ?, ?, ?)").run(
        "SKU-101",
        18,
        9,
        14
      );
      db.prepare("INSERT INTO inventory (sku, on_hand, reserved, reorder_days) VALUES (?, ?, ?, ?)").run(
        "SKU-102",
        120,
        44,
        5
      );

      db.prepare("INSERT INTO suppliers (supplier_id, name, risk_score, on_time_pct, region) VALUES (?, ?, ?, ?, ?)").run(
        "SUP-01",
        "Midwest Fasteners",
        0.22,
        0.97,
        "US-MW"
      );
      db.prepare("INSERT INTO suppliers (supplier_id, name, risk_score, on_time_pct, region) VALUES (?, ?, ?, ?, ?)").run(
        "SUP-02",
        "Delta Castings",
        0.71,
        0.81,
        "APAC"
      );
      db.prepare("INSERT INTO suppliers (supplier_id, name, risk_score, on_time_pct, region) VALUES (?, ?, ?, ?, ?)").run(
        "SUP-03",
        "Prairie Components",
        0.34,
        0.91,
        "US-SE"
      );

      db.prepare("INSERT INTO orders (order_id, sku, qty, destination, requested_date, unit_price) VALUES (?, ?, ?, ?, ?, ?)").run(
        "ORD-1001",
        "SKU-100",
        28,
        "Indianapolis",
        "2026-03-15",
        112.5
      );
      db.prepare("INSERT INTO orders (order_id, sku, qty, destination, requested_date, unit_price) VALUES (?, ?, ?, ?, ?, ?)").run(
        "ORD-1002",
        "SKU-101",
        12,
        "Nashville",
        "2026-03-11",
        89.0
      );
      db.prepare("INSERT INTO orders (order_id, sku, qty, destination, requested_date, unit_price) VALUES (?, ?, ?, ?, ?, ?)").run(
        "ORD-1003",
        "SKU-102",
        40,
        "Louisville",
        "2026-03-18",
        76.25
      );

      db.prepare("INSERT INTO shipping_rates (carrier, mode, region, rate_usd, lead_days) VALUES (?, ?, ?, ?, ?)").run(
        "FastFreight",
        "ground",
        "US-MW",
        180,
        2
      );
      db.prepare("INSERT INTO shipping_rates (carrier, mode, region, rate_usd, lead_days) VALUES (?, ?, ?, ?, ?)").run(
        "AeroShip",
        "air",
        "US-MW",
        620,
        1
      );
      db.prepare("INSERT INTO shipping_rates (carrier, mode, region, rate_usd, lead_days) VALUES (?, ?, ?, ?, ?)").run(
        "Continental",
        "ground",
        "US-SE",
        240,
        3
      );
      db.prepare("INSERT INTO shipping_rates (carrier, mode, region, rate_usd, lead_days) VALUES (?, ?, ?, ?, ?)").run(
        "BlueOcean",
        "ocean",
        "APAC",
        410,
        12
      );
      db.prepare("INSERT INTO shipping_rates (carrier, mode, region, rate_usd, lead_days) VALUES (?, ?, ?, ?, ?)").run(
        "AeroShip",
        "air",
        "APAC",
        980,
        4
      );
    });

    tx();
  }
}
