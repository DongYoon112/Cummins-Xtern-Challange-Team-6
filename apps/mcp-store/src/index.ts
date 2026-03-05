import { config as loadEnv } from "dotenv";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RunStateSchema, StepStatusSchema, WarRoomEventTypeSchema } from "@agentfoundry/shared";
import { z } from "zod";

loadEnv();
loadEnv({ path: path.resolve(fileURLToPath(new URL("../../../.env", import.meta.url))) });

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

    CREATE TABLE IF NOT EXISTS memory_kv (
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, workflow_id, key)
    );

    CREATE TABLE IF NOT EXISTS run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      step_kind TEXT NOT NULL,
      agent_name TEXT,
      status TEXT NOT NULL,
      output_json TEXT,
      confidence REAL,
      rationale TEXT,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id, step_id)
    );

    CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      step_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id ASC);

    CREATE TABLE IF NOT EXISTS run_decisions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      router_step_id TEXT NOT NULL,
      status TEXT NOT NULL,
      decision TEXT,
      requested_at TEXT NOT NULL,
      decided_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_run_decisions_run ON run_decisions(run_id, requested_at DESC);
  `);
}

function jsonResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

function rowToRun(row: Record<string, unknown>) {
  const parsed = RunStateSchema.parse(JSON.parse(String(row.data_json)));
  return parsed;
}

function syncRunSteps(run: z.infer<typeof RunStateSchema>) {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `
    INSERT INTO run_steps (
      id, run_id, workflow_id, step_id, step_name, step_kind, agent_name,
      status, output_json, confidence, rationale, started_at, finished_at, updated_at
    )
    VALUES (
      @id, @runId, @workflowId, @stepId, @stepName, @stepKind, @agentName,
      @status, @outputJson, @confidence, @rationale, @startedAt, @finishedAt, @updatedAt
    )
    ON CONFLICT(run_id, step_id) DO UPDATE SET
      status = excluded.status,
      output_json = excluded.output_json,
      confidence = excluded.confidence,
      rationale = excluded.rationale,
      started_at = COALESCE(run_steps.started_at, excluded.started_at),
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
    `
  );

  const tx = db.transaction(() => {
    for (const step of run.steps) {
      const runtimeStep = (run.context?.steps ?? {})[step.stepId] as
        | { startedAt?: string; endedAt?: string }
        | undefined;
      upsert.run({
        id: `rs_${run.runId}_${step.stepId}`,
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        stepName: step.name,
        stepKind: step.kind,
        agentName: step.agentName ?? null,
        status: step.status,
        outputJson: step.output === undefined ? null : JSON.stringify(step.output),
        confidence: step.confidence ?? null,
        rationale: step.rationale ?? null,
        startedAt: runtimeStep?.startedAt ?? null,
        finishedAt:
          step.status === "COMPLETED" || step.status === "FAILED" || step.status === "REJECTED"
            ? (runtimeStep?.endedAt ?? now)
            : null,
        updatedAt: now
      });
    }
  });

  tx();
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

      syncRunSteps(parsed);

      return jsonResult({ run: parsed });
    }
  );

  server.registerTool(
    "set_memory",
    {
      title: "Set Memory",
      description: "Set workflow memory value for a run/workflow/key tuple",
      inputSchema: {
        runId: z.string().min(1),
        workflowId: z.string().min(1),
        key: z.string().min(1),
        value: z.any()
      }
    },
    async ({ runId, workflowId, key, value }) => {
      const updatedAt = new Date().toISOString();
      db.prepare(
        `
        INSERT INTO memory_kv (run_id, workflow_id, key, value_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, workflow_id, key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
        `
      ).run(runId, workflowId, key, JSON.stringify(value), updatedAt);
      return jsonResult({
        runId,
        workflowId,
        key,
        value,
        updatedAt
      });
    }
  );

  server.registerTool(
    "get_memory",
    {
      title: "Get Memory",
      description: "Get workflow memory value for a run/workflow/key tuple",
      inputSchema: {
        runId: z.string().min(1),
        workflowId: z.string().min(1),
        key: z.string().min(1)
      }
    },
    async ({ runId, workflowId, key }) => {
      const row = db
        .prepare(
          `
          SELECT run_id AS runId, workflow_id AS workflowId, key, value_json AS valueJson, updated_at AS updatedAt
          FROM memory_kv
          WHERE run_id = ? AND workflow_id = ? AND key = ?
          LIMIT 1
          `
        )
        .get(runId, workflowId, key) as
        | {
            runId: string;
            workflowId: string;
            key: string;
            valueJson: string;
            updatedAt: string;
          }
        | undefined;
      if (!row) {
        return jsonResult({
          runId,
          workflowId,
          key,
          value: null
        });
      }

      return jsonResult({
        runId: row.runId,
        workflowId: row.workflowId,
        key: row.key,
        value: JSON.parse(row.valueJson),
        updatedAt: row.updatedAt
      });
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

      syncRunSteps(run);

      return jsonResult({ run });
    }
  );

  server.registerTool(
    "upsert_run_step",
    {
      title: "Upsert Run Step",
      description: "Write a step snapshot row for War Room projections",
      inputSchema: {
        runId: z.string().min(1),
        workflowId: z.string().min(1),
        stepId: z.string().min(1),
        stepName: z.string().min(1),
        stepKind: z.string().min(1),
        agentName: z.string().optional(),
        status: StepStatusSchema,
        output: z.any().optional(),
        confidence: z.number().min(0).max(1).optional(),
        rationale: z.string().optional(),
        startedAt: z.string().optional(),
        finishedAt: z.string().optional()
      }
    },
    async (input) => {
      const now = new Date().toISOString();
      db.prepare(
        `
        INSERT INTO run_steps (
          id, run_id, workflow_id, step_id, step_name, step_kind, agent_name,
          status, output_json, confidence, rationale, started_at, finished_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, step_id) DO UPDATE SET
          status = excluded.status,
          output_json = excluded.output_json,
          confidence = excluded.confidence,
          rationale = excluded.rationale,
          started_at = COALESCE(run_steps.started_at, excluded.started_at),
          finished_at = excluded.finished_at,
          updated_at = excluded.updated_at
        `
      ).run(
        `rs_${input.runId}_${input.stepId}`,
        input.runId,
        input.workflowId,
        input.stepId,
        input.stepName,
        input.stepKind,
        input.agentName ?? null,
        input.status,
        input.output === undefined ? null : JSON.stringify(input.output),
        input.confidence ?? null,
        input.rationale ?? null,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        now
      );

      return jsonResult({ ok: true });
    }
  );

  server.registerTool(
    "append_run_event",
    {
      title: "Append Run Event",
      description: "Persist a War Room event generated by the orchestrator/runtime",
      inputSchema: {
        runId: z.string().min(1),
        workflowId: z.string().min(1),
        stepId: z.string().optional(),
        type: WarRoomEventTypeSchema,
        timestamp: z.string().optional(),
        payload: z.record(z.any()).default({})
      }
    },
    async ({ runId, workflowId, stepId, type, timestamp, payload }) => {
      const createdAt = timestamp ?? new Date().toISOString();
      const result = db
        .prepare(
          `
          INSERT INTO run_events (run_id, workflow_id, step_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          `
        )
        .run(runId, workflowId, stepId ?? null, type, JSON.stringify(payload), createdAt);

      return jsonResult({
        id: Number(result.lastInsertRowid),
        runId,
        workflowId,
        stepId: stepId ?? null,
        type,
        timestamp: createdAt,
        payload
      });
    }
  );

  server.registerTool(
    "list_run_events",
    {
      title: "List Run Events",
      description: "Read War Room events for a run",
      inputSchema: {
        runId: z.string().min(1),
        sinceId: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(1000).optional()
      }
    },
    async ({ runId, sinceId, limit }) => {
      const rows = sinceId
        ? db
            .prepare(
              `
              SELECT id, run_id AS runId, workflow_id AS workflowId, step_id AS stepId, event_type AS type, payload_json AS payloadJson, created_at AS timestamp
              FROM run_events
              WHERE run_id = ? AND id > ?
              ORDER BY id ASC
              LIMIT ?
              `
            )
            .all(runId, sinceId, limit ?? 500)
        : db
            .prepare(
              `
              SELECT id, run_id AS runId, workflow_id AS workflowId, step_id AS stepId, event_type AS type, payload_json AS payloadJson, created_at AS timestamp
              FROM run_events
              WHERE run_id = ?
              ORDER BY id ASC
              LIMIT ?
              `
            )
            .all(runId, limit ?? 500);

      return jsonResult({
        events: (rows as Array<Record<string, unknown>>).map((row) => ({
          id: Number(row.id),
          runId: String(row.runId),
          workflowId: String(row.workflowId),
          stepId: row.stepId ? String(row.stepId) : undefined,
          type: String(row.type),
          timestamp: String(row.timestamp),
          payload: JSON.parse(String(row.payloadJson))
        }))
      });
    }
  );

  server.registerTool(
    "list_run_steps",
    {
      title: "List Run Steps",
      description: "List persisted run step snapshots",
      inputSchema: {
        runId: z.string().min(1)
      }
    },
    async ({ runId }) => {
      const rows = db
        .prepare(
          `
          SELECT
            run_id AS runId,
            workflow_id AS workflowId,
            step_id AS stepId,
            step_name AS stepName,
            step_kind AS stepKind,
            agent_name AS agentName,
            status,
            output_json AS outputJson,
            confidence,
            rationale,
            started_at AS startedAt,
            finished_at AS finishedAt,
            updated_at AS updatedAt
          FROM run_steps
          WHERE run_id = ?
          ORDER BY updated_at ASC
          `
        )
        .all(runId) as Array<Record<string, unknown>>;

      return jsonResult({
        steps: rows.map((row) => ({
          runId: String(row.runId),
          workflowId: String(row.workflowId),
          stepId: String(row.stepId),
          stepName: String(row.stepName),
          stepKind: String(row.stepKind),
          agentName: row.agentName ? String(row.agentName) : undefined,
          status: String(row.status),
          output: row.outputJson ? JSON.parse(String(row.outputJson)) : undefined,
          confidence: typeof row.confidence === "number" ? row.confidence : undefined,
          rationale: row.rationale ? String(row.rationale) : undefined,
          startedAt: row.startedAt ? String(row.startedAt) : undefined,
          finishedAt: row.finishedAt ? String(row.finishedAt) : undefined,
          updatedAt: String(row.updatedAt)
        }))
      });
    }
  );

  server.registerTool(
    "create_router_decision",
    {
      title: "Create Router Decision",
      description: "Persist a pending router decision for a run",
      inputSchema: {
        id: z.string().min(1).optional(),
        runId: z.string().min(1),
        workflowId: z.string().min(1),
        routerStepId: z.string().min(1),
        requestedAt: z.string().optional()
      }
    },
    async ({ id, runId, workflowId, routerStepId, requestedAt }) => {
      const decisionId = id ?? `dec_${Math.random().toString(36).slice(2, 10)}`;
      const now = requestedAt ?? new Date().toISOString();
      db.prepare(
        `
        INSERT INTO run_decisions (id, run_id, workflow_id, router_step_id, status, decision, requested_at, decided_at)
        VALUES (?, ?, ?, ?, 'PENDING', NULL, ?, NULL)
        `
      ).run(decisionId, runId, workflowId, routerStepId, now);

      return jsonResult({
        decision: {
          id: decisionId,
          runId,
          workflowId,
          routerStepId,
          status: "PENDING",
          decision: null,
          requestedAt: now,
          decidedAt: null
        }
      });
    }
  );

  server.registerTool(
    "resolve_router_decision",
    {
      title: "Resolve Router Decision",
      description: "Approve or reject a pending router decision",
      inputSchema: {
        id: z.string().min(1),
        decision: z.enum(["approve", "reject"]),
        decidedAt: z.string().optional()
      }
    },
    async ({ id, decision, decidedAt }) => {
      const row = db
        .prepare(
          `
          SELECT id, run_id AS runId, workflow_id AS workflowId, router_step_id AS routerStepId, status, requested_at AS requestedAt
          FROM run_decisions
          WHERE id = ?
          LIMIT 1
          `
        )
        .get(id) as
        | {
            id: string;
            runId: string;
            workflowId: string;
            routerStepId: string;
            status: string;
            requestedAt: string;
          }
        | undefined;
      if (!row) {
        throw new Error(`Decision not found: ${id}`);
      }
      if (row.status !== "PENDING") {
        throw new Error(`Decision already resolved: ${id}`);
      }

      const now = decidedAt ?? new Date().toISOString();
      const status = decision === "approve" ? "APPROVED" : "REJECTED";
      db.prepare("UPDATE run_decisions SET status = ?, decision = ?, decided_at = ? WHERE id = ?").run(status, decision, now, id);

      return jsonResult({
        decision: {
          id: row.id,
          runId: row.runId,
          workflowId: row.workflowId,
          routerStepId: row.routerStepId,
          status,
          decision,
          requestedAt: row.requestedAt,
          decidedAt: now
        }
      });
    }
  );

  server.registerTool(
    "list_pending_router_decisions",
    {
      title: "List Pending Router Decisions",
      description: "List pending router decisions for a run",
      inputSchema: {
        runId: z.string().min(1)
      }
    },
    async ({ runId }) => {
      const rows = db
        .prepare(
          `
          SELECT
            id,
            run_id AS runId,
            workflow_id AS workflowId,
            router_step_id AS routerStepId,
            status,
            decision,
            requested_at AS requestedAt,
            decided_at AS decidedAt
          FROM run_decisions
          WHERE run_id = ? AND status = 'PENDING'
          ORDER BY requested_at ASC
          `
        )
        .all(runId) as Array<Record<string, unknown>>;

      return jsonResult({
        decisions: rows.map((row) => ({
          id: String(row.id),
          runId: String(row.runId),
          workflowId: String(row.workflowId),
          routerStepId: String(row.routerStepId),
          status: String(row.status),
          decision: row.decision ? String(row.decision) : null,
          requestedAt: String(row.requestedAt),
          decidedAt: row.decidedAt ? String(row.decidedAt) : null
        }))
      });
    }
  );

  return server;
}

initDb();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/mcp", async (req, res) => {
  try {
    const server = createStoreServer();
    const transport = new StreamableHTTPServerTransport({
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
