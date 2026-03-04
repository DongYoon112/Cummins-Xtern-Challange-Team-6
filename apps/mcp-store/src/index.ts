import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { RunStateSchema, StepStatusSchema } from "@agentfoundry/shared";
import { z } from "zod";

const PORT = Number(process.env.MCP_STORE_PORT ?? 4102);
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(fileURLToPath(new URL("../../../data/agentfoundry.db", import.meta.url)));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      current_step_index INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT,
      data_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runs_team_updated ON runs(team_id, updated_at DESC);
  `);
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

function rowToRun(row: Record<string, unknown>) {
  const parsed = RunStateSchema.parse(JSON.parse(String(row.data_json)));
  return parsed;
}

function createStoreServer() {
  const server = new McpServer({
    name: "store-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "get_run",
    {
      title: "Get Run",
      description: "Fetch a run by id",
      inputSchema: {
        runId: z.string().min(1)
      }
    },
    async ({ runId }) => {
      const row = db.prepare("SELECT * FROM runs WHERE id = ? LIMIT 1").get(runId) as
        | Record<string, unknown>
        | undefined;

      return jsonResult({ run: row ? rowToRun(row) : null });
    }
  );

  server.registerTool(
    "list_runs",
    {
      title: "List Runs",
      description: "List runs for a team",
      inputSchema: {
        teamId: z.string().min(1),
        limit: z.number().int().positive().max(200).optional()
      }
    },
    async ({ teamId, limit }) => {
      const rows = db
        .prepare("SELECT * FROM runs WHERE team_id = ? ORDER BY updated_at DESC LIMIT ?")
        .all(teamId, limit ?? 50) as Record<string, unknown>[];

      return jsonResult({ runs: rows.map(rowToRun) });
    }
  );

  server.registerTool(
    "upsert_run_state",
    {
      title: "Upsert Run State",
      description: "Insert or update full run state",
      inputSchema: {
        run: RunStateSchema
      }
    },
    async ({ run }) => {
      const parsed = RunStateSchema.parse(run);

      db.prepare(
        `
        INSERT INTO runs (id, team_id, workflow_id, workflow_version, status, current_step_index, created_by, started_at, updated_at, completed_at, error, data_json)
        VALUES (@id, @teamId, @workflowId, @workflowVersion, @status, @currentStepIndex, @createdBy, @startedAt, @updatedAt, @completedAt, @error, @dataJson)
        ON CONFLICT(id) DO UPDATE SET
          team_id = excluded.team_id,
          workflow_id = excluded.workflow_id,
          workflow_version = excluded.workflow_version,
          status = excluded.status,
          current_step_index = excluded.current_step_index,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          error = excluded.error,
          data_json = excluded.data_json
        `
      ).run({
        id: parsed.runId,
        teamId: parsed.teamId,
        workflowId: parsed.workflowId,
        workflowVersion: parsed.workflowVersion,
        status: parsed.status,
        currentStepIndex: parsed.currentStepIndex,
        createdBy: parsed.createdBy,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt,
        completedAt: parsed.completedAt ?? null,
        error: parsed.error ?? null,
        dataJson: JSON.stringify(parsed)
      });

      return jsonResult({ run: parsed });
    }
  );

  server.registerTool(
    "write_output",
    {
      title: "Write Step Output",
      description: "Write a step output into persisted run state",
      inputSchema: {
        runId: z.string().min(1),
        stepId: z.string().min(1),
        output: z.any(),
        confidence: z.number().min(0).max(1),
        rationale: z.string().optional(),
        status: StepStatusSchema.optional()
      }
    },
    async ({ runId, stepId, output, confidence, rationale, status }) => {
      const row = db.prepare("SELECT * FROM runs WHERE id = ? LIMIT 1").get(runId) as
        | Record<string, unknown>
        | undefined;

      if (!row) {
        throw new Error(`Run not found: ${runId}`);
      }

      const run = rowToRun(row);
      const step = run.steps.find((candidate) => candidate.stepId === stepId);
      if (!step) {
        throw new Error(`Step not found in run: ${stepId}`);
      }

      step.output = output;
      step.confidence = confidence;
      step.rationale = rationale;
      if (status) {
        step.status = status;
      }

      run.updatedAt = new Date().toISOString();

      db.prepare(
        `
        UPDATE runs
        SET status = ?,
            current_step_index = ?,
            updated_at = ?,
            completed_at = ?,
            error = ?,
            data_json = ?
        WHERE id = ?
        `
      ).run(
        run.status,
        run.currentStepIndex,
        run.updatedAt,
        run.completedAt ?? null,
        run.error ?? null,
        JSON.stringify(run),
        run.runId
      );

      return jsonResult({ run });
    }
  );

  return server;
}

initDb();

const app = createMcpExpressApp();
app.use(express.json({ limit: "2mb" }));

app.post("/mcp", async (req, res) => {
  try {
    const server = createStoreServer();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("store mcp error", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Store MCP request failed" });
    }
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "store-mcp" });
});

app.listen(PORT, () => {
  console.log(`store mcp listening on http://localhost:${PORT}/mcp`);
});