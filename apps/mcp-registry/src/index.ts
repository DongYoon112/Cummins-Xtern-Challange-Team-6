import { config as loadEnv } from "dotenv";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  AGENT_CATALOG,
  BUILTIN_WORKFLOW_TEMPLATES,
  WorkflowStepSchema
} from "@agentfoundry/shared";
import { z } from "zod";

loadEnv();
loadEnv({ path: path.resolve(fileURLToPath(new URL("../../../.env", import.meta.url))) });

const PORT = Number(process.env.MCP_REGISTRY_PORT ?? 4101);
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(fileURLToPath(new URL("../../../data/agentfoundry.db", import.meta.url)));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      forked_from TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      changelog TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workflow_id, version)
    );

    CREATE TABLE IF NOT EXISTS agent_catalog (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      allowlist_json TEXT NOT NULL,
      default_params_json TEXT NOT NULL
    );
  `);
}

function seedAgents() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM agent_catalog").get() as {
    count: number;
  };

  if (existing.count > 0) {
    return;
  }

  const insert = db.prepare(`
    INSERT INTO agent_catalog (name, type, description, allowlist_json, default_params_json)
    VALUES (@name, @type, @description, @allowlist, @defaultParams)
  `);

  const tx = db.transaction(() => {
    for (const agent of AGENT_CATALOG) {
      insert.run({
        name: agent.name,
        type: agent.type,
        description: agent.description,
        allowlist: JSON.stringify(agent.allowlist),
        defaultParams: JSON.stringify(agent.defaultParams)
      });
    }
  });

  tx();
}

function seedTemplates() {
  const teamId = "team-default";
  const existing = db
    .prepare("SELECT COUNT(*) AS count FROM workflows WHERE team_id = ?")
    .get(teamId) as { count: number };

  if (existing.count > 0) {
    return;
  }

  const now = new Date().toISOString();
  const insertWorkflow = db.prepare(`
    INSERT INTO workflows (id, team_id, name, description, forked_from, created_by, created_at, updated_at)
    VALUES (@id, @teamId, @name, @description, @forkedFrom, @createdBy, @createdAt, @updatedAt)
  `);

  const insertVersion = db.prepare(`
    INSERT INTO workflow_versions (id, workflow_id, version, changelog, steps_json, created_by, created_at)
    VALUES (@id, @workflowId, @version, @changelog, @stepsJson, @createdBy, @createdAt)
  `);

  const tx = db.transaction(() => {
    for (const template of BUILTIN_WORKFLOW_TEMPLATES) {
      const workflowId = `wf_${randomUUID()}`;
      insertWorkflow.run({
        id: workflowId,
        teamId,
        name: template.name,
        description: template.description,
        forkedFrom: null,
        createdBy: "system",
        createdAt: now,
        updatedAt: now
      });

      insertVersion.run({
        id: `wfv_${randomUUID()}`,
        workflowId,
        version: 1,
        changelog: template.changelog,
        stepsJson: JSON.stringify(template.steps),
        createdBy: "system",
        createdAt: now
      });
    }
  });

  tx();
}

function jsonResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

function createRegistryServer() {
  const server = new McpServer({
    name: "registry-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "list_workflows",
    {
      title: "List Workflows",
      description: "List workflow repositories for a team",
      inputSchema: {
        teamId: z.string().min(1)
      }
    },
    async ({ teamId }) => {
      const rows = db
        .prepare(
          `
          SELECT
            w.id AS workflowId,
            w.team_id AS teamId,
            w.name,
            w.description,
            w.forked_from AS forkedFrom,
            w.updated_at AS updatedAt,
            COALESCE((SELECT MAX(version) FROM workflow_versions v WHERE v.workflow_id = w.id), 0) AS latestVersion
          FROM workflows w
          WHERE w.team_id = ?
          ORDER BY w.updated_at DESC
          `
        )
        .all(teamId);

      return jsonResult({ workflows: rows });
    }
  );

  server.registerTool(
    "get_workflow_version",
    {
      title: "Get Workflow Version",
      description: "Read a specific or latest workflow version",
      inputSchema: {
        workflowId: z.string().min(1),
        version: z.number().int().positive().optional()
      }
    },
    async ({ workflowId, version }) => {
      const row = version
        ? db
            .prepare(
              `
              SELECT
                w.id AS workflowId,
                w.team_id AS teamId,
                w.name,
                w.description,
                v.version,
                v.changelog,
                v.created_by AS createdBy,
                v.created_at AS createdAt,
                v.steps_json AS stepsJson
              FROM workflow_versions v
              JOIN workflows w ON w.id = v.workflow_id
              WHERE v.workflow_id = ? AND v.version = ?
              LIMIT 1
              `
            )
            .get(workflowId, version)
        : db
            .prepare(
              `
              SELECT
                w.id AS workflowId,
                w.team_id AS teamId,
                w.name,
                w.description,
                v.version,
                v.changelog,
                v.created_by AS createdBy,
                v.created_at AS createdAt,
                v.steps_json AS stepsJson
              FROM workflow_versions v
              JOIN workflows w ON w.id = v.workflow_id
              WHERE v.workflow_id = ?
              ORDER BY v.version DESC
              LIMIT 1
              `
            )
            .get(workflowId);

      if (!row) {
        throw new Error("Workflow version not found");
      }

      const steps = WorkflowStepSchema.array().parse(
        JSON.parse((row as { stepsJson: string }).stepsJson)
      );
      const result = {
        ...(row as Record<string, unknown>),
        steps
      };

      delete (result as { stepsJson?: string }).stepsJson;
      return jsonResult(result);
    }
  );

  server.registerTool(
    "save_workflow_version",
    {
      title: "Save Workflow Version",
      description: "Create a workflow or append a new version",
      inputSchema: {
        teamId: z.string().min(1),
        workflowId: z.string().optional(),
        name: z.string().min(1),
        description: z.string().optional(),
        changelog: z.string().min(1),
        createdBy: z.string().min(1),
        forkedFrom: z.string().optional(),
        steps: z.array(WorkflowStepSchema)
      }
    },
    async (input) => {
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        let workflowId = input.workflowId;

        if (!workflowId) {
          workflowId = `wf_${randomUUID()}`;
          db.prepare(
            `
            INSERT INTO workflows (id, team_id, name, description, forked_from, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `
          ).run(
            workflowId,
            input.teamId,
            input.name,
            input.description ?? null,
            input.forkedFrom ?? null,
            input.createdBy,
            now,
            now
          );
        } else {
          const existing = db
            .prepare("SELECT id FROM workflows WHERE id = ?")
            .get(workflowId) as { id: string } | undefined;
          if (!existing) {
            throw new Error("Cannot save version for unknown workflow");
          }
          db.prepare(
            "UPDATE workflows SET name = ?, description = ?, updated_at = ? WHERE id = ?"
          ).run(input.name, input.description ?? null, now, workflowId);
        }

        const versionRow = db
          .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM workflow_versions WHERE workflow_id = ?")
          .get(workflowId) as { version: number };

        const nextVersion = versionRow.version + 1;

        db.prepare(
          `
          INSERT INTO workflow_versions (id, workflow_id, version, changelog, steps_json, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          `wfv_${randomUUID()}`,
          workflowId,
          nextVersion,
          input.changelog,
          JSON.stringify(input.steps),
          input.createdBy,
          now
        );

        db.prepare("UPDATE workflows SET updated_at = ? WHERE id = ?").run(now, workflowId);

        return {
          workflowId,
          version: nextVersion,
          teamId: input.teamId,
          name: input.name,
          description: input.description ?? null,
          changelog: input.changelog,
          createdBy: input.createdBy,
          createdAt: now,
          steps: input.steps
        };
      });

      const payload = tx();
      return jsonResult(payload);
    }
  );

  server.registerTool(
    "delete_workflow",
    {
      title: "Delete Workflow",
      description: "Delete a workflow repository and all of its versions",
      inputSchema: {
        teamId: z.string().min(1),
        workflowId: z.string().min(1)
      }
    },
    async ({ teamId, workflowId }) => {
      const existing = db
        .prepare("SELECT id, name, team_id AS teamId FROM workflows WHERE id = ? LIMIT 1")
        .get(workflowId) as { id: string; name: string; teamId: string } | undefined;

      if (!existing || existing.teamId !== teamId) {
        throw new Error("Workflow not found");
      }

      const tx = db.transaction(() => {
        const deletedVersions = db
          .prepare("DELETE FROM workflow_versions WHERE workflow_id = ?")
          .run(workflowId).changes;
        const deletedWorkflows = db
          .prepare("DELETE FROM workflows WHERE id = ? AND team_id = ?")
          .run(workflowId, teamId).changes;

        return {
          ok: deletedWorkflows > 0,
          workflowId,
          name: existing.name,
          deletedVersions
        };
      });

      return jsonResult(tx());
    }
  );

  server.registerTool(
    "list_agents",
    {
      title: "List Agents",
      description: "List the seeded agent catalog",
      inputSchema: {
        includeDisabled: z.boolean().optional()
      }
    },
    async () => {
      const rows = db
        .prepare(
          `
          SELECT name, type, description, allowlist_json AS allowlistJson, default_params_json AS defaultParamsJson
          FROM agent_catalog
          ORDER BY name
          `
        )
        .all() as Array<{
        name: string;
        type: string;
        description: string;
        allowlistJson: string;
        defaultParamsJson: string;
      }>;

      return jsonResult({
        agents: rows.map((row) => ({
          name: row.name,
          type: row.type,
          description: row.description,
          allowlist: JSON.parse(row.allowlistJson),
          defaultParams: JSON.parse(row.defaultParamsJson)
        }))
      });
    }
  );

  return server;
}

initDb();
seedAgents();
seedTemplates();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/mcp", async (req, res) => {
  try {
    const server = createRegistryServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("registry mcp error", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Registry MCP request failed" });
    }
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "registry-mcp" });
});

app.listen(PORT, () => {
  console.log(`registry mcp listening on http://localhost:${PORT}/mcp`);
});
