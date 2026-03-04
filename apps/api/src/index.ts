import "dotenv/config";

import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import { z } from "zod";
import type { DbUser } from "./lib/db";
import { db, initApiDb } from "./lib/db";
import { authRequired, signToken } from "./lib/auth";
import { requireRoles } from "./lib/rbac";
import { callMcpTool } from "./lib/mcpClient";
import { getTeamSettingsForClient, getTeamSettingsForServer, saveProviderKey, updateProviderDefaults } from "./lib/settings";
import { testProviderConnection } from "./lib/providers";
import { orchestrator } from "./agents/orchestrator";

const PORT = Number(process.env.API_PORT ?? 4000);

initApiDb();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "api" });
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

app.post("/auth/login", (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login payload" });
    return;
  }

  const user = db
    .prepare("SELECT * FROM users WHERE username = ? LIMIT 1")
    .get(parsed.data.username) as DbUser | undefined;

  if (!user || !bcrypt.compareSync(parsed.data.password, user.password_hash)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = signToken({
    id: user.id,
    username: user.username,
    role: user.role,
    teamId: user.team_id
  });

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      teamId: user.team_id
    }
  });
});

app.get("/auth/me", authRequired, (req, res) => {
  res.json({ user: req.user });
});

app.use(authRequired);

app.get("/agents", async (req, res) => {
  try {
    const payload = await callMcpTool<{ includeDisabled?: boolean }, { agents: unknown[] }>(
      "registry",
      "list_agents",
      {}
    );
    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load agents" });
  }
});

app.get("/workflows", async (req, res) => {
  try {
    const teamId = req.user!.teamId;
    const payload = await callMcpTool<{ teamId: string }, { workflows: unknown[] }>(
      "registry",
      "list_workflows",
      { teamId }
    );
    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to list workflows" });
  }
});

app.get("/workflows/:workflowId", async (req, res) => {
  try {
    const version = req.query.version ? Number(req.query.version) : undefined;
    const payload = await callMcpTool<{ workflowId: string; version?: number }, unknown>(
      "registry",
      "get_workflow_version",
      {
        workflowId: req.params.workflowId,
        version
      }
    );
    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(404).json({ error: "Workflow version not found" });
  }
});

const workflowSaveSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  changelog: z.string().min(1),
  steps: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(["AGENT", "APPROVAL"]),
      agentName: z.string().optional(),
      params: z.record(z.any()).default({})
    })
  )
});

app.post("/workflows", requireRoles("BUILDER"), async (req, res) => {
  const parsed = workflowSaveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid workflow payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const payload = await callMcpTool("registry", "save_workflow_version", {
      teamId: req.user!.teamId,
      name: parsed.data.name,
      description: parsed.data.description,
      changelog: parsed.data.changelog,
      createdBy: req.user!.id,
      steps: parsed.data.steps
    });
    res.status(201).json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save workflow" });
  }
});

app.post("/workflows/:workflowId/versions", requireRoles("BUILDER"), async (req, res) => {
  const parsed = workflowSaveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid workflow payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const payload = await callMcpTool("registry", "save_workflow_version", {
      teamId: req.user!.teamId,
      workflowId: req.params.workflowId,
      name: parsed.data.name,
      description: parsed.data.description,
      changelog: parsed.data.changelog,
      createdBy: req.user!.id,
      steps: parsed.data.steps
    });
    res.status(201).json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save workflow version" });
  }
});

app.post("/workflows/:workflowId/fork", requireRoles("BUILDER"), async (req, res) => {
  const forkSchema = z.object({ name: z.string().min(1), changelog: z.string().min(1).default("Forked workflow") });
  const parsed = forkSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid fork payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const latest = await callMcpTool<
      { workflowId: string },
      { workflowId: string; name: string; description?: string; steps: unknown[] }
    >("registry", "get_workflow_version", {
      workflowId: req.params.workflowId
    });

    const forked = await callMcpTool("registry", "save_workflow_version", {
      teamId: req.user!.teamId,
      name: parsed.data.name,
      description: latest.description,
      changelog: parsed.data.changelog,
      createdBy: req.user!.id,
      forkedFrom: latest.workflowId,
      steps: latest.steps
    });

    res.status(201).json(forked);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fork workflow" });
  }
});

app.get("/runs", async (req, res) => {
  try {
    const runs = await orchestrator.listRuns(req.user!.teamId);
    res.json({ runs });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to list runs" });
  }
});

const runCreateSchema = z.object({
  workflowId: z.string().min(1),
  workflowVersion: z.number().int().positive().optional()
});

app.post("/runs", requireRoles("OPERATOR"), async (req, res) => {
  const parsed = runCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid run payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const run = await orchestrator.startRun({
      actor: {
        userId: req.user!.id,
        username: req.user!.username,
        teamId: req.user!.teamId
      },
      workflowId: parsed.data.workflowId,
      workflowVersion: parsed.data.workflowVersion
    });

    res.status(201).json({ run });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to execute run" });
  }
});

app.get("/runs/:runId", async (req, res) => {
  try {
    const run = await orchestrator.getRun(req.params.runId, req.user!.teamId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    res.json({ run });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load run" });
  }
});

app.get("/approvals", requireRoles("APPROVER"), async (req, res) => {
  try {
    const approvals = await orchestrator.listPendingApprovals(req.user!.teamId);
    res.json({ approvals });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to list approvals" });
  }
});

const approvalDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  comment: z.string().optional()
});

app.post("/approvals/:approvalId/decision", requireRoles("APPROVER"), async (req, res) => {
  const parsed = approvalDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid decision payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const run = await orchestrator.decideApproval({
      approvalId: req.params.approvalId,
      decision: parsed.data.decision,
      comment: parsed.data.comment,
      actor: {
        userId: req.user!.id,
        username: req.user!.username,
        teamId: req.user!.teamId
      }
    });

    res.json({ run });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to process approval decision" });
  }
});

app.get("/audit", requireRoles("AUDITOR", "APPROVER", "BUILDER"), async (req, res) => {
  try {
    const payload = await callMcpTool(
      "audit",
      "query_records",
      {
        teamId: req.user!.teamId,
        runId: req.query.runId ? String(req.query.runId) : undefined,
        workflowId: req.query.workflowId ? String(req.query.workflowId) : undefined,
        agentName: req.query.agentName ? String(req.query.agentName) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 200
      }
    );

    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to query audit records" });
  }
});

app.get("/audit/export", requireRoles("AUDITOR", "APPROVER", "BUILDER"), async (req, res) => {
  try {
    const payload = await callMcpTool(
      "audit",
      "query_records",
      {
        teamId: req.user!.teamId,
        runId: req.query.runId ? String(req.query.runId) : undefined,
        workflowId: req.query.workflowId ? String(req.query.workflowId) : undefined,
        agentName: req.query.agentName ? String(req.query.agentName) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 1000
      }
    );

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=audit-export.json");
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to export audit records" });
  }
});

app.get("/settings", requireRoles("BUILDER"), (req, res) => {
  try {
    const settings = getTeamSettingsForClient(req.user!.teamId);
    res.json(settings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

const settingsKeySchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini"]),
  key: z.string().min(1)
});

app.post("/settings/key", requireRoles("BUILDER"), (req, res) => {
  const parsed = settingsKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid key payload", details: parsed.error.flatten() });
    return;
  }

  try {
    saveProviderKey(req.user!.teamId, parsed.data.provider, parsed.data.key);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save provider key" });
  }
});

const settingsDefaultsSchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini"]),
  model: z.string().min(1)
});

app.post("/settings/defaults", requireRoles("BUILDER"), (req, res) => {
  const parsed = settingsDefaultsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid defaults payload", details: parsed.error.flatten() });
    return;
  }

  try {
    updateProviderDefaults(req.user!.teamId, parsed.data.provider, parsed.data.model);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update defaults" });
  }
});

const settingsTestSchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini"]).optional(),
  model: z.string().optional()
});

app.post("/settings/test", requireRoles("BUILDER"), async (req, res) => {
  const parsed = settingsTestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid test payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const settings = getTeamSettingsForServer(req.user!.teamId);
    const provider = parsed.data.provider ?? settings.defaultProvider;
    const model = parsed.data.model ?? settings.defaultModel;
    const apiKey = settings.keys[provider];
    const result = await testProviderConnection({ provider, model, apiKey });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to test provider connection" });
  }
});

app.get("/optimization/proposals", async (req, res) => {
  try {
    const rows = db
      .prepare(
        "SELECT id, team_id, workflow_id, run_id, title, body, status, created_at FROM optimization_proposals WHERE team_id = ? ORDER BY created_at DESC"
      )
      .all(req.user!.teamId) as Array<{
      id: string;
      team_id: string;
      workflow_id: string;
      run_id: string | null;
      title: string;
      body: string;
      status: string;
      created_at: string;
    }>;

    res.json({
      proposals: rows.map((row) => ({
        id: row.id,
        teamId: row.team_id,
        workflowId: row.workflow_id,
        runId: row.run_id,
        title: row.title,
        body: JSON.parse(row.body),
        status: row.status,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to list optimization proposals" });
  }
});

app.listen(PORT, () => {
  console.log(`api listening on http://localhost:${PORT}`);
});