import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { AuditRecordSchema } from "@agentfoundry/shared";
import { z } from "zod";

const PORT = Number(process.env.MCP_AUDIT_PORT ?? 4103);
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(fileURLToPath(new URL("../../../data/agentfoundry.db", import.meta.url)));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_records (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      user_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      inputs_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      rationale TEXT NOT NULL,
      tool_calls_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_run_time ON audit_records(run_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_workflow_time ON audit_records(workflow_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_agent_time ON audit_records(agent_name, timestamp DESC);
  `);
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

function rowToAudit(row: Record<string, unknown>) {
  return AuditRecordSchema.parse({
    id: row.id,
    timestamp: row.timestamp,
    userId: row.user_id,
    teamId: row.team_id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    stepId: row.step_id,
    agentName: row.agent_name,
    inputs: JSON.parse(String(row.inputs_json)),
    output: JSON.parse(String(row.output_json)),
    confidence: Number(row.confidence),
    rationale: row.rationale,
    toolCalls: JSON.parse(String(row.tool_calls_json))
  });
}

function createAuditServer() {
  const server = new McpServer({
    name: "audit-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "append_record",
    {
      title: "Append Audit Record",
      description: "Append one immutable decision/action record",
      inputSchema: {
        record: AuditRecordSchema
      }
    },
    async ({ record }) => {
      const parsed = AuditRecordSchema.parse(record);

      db.prepare(
        `
        INSERT INTO audit_records (
          id, timestamp, user_id, team_id, run_id, workflow_id, step_id,
          agent_name, inputs_json, output_json, confidence, rationale, tool_calls_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        parsed.id,
        parsed.timestamp,
        parsed.userId,
        parsed.teamId,
        parsed.runId,
        parsed.workflowId,
        parsed.stepId,
        parsed.agentName,
        JSON.stringify(parsed.inputs),
        JSON.stringify(parsed.output),
        parsed.confidence,
        parsed.rationale,
        JSON.stringify(parsed.toolCalls)
      );

      return jsonResult({ ok: true, id: parsed.id });
    }
  );

  server.registerTool(
    "query_records",
    {
      title: "Query Audit Records",
      description: "Query immutable audit records with filters",
      inputSchema: {
        runId: z.string().optional(),
        workflowId: z.string().optional(),
        teamId: z.string().optional(),
        agentName: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().nonnegative().optional()
      }
    },
    async ({ runId, workflowId, teamId, agentName, limit, offset }) => {
      const where: string[] = [];
      const args: unknown[] = [];

      if (runId) {
        where.push("run_id = ?");
        args.push(runId);
      }
      if (workflowId) {
        where.push("workflow_id = ?");
        args.push(workflowId);
      }
      if (teamId) {
        where.push("team_id = ?");
        args.push(teamId);
      }
      if (agentName) {
        where.push("agent_name = ?");
        args.push(agentName);
      }

      const sql = `
        SELECT *
        FROM audit_records
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `;

      args.push(limit ?? 200);
      args.push(offset ?? 0);

      const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
      return jsonResult({ records: rows.map(rowToAudit) });
    }
  );

  return server;
}

initDb();

const app = createMcpExpressApp();
app.use(express.json({ limit: "2mb" }));

app.post("/mcp", async (req, res) => {
  try {
    const server = createAuditServer();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("audit mcp error", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Audit MCP request failed" });
    }
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "audit-mcp" });
});

app.listen(PORT, () => {
  console.log(`audit mcp listening on http://localhost:${PORT}/mcp`);
});