import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";

import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import { z } from "zod";
import type { DbUser } from "./lib/db";
import { db, initApiDb } from "./lib/db";
import { authRequired, signToken } from "./lib/auth";
import { requireRoles } from "./lib/rbac";
import { callMcpTool } from "./lib/mcpClient";
import { getTeamSettingsForClient, getTeamSettingsForServer, saveExternalDbUrl, saveProviderKey, updateProviderDefaults } from "./lib/settings";
import { askProviderForObject, testProviderConnection } from "./lib/providers";
import { orchestrator } from "./agents/orchestrator";
import { compileWorkflowDraft } from "./lib/workflowCompiler";
import { DraftGenerateInputSchema, generateWorkflowDraft } from "./lib/draftGenerator";
import { executeReadOnlyExternalQuery } from "./lib/externalDb";
import { runsRouter } from "./routes/runs";
import { warRoomRouter } from "./routes/warRoom";

loadEnv();
loadEnv({ path: path.resolve(fileURLToPath(new URL("../../../.env", import.meta.url))) });

const PORT = Number(process.env.API_PORT ?? 4000);

initApiDb();

function normalizePublishResult(input: unknown): { workflowId: string; version: number } {
  const maybe = input as {
    workflowId?: unknown;
    id?: unknown;
    workflow_id?: unknown;
    version?: unknown;
    latestVersion?: unknown;
    latest_version?: unknown;
    workflowVersion?: unknown;
    workflow?: unknown;
    data?: unknown;
    result?: unknown;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };

  const directWorkflowId =
    (typeof maybe.workflowId === "string" && maybe.workflowId) ||
    (typeof maybe.id === "string" && maybe.id) ||
    (typeof maybe.workflow_id === "string" && maybe.workflow_id) ||
    "";
  const directVersion = Number(
    maybe.version ?? maybe.latestVersion ?? maybe.latest_version ?? maybe.workflowVersion
  );
  if (directWorkflowId && Number.isFinite(directVersion) && directVersion > 0) {
    return { workflowId: directWorkflowId, version: directVersion };
  }

  const structured = maybe.structuredContent as
    | {
        workflowId?: unknown;
        id?: unknown;
        workflow_id?: unknown;
        version?: unknown;
        latestVersion?: unknown;
        latest_version?: unknown;
        workflowVersion?: unknown;
      }
    | undefined;
  const structuredWorkflowId =
    (typeof structured?.workflowId === "string" && structured.workflowId) ||
    (typeof structured?.id === "string" && structured.id) ||
    (typeof structured?.workflow_id === "string" && structured.workflow_id) ||
    "";
  const structuredVersion = Number(
    structured?.version ?? structured?.latestVersion ?? structured?.latest_version ?? structured?.workflowVersion
  );
  if (structuredWorkflowId && Number.isFinite(structuredVersion) && structuredVersion > 0) {
    return { workflowId: structuredWorkflowId, version: structuredVersion };
  }

  const nestedCandidates = [maybe.workflow, maybe.data, maybe.result] as Array<unknown>;
  for (const candidate of nestedCandidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const nested = candidate as {
      workflowId?: unknown;
      id?: unknown;
      workflow_id?: unknown;
      version?: unknown;
      latestVersion?: unknown;
      latest_version?: unknown;
      workflowVersion?: unknown;
    };
    const nestedWorkflowId =
      (typeof nested.workflowId === "string" && nested.workflowId) ||
      (typeof nested.id === "string" && nested.id) ||
      (typeof nested.workflow_id === "string" && nested.workflow_id) ||
      "";
    const nestedVersion = Number(
      nested.version ?? nested.latestVersion ?? nested.latest_version ?? nested.workflowVersion
    );
    if (nestedWorkflowId && Number.isFinite(nestedVersion) && nestedVersion > 0) {
      return { workflowId: nestedWorkflowId, version: nestedVersion };
    }
  }

  const text = maybe.content?.find((entry) => entry.type === "text")?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as {
        workflowId?: unknown;
        id?: unknown;
        workflow_id?: unknown;
        version?: unknown;
        latestVersion?: unknown;
        latest_version?: unknown;
        workflowVersion?: unknown;
        workflow?: unknown;
        data?: unknown;
        result?: unknown;
      };
      const parsedWorkflowId =
        (typeof parsed.workflowId === "string" && parsed.workflowId) ||
        (typeof parsed.id === "string" && parsed.id) ||
        (typeof parsed.workflow_id === "string" && parsed.workflow_id) ||
        "";
      const parsedVersion = Number(
        parsed.version ?? parsed.latestVersion ?? parsed.latest_version ?? parsed.workflowVersion
      );
      if (parsedWorkflowId && Number.isFinite(parsedVersion) && parsedVersion > 0) {
        return { workflowId: parsedWorkflowId, version: parsedVersion };
      }

      const nestedParsedCandidates = [parsed.workflow, parsed.data, parsed.result] as Array<unknown>;
      for (const candidate of nestedParsedCandidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const nested = candidate as {
          workflowId?: unknown;
          id?: unknown;
          workflow_id?: unknown;
          version?: unknown;
          latestVersion?: unknown;
          latest_version?: unknown;
          workflowVersion?: unknown;
        };
        const nestedWorkflowId =
          (typeof nested.workflowId === "string" && nested.workflowId) ||
          (typeof nested.id === "string" && nested.id) ||
          (typeof nested.workflow_id === "string" && nested.workflow_id) ||
          "";
        const nestedVersion = Number(
          nested.version ?? nested.latestVersion ?? nested.latest_version ?? nested.workflowVersion
        );
        if (nestedWorkflowId && Number.isFinite(nestedVersion) && nestedVersion > 0) {
          return { workflowId: nestedWorkflowId, version: nestedVersion };
        }
      }
    } catch {
      // handled below
    }
  }

  throw new Error("Invalid publish response from registry.");
}

function normalizeWorkflowVersionResult(input: unknown): { workflowId: string; version: number } {
  const maybe = input as {
    workflowId?: unknown;
    id?: unknown;
    workflow_id?: unknown;
    version?: unknown;
    latestVersion?: unknown;
    latest_version?: unknown;
    workflowVersion?: unknown;
    workflow?: unknown;
    data?: unknown;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };

  const directWorkflowId =
    (typeof maybe.workflowId === "string" && maybe.workflowId) ||
    (typeof maybe.id === "string" && maybe.id) ||
    (typeof maybe.workflow_id === "string" && maybe.workflow_id) ||
    "";
  const directVersion = Number(
    maybe.version ?? maybe.latestVersion ?? maybe.latest_version ?? maybe.workflowVersion
  );
  if (directWorkflowId && Number.isFinite(directVersion) && directVersion > 0) {
    return { workflowId: directWorkflowId, version: directVersion };
  }

  const structured = maybe.structuredContent as
    | {
        workflowId?: unknown;
        id?: unknown;
        workflow_id?: unknown;
        version?: unknown;
        latestVersion?: unknown;
        latest_version?: unknown;
        workflowVersion?: unknown;
      }
    | undefined;
  const structuredWorkflowId =
    (typeof structured?.workflowId === "string" && structured.workflowId) ||
    (typeof structured?.id === "string" && structured.id) ||
    (typeof structured?.workflow_id === "string" && structured.workflow_id) ||
    "";
  const structuredVersion = Number(
    structured?.version ?? structured?.latestVersion ?? structured?.latest_version ?? structured?.workflowVersion
  );
  if (structuredWorkflowId && Number.isFinite(structuredVersion) && structuredVersion > 0) {
    return { workflowId: structuredWorkflowId, version: structuredVersion };
  }

  const nestedCandidates = [maybe.workflow, maybe.data] as Array<unknown>;
  for (const candidate of nestedCandidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const nested = candidate as {
      workflowId?: unknown;
      id?: unknown;
      workflow_id?: unknown;
      version?: unknown;
      latestVersion?: unknown;
      latest_version?: unknown;
      workflowVersion?: unknown;
    };
    const nestedWorkflowId =
      (typeof nested.workflowId === "string" && nested.workflowId) ||
      (typeof nested.id === "string" && nested.id) ||
      (typeof nested.workflow_id === "string" && nested.workflow_id) ||
      "";
    const nestedVersion = Number(
      nested.version ?? nested.latestVersion ?? nested.latest_version ?? nested.workflowVersion
    );
    if (nestedWorkflowId && Number.isFinite(nestedVersion) && nestedVersion > 0) {
      return { workflowId: nestedWorkflowId, version: nestedVersion };
    }
  }

  const text = maybe.content?.find((entry) => entry.type === "text")?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as {
        workflowId?: unknown;
        id?: unknown;
        workflow_id?: unknown;
        version?: unknown;
        latestVersion?: unknown;
        latest_version?: unknown;
        workflowVersion?: unknown;
        workflow?: unknown;
        data?: unknown;
      };
      const parsedWorkflowId =
        (typeof parsed.workflowId === "string" && parsed.workflowId) ||
        (typeof parsed.id === "string" && parsed.id) ||
        (typeof parsed.workflow_id === "string" && parsed.workflow_id) ||
        "";
      const parsedVersion = Number(
        parsed.version ?? parsed.latestVersion ?? parsed.latest_version ?? parsed.workflowVersion
      );
      if (parsedWorkflowId && Number.isFinite(parsedVersion) && parsedVersion > 0) {
        return { workflowId: parsedWorkflowId, version: parsedVersion };
      }

      const nestedParsedCandidates = [parsed.workflow, parsed.data] as Array<unknown>;
      for (const candidate of nestedParsedCandidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const nested = candidate as {
          workflowId?: unknown;
          id?: unknown;
          workflow_id?: unknown;
          version?: unknown;
          latestVersion?: unknown;
          latest_version?: unknown;
          workflowVersion?: unknown;
        };
        const nestedWorkflowId =
          (typeof nested.workflowId === "string" && nested.workflowId) ||
          (typeof nested.id === "string" && nested.id) ||
          (typeof nested.workflow_id === "string" && nested.workflow_id) ||
          "";
        const nestedVersion = Number(
          nested.version ?? nested.latestVersion ?? nested.latest_version ?? nested.workflowVersion
        );
        if (nestedWorkflowId && Number.isFinite(nestedVersion) && nestedVersion > 0) {
          return { workflowId: nestedWorkflowId, version: nestedVersion };
        }
      }
    } catch {
      // handled below
    }
  }

  throw new Error("Invalid workflow version response from registry.");
}

function payloadErrorMessage(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const maybe = input as { error?: unknown; message?: unknown };
  if (typeof maybe.error === "string" && maybe.error.trim()) return maybe.error.trim();
  if (typeof maybe.message === "string" && maybe.message.trim()) return maybe.message.trim();
  return null;
}

function toObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractLlmExecution(output: unknown) {
  const payload = toObject(output);
  const meta = payload ? toObject(payload.llm_execution) : null;
  if (!meta) {
    return null;
  }
  return {
    provider: typeof meta.provider === "string" ? meta.provider : "unknown",
    model: typeof meta.model === "string" ? meta.model : "unknown",
    llmUsed: meta.llm_used === true,
    mockMode: meta.mock_mode === true,
    reason: typeof meta.reason === "string" ? meta.reason : ""
  };
}

function findNumericInRun(run: {
  steps: Array<{ output?: unknown }>;
}, key: string): number | null {
  for (const step of [...run.steps].reverse()) {
    const output = toObject(step.output);
    if (!output) continue;
    const value = Number(output[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function buildRunResult(run: {
  runId: string;
  status: string;
  error?: string;
  steps: Array<{ stepId: string; name: string; output?: unknown }>;
}) {
  const artifacts = run.steps
    .filter((step) => step.output != null)
    .map((step) => ({
      type: "step_output",
      stepId: step.stepId,
      stepName: step.name,
      payload: step.output
    }));

  const lastOutputStep = [...run.steps].reverse().find((step) => step.output != null);
  const lastOutput = toObject(lastOutputStep?.output);
  const businessSummary =
    (lastOutput && typeof lastOutput.summary === "string" && lastOutput.summary) ||
    (lastOutput && typeof lastOutput.markdown === "string" && lastOutput.markdown) ||
    run.error ||
    "No summary generated.";

  let primaryDecision: string | null = null;
  for (const step of [...run.steps].reverse()) {
    const output = toObject(step.output);
    if (!output) continue;
    const recommendation = toObject(output.finalRecommendation);
    if (typeof output.finalRecommendation === "string" && output.finalRecommendation.trim()) {
      primaryDecision = output.finalRecommendation;
      break;
    }
    if (recommendation && typeof recommendation.decision === "string" && recommendation.decision.trim()) {
      primaryDecision = recommendation.decision;
      break;
    }
    if (typeof output.recommendation === "string" && output.recommendation.trim()) {
      primaryDecision = output.recommendation;
      break;
    }
  }

  return {
    runId: run.runId,
    status: run.status,
    businessSummary,
    primaryDecision,
    costImpactUSD: findNumericInRun(run, "costImpactUSD"),
    riskScore: findNumericInRun(run, "riskScore"),
    artifacts
  };
}

function percentile(values: number[], p: number) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function applyAuditFilters(
  records: Array<Record<string, unknown>>,
  filters: { eventType?: string; provider?: string; model?: string; fallbackOnly?: boolean }
) {
  return records.filter((record) => {
    const inputs = toObject(record.inputs) ?? {};
    const output = toObject(record.output) ?? {};
    const provider = String(
      inputs.provider ??
        output.provider ??
        (toObject(output.llm_execution)?.provider ?? "")
    );
    const model = String(
      inputs.model ??
        output.model ??
        (toObject(output.llm_execution)?.model ?? "")
    );
    const eventType = String(inputs.eventType ?? output.eventType ?? output.eventCategory ?? "");
    const llmUsed = toObject(output.llm_execution)?.llm_used === true;
    const mockMode = toObject(output.llm_execution)?.mock_mode === true;
    const isFallback = mockMode || !llmUsed;

    if (filters.eventType && eventType !== filters.eventType) {
      return false;
    }
    if (filters.provider && provider !== filters.provider) {
      return false;
    }
    if (filters.model && model !== filters.model) {
      return false;
    }
    if (filters.fallbackOnly && !isFallback) {
      return false;
    }
    return true;
  });
}

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
app.use("/api/runs", runsRouter);
app.use("/api/war-room", warRoomRouter);

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

app.get("/workflows/draft", requireRoles("BUILDER", "OPERATOR"), (req, res) => {
  try {
    const row = db
      .prepare("SELECT draft_id, name, config_json, updated_at FROM workflow_drafts WHERE team_id = ? LIMIT 1")
      .get(req.user!.teamId) as
      | {
          draft_id: string;
          name: string;
          config_json: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      res.json({ draft: null });
      return;
    }

    res.json({
      draft: {
        id: row.draft_id,
        name: row.name,
        config: JSON.parse(row.config_json),
        updatedAt: row.updated_at
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load workflow draft" });
  }
});

app.post("/workflows/draft", requireRoles("BUILDER"), (req, res) => {
  const parsed = workflowDraftSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid workflow draft payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO workflow_drafts (team_id, draft_id, name, config_json, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET
        draft_id = excluded.draft_id,
        name = excluded.name,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
      `
    ).run(
      req.user!.teamId,
      parsed.data.id,
      parsed.data.name,
      JSON.stringify(parsed.data.config),
      req.user!.id,
      now
    );

    res.status(201).json({
      draft: {
        id: parsed.data.id,
        name: parsed.data.name,
        config: parsed.data.config,
        updatedAt: now
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save workflow draft" });
  }
});

app.post("/workflows/draft/:draftId/publish", requireRoles("BUILDER"), async (req, res) => {
  const payloadSchema = z.object({
    changelog: z.string().min(1).default("Publish draft")
  });

  const parsed = payloadSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid publish payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const row = db
      .prepare("SELECT draft_id, name, config_json FROM workflow_drafts WHERE team_id = ? LIMIT 1")
      .get(req.user!.teamId) as
      | {
          draft_id: string;
          name: string;
          config_json: string;
        }
      | undefined;

    if (!row) {
      res.status(404).json({ error: "Draft not found" });
      return;
    }

    if (row.draft_id !== req.params.draftId) {
      res.status(404).json({ error: "Draft ID mismatch for this team" });
      return;
    }

    const config = JSON.parse(row.config_json) as {
      id: string;
      name: string;
      description?: string;
      tools?: Array<{
        id: string;
        enabled: boolean;
        config: Record<string, unknown>;
      }>;
      graph?: {
        nodes: Array<{
          id: string;
          type: string;
          position: { x: number; y: number };
          config: Record<string, unknown>;
        }>;
        edges: Array<{ id: string; source: string; target: string }>;
      };
    };

    const compiled = compileWorkflowDraft(config);
    let publishResult: Record<string, unknown>;
    let usedCreateRetry = false;
    try {
      publishResult = await callMcpTool<Record<string, unknown>, Record<string, unknown>>("registry", "save_workflow_version", {
        teamId: req.user!.teamId,
        workflowId: config.id,
        name: config.name || row.name,
        description: config.description,
        changelog: parsed.data.changelog,
        createdBy: req.user!.id,
        steps: compiled.steps
      });
      const directError = payloadErrorMessage(publishResult);
      if (directError) {
        throw new Error(directError);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // New local drafts use temporary IDs that may not exist in registry yet.
      // Retry without workflowId to create the repository on first publish.
      if (!message.includes("unknown workflow")) {
        throw error;
      }
      usedCreateRetry = true;
      publishResult = await callMcpTool<Record<string, unknown>, Record<string, unknown>>("registry", "save_workflow_version", {
        teamId: req.user!.teamId,
        name: config.name || row.name,
        description: config.description,
        changelog: parsed.data.changelog,
        createdBy: req.user!.id,
        steps: compiled.steps
      });
      const retryError = payloadErrorMessage(publishResult);
      if (retryError) {
        throw new Error(retryError);
      }
    }
    let normalizedPublish: { workflowId: string; version: number };
    try {
      normalizedPublish = normalizePublishResult(publishResult);
    } catch {
      // Fallback: read the latest version directly if save response shape is non-standard.
      try {
        const fallbackLookupId = config.id;
        const latest = await callMcpTool<{ workflowId: string }, unknown>("registry", "get_workflow_version", {
          workflowId: fallbackLookupId
        });
        const latestError = payloadErrorMessage(latest);
        if (latestError) {
          throw new Error(latestError);
        }
        normalizedPublish = normalizeWorkflowVersionResult(latest);
      } catch {
        // Final fallback: derive latest version from workflow listing.
        const listed = await callMcpTool<{ teamId: string }, { workflows?: unknown[] }>("registry", "list_workflows", {
          teamId: req.user!.teamId
        });
        const listError = payloadErrorMessage(listed);
        if (listError) {
          throw new Error(listError);
        }
        const rows = (listed.workflows ?? []) as Array<Record<string, unknown>>;
        const byId = rows.find((entry) => {
          const row = entry as { workflowId?: unknown; id?: unknown };
          return row.workflowId === config.id || row.id === config.id;
        }) as
          | {
              workflowId?: unknown;
              id?: unknown;
              latestVersion?: unknown;
              latest_version?: unknown;
              version?: unknown;
              updatedAt?: unknown;
              updated_at?: unknown;
            }
          | undefined;

        const byName = rows.find((entry) => {
          const row = entry as { name?: unknown };
          return typeof row.name === "string" && row.name === (config.name || row.name);
        }) as
          | {
              workflowId?: unknown;
              id?: unknown;
              latestVersion?: unknown;
              latest_version?: unknown;
              version?: unknown;
              updatedAt?: unknown;
              updated_at?: unknown;
            }
          | undefined;

        const byRecent = [...rows]
          .sort((a, b) => {
            const aTs = Date.parse(String(a.updatedAt ?? a.updated_at ?? ""));
            const bTs = Date.parse(String(b.updatedAt ?? b.updated_at ?? ""));
            if (Number.isNaN(aTs) && Number.isNaN(bTs)) return 0;
            if (Number.isNaN(aTs)) return 1;
            if (Number.isNaN(bTs)) return -1;
            return bTs - aTs;
          })
          .find((entry) => {
            const version = Number(entry.latestVersion ?? entry.latest_version ?? entry.version);
            const workflowId =
              (typeof entry.workflowId === "string" && entry.workflowId) ||
              (typeof entry.id === "string" && entry.id) ||
              "";
            return workflowId && Number.isFinite(version) && version > 0;
          }) as
          | {
              workflowId?: unknown;
              id?: unknown;
              latestVersion?: unknown;
              latest_version?: unknown;
              version?: unknown;
            }
          | undefined;

        const match = byId ?? (usedCreateRetry ? byName ?? byRecent : undefined);
        const fallbackWorkflowId =
          (typeof match?.workflowId === "string" && match.workflowId) ||
          (typeof match?.id === "string" && match.id) ||
          (usedCreateRetry ? "" : config.id);
        const fallbackVersion = Number(
          match?.latestVersion ?? match?.latest_version ?? match?.version ?? (usedCreateRetry ? 1 : NaN)
        );
        if (!Number.isFinite(fallbackVersion) || fallbackVersion <= 0) {
          throw new Error("Invalid workflow version response from registry.");
        }
        if (!fallbackWorkflowId) {
          throw new Error("Invalid workflow version response from registry.");
        }
        normalizedPublish = { workflowId: fallbackWorkflowId, version: fallbackVersion };
      }
    }

    res.status(201).json({
      ...publishResult,
      workflowId: normalizedPublish.workflowId,
      version: normalizedPublish.version,
      sourceDraftId: row.draft_id
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to publish draft";
    if (message.startsWith("Graph ") || message.startsWith("Draft ") || message.startsWith("Cannot publish")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.post("/workflows/draft/generate", requireRoles("BUILDER"), async (req, res) => {
  const parsed = DraftGenerateInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid draft generation payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const repoId = parsed.data.currentConfig?.id;
    const teamSettings = getTeamSettingsForServer(req.user!.teamId, repoId);
    const generated = await generateWorkflowDraft(parsed.data, teamSettings);
    res.status(201).json(generated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate draft" });
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

app.get("/workflows/:workflowId/suggestions", requireRoles("BUILDER", "OPERATOR", "APPROVER", "AUDITOR", "ADMIN"), (req, res) => {
  const workflowId = String(req.params.workflowId ?? "").trim();
  if (!workflowId) {
    res.status(400).json({ error: "Missing workflowId" });
    return;
  }

  try {
    const rows = db
      .prepare(
        `
        SELECT id, workflow_id, author_user_id, author_username, author_role, body, created_at
        FROM workflow_suggestions
        WHERE team_id = ? AND workflow_id = ?
        ORDER BY created_at DESC
        `
      )
      .all(req.user!.teamId, workflowId) as Array<{
      id: string;
      workflow_id: string;
      author_user_id: string;
      author_username: string;
      author_role: string;
      body: string;
      created_at: string;
    }>;

    res.json({
      suggestions: rows.map((row) => ({
        id: row.id,
        workflowId: row.workflow_id,
        authorUserId: row.author_user_id,
        authorUsername: row.author_username,
        authorRole: row.author_role,
        body: row.body,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to list workflow suggestions" });
  }
});

const workflowSuggestionSchema = z.object({
  body: z.string().min(1).max(2000)
});

app.post("/workflows/:workflowId/suggestions", requireRoles("BUILDER", "OPERATOR", "APPROVER", "AUDITOR", "ADMIN"), (req, res) => {
  const workflowId = String(req.params.workflowId ?? "").trim();
  if (!workflowId) {
    res.status(400).json({ error: "Missing workflowId" });
    return;
  }
  const parsed = workflowSuggestionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid suggestion payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const now = new Date().toISOString();
    const id = `ws_${randomUUID()}`;
    db.prepare(
      `
      INSERT INTO workflow_suggestions (id, team_id, workflow_id, author_user_id, author_username, author_role, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      id,
      req.user!.teamId,
      workflowId,
      req.user!.id,
      req.user!.username,
      req.user!.role,
      parsed.data.body.trim(),
      now
    );
    res.status(201).json({
      suggestion: {
        id,
        workflowId,
        authorUserId: req.user!.id,
        authorUsername: req.user!.username,
        authorRole: req.user!.role,
        body: parsed.data.body.trim(),
        createdAt: now
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save workflow suggestion" });
  }
});

app.get("/workflows/:workflowId/change-requests", requireRoles("BUILDER", "OPERATOR", "APPROVER", "AUDITOR", "ADMIN"), (req, res) => {
  const workflowId = String(req.params.workflowId ?? "").trim();
  if (!workflowId) {
    res.status(400).json({ error: "Missing workflowId" });
    return;
  }
  try {
    const rows = db
      .prepare(
        `
        SELECT id, workflow_id, title, body, status, author_user_id, author_username, author_role, proposed_config_json,
               reviewed_by_user_id, reviewed_at, created_at, updated_at
        FROM workflow_change_requests
        WHERE team_id = ? AND workflow_id = ?
        ORDER BY created_at DESC
        `
      )
      .all(req.user!.teamId, workflowId) as Array<{
      id: string;
      workflow_id: string;
      title: string;
      body: string;
      status: string;
      author_user_id: string;
      author_username: string;
      author_role: string;
      proposed_config_json: string | null;
      reviewed_by_user_id: string | null;
      reviewed_at: string | null;
      created_at: string;
      updated_at: string;
    }>;

    res.json({
      changeRequests: rows.map((row) => ({
        id: row.id,
        workflowId: row.workflow_id,
        title: row.title,
        body: row.body,
        status: row.status,
        authorUserId: row.author_user_id,
        authorUsername: row.author_username,
        authorRole: row.author_role,
        proposedConfig: row.proposed_config_json ? JSON.parse(row.proposed_config_json) : null,
        reviewedByUserId: row.reviewed_by_user_id,
        reviewedAt: row.reviewed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to list workflow change requests" });
  }
});

const workflowChangeRequestCreateSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  proposedConfig: z.record(z.any()).optional().nullable()
});

app.post("/workflows/:workflowId/change-requests", requireRoles("BUILDER", "OPERATOR", "APPROVER", "AUDITOR", "ADMIN"), (req, res) => {
  const workflowId = String(req.params.workflowId ?? "").trim();
  if (!workflowId) {
    res.status(400).json({ error: "Missing workflowId" });
    return;
  }
  const parsed = workflowChangeRequestCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid change request payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const now = new Date().toISOString();
    const id = `wcr_${randomUUID()}`;
    db.prepare(
      `
      INSERT INTO workflow_change_requests (
        id, team_id, workflow_id, title, body, status,
        author_user_id, author_username, author_role, proposed_config_json,
        reviewed_by_user_id, reviewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      id,
      req.user!.teamId,
      workflowId,
      parsed.data.title.trim(),
      parsed.data.body.trim(),
      "OPEN",
      req.user!.id,
      req.user!.username,
      req.user!.role,
      parsed.data.proposedConfig ? JSON.stringify(parsed.data.proposedConfig) : null,
      null,
      null,
      now,
      now
    );

    res.status(201).json({
      changeRequest: {
        id,
        workflowId,
        title: parsed.data.title.trim(),
        body: parsed.data.body.trim(),
        status: "OPEN",
        authorUserId: req.user!.id,
        authorUsername: req.user!.username,
        authorRole: req.user!.role,
        proposedConfig: parsed.data.proposedConfig ?? null,
        reviewedByUserId: null,
        reviewedAt: null,
        createdAt: now,
        updatedAt: now
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create workflow change request" });
  }
});

const workflowChangeRequestStatusSchema = z.object({
  status: z.enum(["OPEN", "ACCEPTED", "REJECTED", "MERGED"])
});

app.post("/workflows/:workflowId/change-requests/:changeRequestId/status", requireRoles("BUILDER", "ADMIN"), (req, res) => {
  const workflowId = String(req.params.workflowId ?? "").trim();
  const changeRequestId = String(req.params.changeRequestId ?? "").trim();
  if (!workflowId || !changeRequestId) {
    res.status(400).json({ error: "Missing workflowId or changeRequestId" });
    return;
  }
  const parsed = workflowChangeRequestStatusSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid status payload", details: parsed.error.flatten() });
    return;
  }
  try {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `
        UPDATE workflow_change_requests
        SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ? AND team_id = ? AND workflow_id = ?
        `
      )
      .run(parsed.data.status, req.user!.id, now, now, changeRequestId, req.user!.teamId, workflowId);
    if ((result.changes ?? 0) < 1) {
      res.status(404).json({ error: "Change request not found" });
      return;
    }
    res.json({ ok: true, status: parsed.data.status, reviewedAt: now, reviewedByUserId: req.user!.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update change request status" });
  }
});

app.delete("/workflows/:workflowId", requireRoles("BUILDER"), async (req, res) => {
  const workflowId = String(req.params.workflowId ?? "").trim();
  if (!workflowId) {
    res.status(400).json({ error: "Missing workflowId" });
    return;
  }

  try {
    const payload = await callMcpTool<
      { teamId: string; workflowId: string },
      { ok: boolean; workflowId: string; name?: string; deletedVersions?: number }
    >("registry", "delete_workflow", {
      teamId: req.user!.teamId,
      workflowId
    });

    db.prepare("DELETE FROM repo_settings WHERE team_id = ? AND repo_id = ?").run(req.user!.teamId, workflowId);
    db.prepare("DELETE FROM approvals WHERE team_id = ? AND workflow_id = ?").run(req.user!.teamId, workflowId);
    db.prepare("DELETE FROM workflow_drafts WHERE team_id = ? AND draft_id = ?").run(req.user!.teamId, workflowId);
    db.prepare("DELETE FROM workflow_suggestions WHERE team_id = ? AND workflow_id = ?").run(req.user!.teamId, workflowId);
    db.prepare("DELETE FROM workflow_change_requests WHERE team_id = ? AND workflow_id = ?").run(req.user!.teamId, workflowId);

    res.json({
      ok: payload.ok,
      workflowId: payload.workflowId,
      name: payload.name ?? null,
      deletedVersions: payload.deletedVersions ?? 0
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to delete workflow";
    if (message.includes("not found")) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.status(500).json({ error: "Failed to delete workflow" });
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
      kind: z.enum(["AGENT", "APPROVAL", "ROUTER"]),
      agentName: z.string().optional(),
      params: z.record(z.any()).default({})
    })
  )
});

const workflowDraftSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  config: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    agentType: z.string().min(1),
    llmProvider: z.string().min(1),
    llmModel: z.string().min(1),
    tools: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        category: z.string().min(1),
        enabled: z.boolean(),
        config: z.record(z.any())
      })
    ),
    graph: z
      .object({
        nodes: z.array(
          z.object({
            id: z.string().min(1),
            type: z.string().min(1),
            position: z.object({ x: z.number(), y: z.number() }),
            config: z.record(z.any())
          })
        ),
        edges: z.array(
          z.object({
            id: z.string().min(1),
            source: z.string().min(1),
            target: z.string().min(1)
          })
        )
      })
      .optional()
  })
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

app.post("/runs", requireRoles("OPERATOR", "BUILDER"), async (req, res) => {
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
    const message = error instanceof Error ? error.message : "Failed to execute run";
    if (message.includes("Workflow version not found")) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.startsWith("Allowlist violation:")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
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

app.get("/runs/:runId/report", async (req, res) => {
  try {
    const run = await orchestrator.getRun(req.params.runId, req.user!.teamId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const executedSteps = run.steps.filter((step) => step.status !== "PENDING");
    const approvalsTriggered = new Set(run.steps.map((step) => step.approvalId).filter(Boolean)).size;
    const finalStepWithOutput = [...run.steps].reverse().find((step) => Boolean(step.output));
    const finalDecision =
      (finalStepWithOutput?.output &&
      typeof finalStepWithOutput.output === "object" &&
      finalStepWithOutput.output !== null &&
      typeof (finalStepWithOutput.output as Record<string, unknown>).decision === "string"
        ? String((finalStepWithOutput.output as Record<string, unknown>).decision)
        : undefined) ?? null;
    const confidence =
      [...run.steps].reverse().find((step) => typeof step.confidence === "number")?.confidence ?? null;

    res.json({
      run,
      report: {
        runId: run.runId,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.completedAt ?? run.updatedAt,
        totalSteps: run.steps.length,
        executedSteps: executedSteps.length,
        approvalsTriggered,
        finalDecision,
        confidence
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load run report" });
  }
});

app.post("/runs/:runId/overall-review", async (req, res) => {
  const requestSchema = z.object({
    repoId: z.string().min(1).optional()
  });
  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid overall review payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const run = await orchestrator.getRun(req.params.runId, req.user!.teamId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const settings = getTeamSettingsForServer(req.user!.teamId, parsed.data.repoId);
    const model = settings.defaultProvider === "openai" ? settings.defaultModel : "gpt-4.1-mini";
    const apiKey = settings.keys.openai;
    const steps = run.steps.map((step, index) => ({
      index: index + 1,
      name: step.name,
      kind: step.kind,
      status: step.status,
      agentName: step.agentName,
      confidence: step.confidence ?? null,
      rationale: step.rationale ?? null,
      output: step.output ?? null
    }));

    const deterministicFallback = (() => {
      const doneSteps = run.steps.filter((step) => step.status !== "PENDING").length;
      const finalDecision = [...run.steps]
        .reverse()
        .find((step) => step.output && typeof step.output === "object" && step.output !== null)?.output as
        | Record<string, unknown>
        | undefined;
      const decision = typeof finalDecision?.decision === "string" ? finalDecision.decision : null;
      const confidence =
        [...run.steps].reverse().find((step) => typeof step.confidence === "number")?.confidence ?? null;
      const firstSentence = `This run completed with status ${run.status} after ${doneSteps} executed step${doneSteps === 1 ? "" : "s"}.`;
      const secondSentence = decision
        ? `The final decision was ${decision}${typeof confidence === "number" ? ` with confidence ${confidence.toFixed(2)}` : ""}.`
        : typeof confidence === "number"
          ? `The final confidence reported was ${confidence.toFixed(2)}.`
          : "No final decision was reported.";
      return `${firstSentence} ${secondSentence}`;
    })();

    if (!apiKey) {
      res.json({
        provider: "openai",
        model,
        mockMode: true,
        overallReview: deterministicFallback
      });
      return;
    }

    const llmObject = await askProviderForObject({
      provider: "openai",
      model,
      apiKey,
      systemPrompt: [
        "You are an operations analyst writing for non-technical users.",
        "Write 2-4 direct sentences in plain English.",
        "State what happened, the key result/decision, confidence, and one concrete next action.",
        "Do not use generic filler or marketing language.",
        "Do not mention model, provider, or internal system details.",
        'Return strict JSON with exactly one key: {"overallReview":"..."}'
      ].join("\n"),
      prompt: [
        `Run metadata: ${JSON.stringify({
          runId: run.runId,
          workflowName: run.workflowName,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.completedAt ?? run.updatedAt
        })}`,
        `Steps: ${JSON.stringify(steps).slice(0, 14000)}`
      ].join("\n\n")
    });

    const overallReview =
      llmObject && typeof llmObject.overallReview === "string" && llmObject.overallReview.trim()
        ? llmObject.overallReview.trim()
        : deterministicFallback;

    res.json({
      provider: "openai",
      model,
      mockMode: overallReview === deterministicFallback,
      overallReview
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate overall review" });
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
    const repoId = req.query.repoId ? String(req.query.repoId) : undefined;
    const settings = getTeamSettingsForClient(req.user!.teamId, repoId);
    res.json(settings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

const settingsKeySchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini"]),
  key: z.string().min(1),
  repoId: z.string().min(1).optional()
});

function validateProviderKeyFormat(provider: "openai" | "anthropic" | "gemini", rawKey: string) {
  const key = rawKey.trim();
  if (!key) {
    return "Key cannot be empty.";
  }
  if (key.toUpperCase().startsWith("MAST")) {
    return "This looks like MASTER_KEY, not a provider API key.";
  }
  if (provider === "openai" && !key.startsWith("sk-")) {
    return "OpenAI API keys should start with 'sk-'.";
  }
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) {
    return "Anthropic API keys should start with 'sk-ant-'.";
  }
  if (provider === "gemini" && !key.startsWith("AIza")) {
    return "Gemini API keys typically start with 'AIza'.";
  }
  return "";
}

app.post("/settings/key", requireRoles("BUILDER"), (req, res) => {
  const parsed = settingsKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid key payload", details: parsed.error.flatten() });
    return;
  }
  const formatError = validateProviderKeyFormat(parsed.data.provider, parsed.data.key);
  if (formatError) {
    res.status(400).json({ error: formatError });
    return;
  }

  try {
    saveProviderKey(req.user!.teamId, parsed.data.provider, parsed.data.key, parsed.data.repoId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save provider key" });
  }
});

const settingsDefaultsSchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini"]),
  model: z.string().min(1),
  repoId: z.string().min(1).optional()
});

app.post("/settings/defaults", requireRoles("BUILDER"), (req, res) => {
  const parsed = settingsDefaultsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid defaults payload", details: parsed.error.flatten() });
    return;
  }

  try {
    updateProviderDefaults(req.user!.teamId, parsed.data.provider, parsed.data.model, parsed.data.repoId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update defaults" });
  }
});

const settingsTestSchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini"]).optional(),
  model: z.string().optional(),
  repoId: z.string().min(1).optional()
});

app.post("/settings/test", requireRoles("BUILDER"), async (req, res) => {
  const parsed = settingsTestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid test payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const settings = getTeamSettingsForServer(req.user!.teamId, parsed.data.repoId);
    const provider = parsed.data.provider ?? settings.defaultProvider;
    const model = parsed.data.model ?? settings.defaultModel;
    const apiKey = settings.keys[provider];
    if (!apiKey) {
      res.status(400).json({ ok: false, mockMode: true, message: `No ${provider} API key is configured for this scope.` });
      return;
    }
    const formatError = validateProviderKeyFormat(provider, apiKey);
    if (formatError) {
      res.status(400).json({ ok: false, mockMode: true, message: formatError });
      return;
    }
    const result = await testProviderConnection({ provider, model, apiKey });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to test provider connection" });
  }
});

const settingsExternalDbSchema = z.object({
  url: z.string().default(""),
  repoId: z.string().min(1).optional()
});

app.post("/settings/external-db", requireRoles("BUILDER"), (req, res) => {
  const parsed = settingsExternalDbSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid external DB payload", details: parsed.error.flatten() });
    return;
  }

  try {
    saveExternalDbUrl(req.user!.teamId, parsed.data.url, parsed.data.repoId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save external DB URL" });
  }
});

app.post("/settings/external-db/test", requireRoles("BUILDER"), async (req, res) => {
  const overrideSchema = z.object({
    url: z.string().optional(),
    repoId: z.string().min(1).optional()
  });
  const parsed = overrideSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid external DB test payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const settings = getTeamSettingsForServer(req.user!.teamId, parsed.data.repoId);
    const connectionString = parsed.data.url?.trim() || settings.externalDbUrl || process.env.EXTERNAL_DB_URL || "";
    if (!connectionString) {
      res.status(400).json({ ok: false, message: "No external DB URL configured." });
      return;
    }

    const probe = await executeReadOnlyExternalQuery({
      connectionString,
      query: "SELECT 1 AS ok",
      maxRows: 1
    });
    res.json({
      ok: true,
      engine: probe.engine,
      message: `Connected successfully via ${probe.engine}.`
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Connection test failed";
    res.status(500).json({ ok: false, message });
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

const procurementScanSchema = z.object({
  threshold: z.number().int().positive().optional(),
  targetQty: z.number().int().positive().optional()
});

app.get("/procurement/po", async (req, res) => {
  try {
    const rows = db
      .prepare(
        `
        SELECT id, team_id, run_id, workflow_id, vendor_id, part_id, qty, status, draft_payload_json, created_at, updated_at
        FROM purchase_orders
        WHERE team_id = ?
        ORDER BY updated_at DESC
        `
      )
      .all(req.user!.teamId) as Array<{
      id: string;
      team_id: string;
      run_id: string | null;
      workflow_id: string | null;
      vendor_id: string;
      part_id: string;
      qty: number;
      status: string;
      draft_payload_json: string | null;
      created_at: string;
      updated_at: string;
    }>;
    res.json({
      purchaseOrders: rows.map((row) => ({
        id: row.id,
        teamId: row.team_id,
        runId: row.run_id,
        workflowId: row.workflow_id,
        vendorId: row.vendor_id,
        partId: row.part_id,
        qty: row.qty,
        status: row.status,
        draftPayload: row.draft_payload_json ? JSON.parse(row.draft_payload_json) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to list purchase orders" });
  }
});

app.post("/procurement/scan", requireRoles("OPERATOR", "BUILDER"), async (req, res) => {
  const parsed = procurementScanSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid procurement scan payload", details: parsed.error.flatten() });
    return;
  }
  try {
    let runId: string | null = null;
    try {
      const workflowsPayload = await callMcpTool<{ teamId: string }, { workflows: Array<{ workflowId: string; name: string }> }>(
        "registry",
        "list_workflows",
        { teamId: req.user!.teamId }
      );
      const procurementWorkflow = (workflowsPayload.workflows ?? []).find((workflow) => workflow.name === "Procurement Scan");
      if (procurementWorkflow?.workflowId) {
        const run = await orchestrator.startRun({
          actor: {
            userId: req.user!.id,
            username: req.user!.username,
            teamId: req.user!.teamId
          },
          workflowId: procurementWorkflow.workflowId
        });
        runId = run.runId;
      }
    } catch {
      runId = null;
    }

    const threshold = parsed.data.threshold ?? 20;
    const targetQty = parsed.data.targetQty ?? 100;
    const rows = db
      .prepare("SELECT sku, on_hand, reserved FROM inventory WHERE (on_hand - reserved) < ? ORDER BY sku")
      .all(threshold) as Array<{ sku: string; on_hand: number; reserved: number }>;

    const now = new Date().toISOString();
    const created: Array<Record<string, unknown>> = [];
    const tx = db.transaction(() => {
      for (const row of rows) {
        const available = Math.max(0, row.on_hand - row.reserved);
        const qty = Math.max(1, targetQty - available);
        const poId = `po_${randomUUID()}`;
        const vendorId = available < threshold / 2 ? "SUP-01" : "SUP-03";
        const payload = {
          reason: "Inventory below threshold",
          available,
          threshold,
          suggestedVendor: vendorId
        };
        db.prepare(
          `
          INSERT INTO purchase_orders (id, team_id, run_id, workflow_id, vendor_id, part_id, qty, status, draft_payload_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          poId,
          req.user!.teamId,
          runId,
          "wf_procurement_scan",
          vendorId,
          row.sku,
          qty,
          "DRAFT",
          JSON.stringify(payload),
          now,
          now
        );
        created.push({
          id: poId,
          vendorId,
          partId: row.sku,
          qty,
          status: "DRAFT",
          draftPayload: payload
        });
      }
    });
    tx();

    res.status(201).json({
      workflowId: "wf_procurement_scan",
      runId,
      createdDraftPos: created
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed procurement scan" });
  }
});

app.post("/procurement/po/:id/request-approval", requireRoles("OPERATOR", "BUILDER"), async (req, res) => {
  const poId = String(req.params.id ?? "").trim();
  if (!poId) {
    res.status(400).json({ error: "Missing PO id" });
    return;
  }
  try {
    const po = db
      .prepare("SELECT * FROM purchase_orders WHERE id = ? AND team_id = ? LIMIT 1")
      .get(poId, req.user!.teamId) as
      | {
          id: string;
          workflow_id: string | null;
          part_id: string;
          vendor_id: string;
          qty: number;
          status: string;
        }
      | undefined;
    if (!po) {
      res.status(404).json({ error: "PO not found" });
      return;
    }
    const now = new Date().toISOString();
    const approvalId = `apr_${randomUUID()}`;
    db.prepare(
      `
      INSERT INTO approvals (id, team_id, run_id, workflow_id, step_id, step_name, kind, status, context_json, requested_by, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      approvalId,
      req.user!.teamId,
      `proc_${poId}`,
      po.workflow_id ?? "wf_procurement_scan",
      poId,
      "Procurement PO Approval",
      "PROCUREMENT_PO",
      "PENDING",
      JSON.stringify({ poId, partId: po.part_id, vendorId: po.vendor_id, qty: po.qty }),
      req.user!.id,
      now
    );
    db.prepare("UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?").run("PENDING_APPROVAL", now, poId);
    res.json({ approvalId, poId, status: "PENDING_APPROVAL" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to request PO approval" });
  }
});

const poDecisionSchema = z.object({
  comment: z.string().optional()
});

app.post("/procurement/po/:id/approve", requireRoles("APPROVER", "ADMIN"), async (req, res) => {
  const parsed = poDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid approval payload", details: parsed.error.flatten() });
    return;
  }
  const poId = String(req.params.id ?? "").trim();
  try {
    const now = new Date().toISOString();
    const approval = db
      .prepare("SELECT * FROM approvals WHERE step_id = ? AND team_id = ? AND status = 'PENDING' ORDER BY requested_at DESC LIMIT 1")
      .get(poId, req.user!.teamId) as { id: string } | undefined;
    if (!approval) {
      res.status(404).json({ error: "Pending approval not found for PO" });
      return;
    }
    db.prepare("UPDATE approvals SET status = 'APPROVED', decided_by = ?, decided_at = ?, decision_comment = ? WHERE id = ?").run(
      req.user!.id,
      now,
      parsed.data.comment ?? null,
      approval.id
    );
    db.prepare("UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ? AND team_id = ?").run(
      "APPROVED",
      now,
      poId,
      req.user!.teamId
    );
    res.json({ poId, status: "APPROVED" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to approve PO" });
  }
});

app.post("/procurement/po/:id/reject", requireRoles("APPROVER", "ADMIN"), async (req, res) => {
  const parsed = poDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid reject payload", details: parsed.error.flatten() });
    return;
  }
  const poId = String(req.params.id ?? "").trim();
  try {
    const now = new Date().toISOString();
    const approval = db
      .prepare("SELECT * FROM approvals WHERE step_id = ? AND team_id = ? AND status = 'PENDING' ORDER BY requested_at DESC LIMIT 1")
      .get(poId, req.user!.teamId) as { id: string } | undefined;
    if (!approval) {
      res.status(404).json({ error: "Pending approval not found for PO" });
      return;
    }
    db.prepare("UPDATE approvals SET status = 'REJECTED', decided_by = ?, decided_at = ?, decision_comment = ? WHERE id = ?").run(
      req.user!.id,
      now,
      parsed.data.comment ?? null,
      approval.id
    );
    db.prepare("UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ? AND team_id = ?").run(
      "REJECTED",
      now,
      poId,
      req.user!.teamId
    );
    res.json({ poId, status: "REJECTED" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to reject PO" });
  }
});

app.post("/procurement/po/:id/submit-to-vendor", requireRoles("OPERATOR", "BUILDER"), async (req, res) => {
  const poId = String(req.params.id ?? "").trim();
  try {
    const po = db
      .prepare("SELECT * FROM purchase_orders WHERE id = ? AND team_id = ? LIMIT 1")
      .get(poId, req.user!.teamId) as
      | {
          id: string;
          vendor_id: string;
          part_id: string;
          qty: number;
          status: string;
        }
      | undefined;
    if (!po) {
      res.status(404).json({ error: "PO not found" });
      return;
    }
    if (po.status !== "APPROVED") {
      res.status(400).json({ error: "PO must be APPROVED before vendor submission" });
      return;
    }
    const now = new Date().toISOString();
    const vendorOrderId = `vo_${randomUUID()}`;
    db.prepare("INSERT INTO mock_vendor_orders (id, po_id, vendor_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
      vendorOrderId,
      poId,
      po.vendor_id,
      JSON.stringify({ poId, vendorId: po.vendor_id, partId: po.part_id, qty: po.qty }),
      now
    );
    db.prepare("UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?").run("CONFIRMED", now, poId);
    res.json({ poId, vendorOrderId, status: "CONFIRMED" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to submit PO to vendor" });
  }
});

app.post("/procurement/po/:id/advance-status", requireRoles("OPERATOR", "BUILDER"), async (req, res) => {
  const poId = String(req.params.id ?? "").trim();
  try {
    const po = db
      .prepare("SELECT id, status FROM purchase_orders WHERE id = ? AND team_id = ? LIMIT 1")
      .get(poId, req.user!.teamId) as { id: string; status: string } | undefined;
    if (!po) {
      res.status(404).json({ error: "PO not found" });
      return;
    }

    const transitions: Record<string, string> = {
      CONFIRMED: "SHIPPED",
      SHIPPED: "RECEIVED",
      RECEIVED: "CLOSED"
    };
    const next = transitions[po.status];
    if (!next) {
      res.status(400).json({ error: `Cannot advance status from ${po.status}` });
      return;
    }
    db.prepare("UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?").run(next, new Date().toISOString(), poId);
    res.json({ poId, status: next });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to advance PO status" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`api listening on http://localhost:${PORT}`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`api failed to start: port ${PORT} is already in use. Stop the existing API process, then retry.`);
    process.exit(1);
    return;
  }
  console.error("api failed to start:", error.message);
  process.exit(1);
});
