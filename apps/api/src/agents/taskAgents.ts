import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import * as providerClient from "../lib/providers";
import type { ServerTeamSettings } from "../lib/settings";
import { db } from "../lib/db";
import { executeExternalQuery, executeReadOnlyExternalQuery } from "../lib/externalDb";
import { buildCmapssFeatures, loadCmapssDataset } from "../lib/cmapss";
import {
  DebateOutputSchema,
  DEFAULT_MODELS,
  type DebateNodeConfig,
  type DebateStance,
  type Provider
} from "@agentfoundry/shared";
import { resolveTemplates } from "../lib/template";

type TaskResult = {
  output: Record<string, unknown>;
  confidence: number;
  rationale: string;
  toolCalls: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
  mockMode: boolean;
};

function destinationToRegion(destination: string): string {
  const normalized = destination.toLowerCase();
  if (normalized.includes("indianapolis") || normalized.includes("chicago")) {
    return "US-MW";
  }
  if (normalized.includes("nashville") || normalized.includes("atlanta")) {
    return "US-SE";
  }
  return "APAC";
}

function toNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function isProvider(value: unknown): value is Provider {
  return value === "openai" || value === "anthropic" || value === "gemini";
}

function isDebateStance(value: unknown): value is DebateStance {
  return value === "APPROVE" || value === "BLOCK" || value === "CONDITIONAL";
}

function sanitizeStringArray(input: unknown) {
  if (!Array.isArray(input)) {
    return [] as string[];
  }
  return input
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function normalizeActionToken(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\s+/g, "_").toUpperCase();
}

function hasDbUpdateSignal(output: Record<string, unknown>) {
  const status = typeof output.status === "string" ? output.status.toLowerCase() : "";
  const dbTarget = typeof output.db_target === "string" ? output.db_target.trim() : "";
  const insertId = typeof output.insert_id === "string" ? output.insert_id.trim() : "";
  return (status === "inserted" && Boolean(dbTarget)) || Boolean(insertId);
}

function renderPromptTemplate(template: string, runContext: Record<string, unknown>) {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => {
    const raw = runContext[key];
    if (raw === null || raw === undefined) {
      return "";
    }
    if (typeof raw === "object") {
      try {
        return JSON.stringify(raw);
      } catch {
        return "";
      }
    }
    return String(raw);
  });
}

function findStepOutputByPredicate(
  runContext: Record<string, unknown>,
  predicate: (output: Record<string, unknown>) => boolean
) {
  const steps = runContext.steps;
  if (!steps || typeof steps !== "object") {
    return null;
  }
  const values = Object.values(steps as Record<string, unknown>);
  for (let idx = values.length - 1; idx >= 0; idx -= 1) {
    const candidate = values[idx];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const output = (candidate as { output?: unknown }).output;
    if (!output || typeof output !== "object" || Array.isArray(output)) {
      continue;
    }
    if (predicate(output as Record<string, unknown>)) {
      return output as Record<string, unknown>;
    }
  }
  return null;
}

function buildSummarySource(runContext: Record<string, unknown>) {
  const stepsValue = runContext.steps;
  const stepEntries =
    stepsValue && typeof stepsValue === "object"
      ? Object.entries(stepsValue as Record<string, unknown>)
          .map(([stepId, value]) => {
            const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
            const output = item.output && typeof item.output === "object" ? (item.output as Record<string, unknown>) : null;
            return {
              stepId,
              status: typeof item.status === "string" ? item.status : "UNKNOWN",
              output
            };
          })
          .slice(-8)
      : [];

  const findingKeys = [
    "primary_issue",
    "confidence",
    "decision",
    "finalRecommendation",
    "recommended_actions",
    "top_anomalies",
    "dataset",
    "unit_id",
    "status",
    "error"
  ];

  const findings: Record<string, unknown> = {};
  for (const entry of stepEntries) {
    if (!entry.output) {
      continue;
    }
    for (const key of findingKeys) {
      if (key in entry.output && findings[key] === undefined) {
        findings[key] = entry.output[key];
      }
    }
    if (entry.output.incident && typeof entry.output.incident === "object") {
      const incident = entry.output.incident as Record<string, unknown>;
      if (findings.dataset === undefined && typeof incident.dataset === "string") {
        findings.dataset = incident.dataset;
      }
      if (findings.unit_id === undefined && typeof incident.unit_id === "number") {
        findings.unit_id = incident.unit_id;
      }
    }
  }

  return {
    runId: runContext.runId ?? null,
    workflowId: runContext.workflowId ?? null,
    lastSummary: runContext.lastSummary ?? null,
    lastOutput:
      runContext.lastOutput && typeof runContext.lastOutput === "object"
        ? (runContext.lastOutput as Record<string, unknown>)
        : runContext.lastOutput ?? null,
    findings,
    recentSteps: stepEntries.map((entry) => ({
      stepId: entry.stepId,
      status: entry.status,
      output: entry.output
    }))
  };
}

async function insertIncidentPostgres(input: {
  connectionString: string;
  incident: Record<string, unknown>;
}) {
  const moduleName = "pg";
  const pg = (await import(moduleName)) as { Pool: new (args: Record<string, unknown>) => any };
  const pool = new pg.Pool({
    connectionString: input.connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000
  });
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 10000");
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS engine_incidents (
        incident_id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        dataset TEXT NOT NULL,
        unit_id INTEGER NOT NULL,
        primary_issue TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        hypotheses_json JSONB NOT NULL,
        recommended_actions_json JSONB NOT NULL,
        top_anomalies_json JSONB NOT NULL,
        raw_feature_summary_json JSONB NOT NULL
      )
    `);
    await client.query(
      `
      INSERT INTO engine_incidents (
        incident_id,
        created_at,
        dataset,
        unit_id,
        primary_issue,
        confidence,
        hypotheses_json,
        recommended_actions_json,
        top_anomalies_json,
        raw_feature_summary_json
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb)
      `,
      [
        String(input.incident.incident_id),
        String(input.incident.created_at),
        String(input.incident.dataset),
        Number(input.incident.unit_id),
        String(input.incident.primary_issue),
        Number(input.incident.confidence),
        JSON.stringify(input.incident.hypotheses_json ?? []),
        JSON.stringify(input.incident.recommended_actions_json ?? []),
        JSON.stringify(input.incident.top_anomalies_json ?? []),
        JSON.stringify(input.incident.raw_feature_summary_json ?? {})
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function insertIncidentSqlite(input: {
  sqlitePath: string;
  incident: Record<string, unknown>;
}) {
  const filePath = path.resolve(input.sqlitePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fileDb = new Database(filePath);
  try {
    fileDb.exec(`
      CREATE TABLE IF NOT EXISTS engine_incidents (
        incident_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        dataset TEXT NOT NULL,
        unit_id INTEGER NOT NULL,
        primary_issue TEXT NOT NULL,
        confidence REAL NOT NULL,
        hypotheses_json TEXT NOT NULL,
        recommended_actions_json TEXT NOT NULL,
        top_anomalies_json TEXT NOT NULL,
        raw_feature_summary_json TEXT NOT NULL
      )
    `);
    fileDb
      .prepare(
        `
        INSERT INTO engine_incidents (
          incident_id,
          created_at,
          dataset,
          unit_id,
          primary_issue,
          confidence,
          hypotheses_json,
          recommended_actions_json,
          top_anomalies_json,
          raw_feature_summary_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        String(input.incident.incident_id),
        String(input.incident.created_at),
        String(input.incident.dataset),
        Number(input.incident.unit_id),
        String(input.incident.primary_issue),
        Number(input.incident.confidence),
        JSON.stringify(input.incident.hypotheses_json ?? []),
        JSON.stringify(input.incident.recommended_actions_json ?? []),
        JSON.stringify(input.incident.top_anomalies_json ?? []),
        JSON.stringify(input.incident.raw_feature_summary_json ?? {})
      );
  } finally {
    fileDb.close();
  }
}

async function maybeRefineWithLlm(
  teamSettings: ServerTeamSettings,
  agentName: string,
  draftOutput: Record<string, unknown>,
  draftConfidence: number,
  draftRationale: string
): Promise<{ confidence: number; rationale: string; mockMode: boolean }> {
  const provider = teamSettings.defaultProvider;
  const model = teamSettings.defaultModel;
  const key = teamSettings.keys[provider];

  if (!key) {
    return {
      confidence: draftConfidence,
      rationale: `${draftRationale} (mock mode: no provider key configured)`,
      mockMode: true
    };
  }

  const envelope = await providerClient.askProviderForJson({
    provider,
    model,
    apiKey: key,
    prompt: `Agent: ${agentName}\nDraft output: ${JSON.stringify(
      draftOutput
    )}\nDraft rationale: ${draftRationale}\nRefine confidence and rationale.`
  });

  if (!envelope) {
    return {
      confidence: draftConfidence,
      rationale: `${draftRationale} (provider fallback to deterministic rationale)`,
      mockMode: false
    };
  }

  return {
    confidence: clamp((draftConfidence + envelope.confidence) / 2),
    rationale: envelope.rationale,
    mockMode: false
  };
}

export async function runTaskAgent(params: {
  agentName: string;
  stepParams: Record<string, unknown>;
  runContext: Record<string, unknown>;
  teamSettings: ServerTeamSettings;
}): Promise<TaskResult> {
  const { agentName, stepParams, runContext, teamSettings } = params;
  const toolCalls: TaskResult["toolCalls"] = [];

  if (agentName === "DatasetLoaderAgent") {
    const dataset = String(stepParams.dataset ?? "dataset").trim();
    const datasetKey = dataset
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .toLowerCase() || "dataset";
    const source = String(stepParams.source ?? "local").toLowerCase() === "download" ? "download" : "local";
    const unitId = Math.max(1, Number(stepParams.unit_id ?? runContext.unit_id ?? 1) || 1);
    const window = Math.max(5, Number(stepParams.window ?? runContext.window ?? 50) || 50);
    const datasetUrl = String(stepParams.dataset_url ?? "").trim();
    const cacheDir = path.resolve(
      String(stepParams.cache_dir ?? process.env.CMAPSS_CACHE_DIR ?? path.resolve(process.cwd(), "data", "CMAPSS"))
    );

    const loaded = await loadCmapssDataset({
      dataset,
      unitId,
      source,
      datasetUrl,
      cacheDir,
      window
    });

    toolCalls.push({
      server: "local-dataset",
      tool: source === "download" ? `download+parse_${datasetKey}` : `parse_${datasetKey}`,
      args: {
        dataset,
        unit_id: unitId,
        source,
        dataset_url: datasetUrl || null,
        cache_dir: cacheDir,
        row_count: loaded.engine_rows.length
      }
    });

    return {
      output: loaded,
      confidence: 0.95,
      rationale: `Loaded ${loaded.engine_rows.length} rows for unit ${unitId} from ${source} source using dataset "${dataset}".`,
      toolCalls,
      mockMode: false
    };
  }

  if (agentName === "FeatureBuilderAgent") {
    const priorRows =
      (Array.isArray(stepParams.engine_rows) ? stepParams.engine_rows : null) ??
      (Array.isArray((runContext.lastOutput as { engine_rows?: unknown[] } | undefined)?.engine_rows)
        ? ((runContext.lastOutput as { engine_rows?: unknown[] }).engine_rows ?? [])
        : []);
    if (!Array.isArray(priorRows) || priorRows.length === 0) {
      throw new Error("FeatureBuilderAgent requires engine_rows from DatasetLoaderAgent.");
    }

    const window = Math.max(5, Number(stepParams.window ?? 50) || 50);
    const slopeWindow = Math.max(3, Number(stepParams.slope_window ?? 10) || 10);
    const built = buildCmapssFeatures({
      engineRows: priorRows as Array<Record<string, unknown>>,
      window,
      slopeWindow
    });

    toolCalls.push({
      server: "feature-builder",
      tool: "window_stats",
      args: {
        row_count: priorRows.length,
        window,
        slope_window: slopeWindow
      }
    });

    return {
      output: built,
      confidence: 0.93,
      rationale: `Computed ${built.top_anomalies.length} top anomalies and per-sensor trend stats.`,
      toolCalls,
      mockMode: false
    };
  }

  if (agentName === "CMAPSS Debate Agent") {
    const featuresOutput =
      findStepOutputByPredicate(runContext, (output) => "engine_features" in output) ??
      ((runContext.lastOutput && typeof runContext.lastOutput === "object" && "engine_features" in (runContext.lastOutput as Record<string, unknown>)
        ? (runContext.lastOutput as Record<string, unknown>)
        : null) as Record<string, unknown> | null);
    const loaderOutput = findStepOutputByPredicate(runContext, (output) => "dataset_meta" in output);

    const topAnomalies = Array.isArray(featuresOutput?.top_anomalies) ? featuresOutput.top_anomalies : [];
    const featureSummary =
      (featuresOutput?.engine_features && typeof featuresOutput.engine_features === "object"
        ? featuresOutput.engine_features
        : {}) as Record<string, unknown>;
    const datasetMeta =
      (loaderOutput?.dataset_meta && typeof loaderOutput.dataset_meta === "object"
        ? loaderOutput.dataset_meta
        : {}) as Record<string, unknown>;

    const provider = teamSettings.defaultProvider;
    const model = teamSettings.defaultModel;
    const apiKey = teamSettings.keys[provider];
    if (!apiKey) {
      const fallback = {
        primary_issue: "Sensor drift pattern indicates progressive degradation.",
        confidence: 0.61,
        hypotheses: [
          {
            label: "Compressor efficiency loss",
            rationale: "Top anomaly sensors show monotonic trend and elevated z-score.",
            evidence_sensors: (topAnomalies as Array<{ sensor?: string }>).map((entry) => entry.sensor).filter(Boolean)
          }
        ],
        recommended_actions: [
          "Schedule maintenance inspection for the unit.",
          "Increase monitoring frequency for next 20 cycles."
        ],
        transcript_summary: "Deterministic fallback debate used due to missing provider key.",
        llm_execution: {
          provider,
          model,
          llm_used: false,
          mock_mode: true,
          reason: "Provider key is not configured."
        }
      };
      return {
        output: fallback,
        confidence: fallback.confidence,
        rationale: "CMAPSS debate fallback used because provider key is not configured.",
        toolCalls,
        mockMode: true
      };
    }

    const envelope = await providerClient.askProviderForJson({
      provider,
      model,
      apiKey,
      prompt: [
        "You are a CMAPSS turbofan diagnostics panel.",
        "Return strict JSON keys only:",
        "primary_issue (string), confidence (0..1 number), hypotheses (array of {label,rationale,evidence_sensors}), recommended_actions (array of strings), transcript_summary (string).",
        `Dataset meta: ${JSON.stringify(datasetMeta)}`,
        `Feature summary: ${JSON.stringify({
          window: featureSummary.window,
          slope_window: featureSummary.slope_window,
          cycle_start: featureSummary.cycle_start,
          cycle_end: featureSummary.cycle_end
        })}`,
        `Top anomalies: ${JSON.stringify(topAnomalies)}`
      ].join("\n")
    });

    toolCalls.push({
      server: provider,
      tool: "chat.completions",
      args: { model, mode: "cmapss_debate" }
    });

    if (!envelope) {
      const fallback = {
        primary_issue: "Sensor trend divergence requires maintenance review.",
        confidence: 0.58,
        hypotheses: [
          {
            label: "Provider unavailable, deterministic diagnostic fallback",
            rationale: "Feature anomaly summary indicates non-stationary sensor behavior.",
            evidence_sensors: (topAnomalies as Array<{ sensor?: string }>).map((entry) => entry.sensor).filter(Boolean)
          }
        ],
        recommended_actions: [
          "Queue manual review for this engine incident.",
          "Re-run debate after provider connectivity is restored."
        ],
        transcript_summary: "Debate fallback used because provider call returned no envelope.",
        llm_execution: {
          provider,
          model,
          llm_used: false,
          mock_mode: true,
          reason: "Provider call returned no response envelope."
        }
      };
      return {
        output: fallback,
        confidence: fallback.confidence,
        rationale: "CMAPSS debate fallback used because provider call returned no envelope.",
        toolCalls,
        mockMode: true
      };
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(envelope.summary) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    const output =
      parsed && typeof parsed === "object"
        ? {
            primary_issue: String(parsed.primary_issue ?? envelope.summary),
            confidence: clamp(toNumber(parsed.confidence, envelope.confidence)),
            hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [],
            recommended_actions: Array.isArray(parsed.recommended_actions) ? parsed.recommended_actions : [],
            transcript_summary: String(parsed.transcript_summary ?? envelope.rationale),
            llm_execution: {
              provider,
              model,
              llm_used: true,
              mock_mode: false
            }
          }
        : {
            primary_issue: envelope.summary,
            confidence: clamp(envelope.confidence),
            hypotheses: [],
            recommended_actions: [],
            transcript_summary: envelope.rationale,
            llm_execution: {
              provider,
              model,
              llm_used: true,
              mock_mode: false
            }
          };

    return {
      output,
      confidence: clamp(toNumber(output.confidence, envelope.confidence)),
      rationale: envelope.rationale,
      toolCalls,
      mockMode: false
    };
  }

  if (agentName === "Incident Orchestrator Agent") {
    const debateOutput =
      (runContext.lastOutput && typeof runContext.lastOutput === "object" ? (runContext.lastOutput as Record<string, unknown>) : null) ??
      findStepOutputByPredicate(runContext, (output) => "primary_issue" in output);
    const featuresOutput = findStepOutputByPredicate(runContext, (output) => "engine_features" in output);
    const loaderOutput = findStepOutputByPredicate(runContext, (output) => "dataset_meta" in output);

    const meta =
      (loaderOutput?.dataset_meta && typeof loaderOutput.dataset_meta === "object"
        ? loaderOutput.dataset_meta
        : {}) as Record<string, unknown>;
    const incident = {
      incident_id: randomUUID(),
      created_at: new Date().toISOString(),
      dataset: String(meta.dataset ?? stepParams.dataset ?? "dataset"),
      unit_id: Number(meta.unit_id ?? stepParams.unit_id ?? runContext.unit_id ?? 1),
      primary_issue: String(debateOutput?.primary_issue ?? "Unknown issue"),
      confidence: clamp(toNumber(debateOutput?.confidence, 0.5)),
      hypotheses_json: Array.isArray(debateOutput?.hypotheses) ? debateOutput?.hypotheses : [],
      recommended_actions_json: Array.isArray(debateOutput?.recommended_actions) ? debateOutput?.recommended_actions : [],
      top_anomalies_json: Array.isArray(featuresOutput?.top_anomalies) ? featuresOutput.top_anomalies : [],
      raw_feature_summary_json:
        featuresOutput && typeof featuresOutput.engine_features === "object" ? featuresOutput.engine_features : {}
    };

    return {
      output: { incident },
      confidence: clamp(toNumber(incident.confidence, 0.5)),
      rationale: "Built normalized incident payload from CMAPSS feature and debate outputs.",
      toolCalls,
      mockMode: false
    };
  }

  if (agentName === "DbWriteAgent") {
    const incidentCandidate =
      (stepParams.incident && typeof stepParams.incident === "object"
        ? (stepParams.incident as Record<string, unknown>)
        : null) ??
      ((runContext.lastOutput && typeof runContext.lastOutput === "object" && typeof (runContext.lastOutput as Record<string, unknown>).incident === "object"
        ? ((runContext.lastOutput as Record<string, unknown>).incident as Record<string, unknown>)
        : null) as Record<string, unknown> | null);
    if (!incidentCandidate) {
      throw new Error("DbWriteAgent requires incident payload from Incident Orchestrator Agent.");
    }

    const target = String(stepParams.db_target ?? (process.env.DATABASE_URL ? "postgres" : "sqlite")).toLowerCase();
    if (target === "postgres") {
      const connectionString = String(stepParams.connectionString ?? process.env.DATABASE_URL ?? "").trim();
      if (!connectionString) {
        throw new Error("DbWriteAgent target=postgres requires DATABASE_URL or step connectionString.");
      }
      await insertIncidentPostgres({ connectionString, incident: incidentCandidate });
      toolCalls.push({
        server: "postgres",
        tool: "insert_engine_incident",
        args: { incident_id: incidentCandidate.incident_id }
      });
      return {
        output: {
          status: "inserted",
          db_target: "postgres",
          insert_id: String(incidentCandidate.incident_id),
          incident_id: String(incidentCandidate.incident_id),
          table: "engine_incidents"
        },
        confidence: 0.97,
        rationale: "Incident inserted into Postgres engine_incidents table.",
        toolCalls,
        mockMode: false
      };
    }

    const sqlitePath = String(
      stepParams.sqlite_path ??
        process.env.CMAPSS_SQLITE_PATH ??
        path.resolve(process.cwd(), "data", "engine-incidents.db")
    );
    insertIncidentSqlite({ sqlitePath, incident: incidentCandidate });
    toolCalls.push({
      server: "sqlite",
      tool: "insert_engine_incident",
      args: { sqlite_path: sqlitePath, incident_id: incidentCandidate.incident_id }
    });
    return {
      output: {
        status: "inserted",
        db_target: "sqlite",
        sqlite_path: sqlitePath,
        insert_id: String(incidentCandidate.incident_id),
        incident_id: String(incidentCandidate.incident_id),
        table: "engine_incidents"
      },
      confidence: 0.96,
      rationale: "Incident inserted into SQLite engine_incidents table.",
      toolCalls,
      mockMode: false
    };
  }

  if (agentName === "LLM Agent") {
    const llmNodeMode = String(stepParams.llmNodeMode ?? "llm").toLowerCase();
    const databaseMode =
      stepParams.toolId === "database" ||
      stepParams.toolHint === "database" ||
      stepParams.mode === "external_db_query" ||
      stepParams.mode === "external_db_write" ||
      typeof stepParams.query === "string";
    const llmQuery = typeof stepParams.query === "string" ? stepParams.query : "";
    const llmAllowDbWrite = stepParams.allowDbWrite === true || stepParams.mode === "external_db_write";
    let dbOutput: Record<string, unknown> | undefined;
    if (databaseMode && llmQuery.trim()) {
      const connectionString =
        String(
          stepParams.connectionString ??
            runContext.databaseConnectionString ??
            teamSettings.externalDbUrl ??
            process.env.EXTERNAL_DB_URL ??
            ""
        );
      if (!connectionString) {
        return {
          output: {
            error: "Database connection string missing.",
            hint: "Set LLM node connectionString, settings external DB URL, or EXTERNAL_DB_URL."
          },
          confidence: 0.2,
          rationale: "LLM Agent requested DB access but no connection string is configured.",
          toolCalls,
          mockMode: true
        };
      }
      const queryParams = Array.isArray(stepParams.queryParams) ? stepParams.queryParams : [];
      const maxRows = typeof stepParams.maxRows === "number" ? stepParams.maxRows : 100;
      const query = renderPromptTemplate(llmQuery, runContext);
      const result = llmAllowDbWrite
        ? await executeExternalQuery({
            connectionString,
            query,
            params: queryParams,
            maxRows,
            allowWrite: true
          })
        : await executeReadOnlyExternalQuery({
            connectionString,
            query,
            params: queryParams,
            maxRows
          });
      dbOutput = {
        engine: result.engine,
        rowCount: result.rowCount,
        rows: result.rows,
        writeEnabled: llmAllowDbWrite
      };
      toolCalls.push({
        server: "external-db",
        tool: llmAllowDbWrite ? "execute_query" : "read_only_query",
        args: {
          engine: result.engine,
          maxRows,
          query: query.slice(0, 300),
          writeEnabled: llmAllowDbWrite
        }
      });
    }

    const requestedProvider = stepParams.llmProvider;
    const provider = isProvider(requestedProvider) ? requestedProvider : teamSettings.defaultProvider;
    const model =
      typeof stepParams.llmModel === "string" && stepParams.llmModel.trim()
        ? stepParams.llmModel.trim()
        : provider === teamSettings.defaultProvider
          ? teamSettings.defaultModel
          : DEFAULT_MODELS[provider];
    const apiKey = teamSettings.keys[provider];

    const rawPrompt =
      typeof stepParams.prompt === "string" && stepParams.prompt.trim()
        ? stepParams.prompt
        : typeof stepParams.question === "string" && stepParams.question.trim()
          ? stepParams.question
          : llmNodeMode === "summary_llm"
            ? "Write a clear summary of the workflow result for a non-technical user."
            : "Summarize the run context and provide the most important next action.";
    const prompt = renderPromptTemplate(rawPrompt, runContext);
    const systemPrompt =
      typeof stepParams.systemPrompt === "string" && stepParams.systemPrompt.trim()
        ? stepParams.systemPrompt.trim()
        : llmNodeMode === "summary_llm"
          ? "You explain workflow results clearly for business users."
          : "You are a precise operations assistant. Keep responses concise.";

    if (!apiKey) {
      const summaryFallback =
        llmNodeMode === "summary_llm"
          ? "Summary unavailable because no LLM API key is configured. Configure an OpenAI key to enable result summaries."
          : `Mock response: ${prompt}`;
      return {
        output: {
          provider,
          model,
          llmNodeMode,
          prompt,
          answer: summaryFallback,
          overallSummary: llmNodeMode === "summary_llm" ? summaryFallback : undefined,
          mockMode: true,
          llm_execution: {
            provider,
            model,
            llm_used: false,
            mock_mode: true,
            reason: `No ${provider} API key configured.`
          }
        },
        confidence: 0.45,
        rationale: `No ${provider} API key configured. Returned mock LLM output.`,
        toolCalls,
        mockMode: true
      };
    }

    if (llmNodeMode === "summary_llm") {
      const summarySource = buildSummarySource(runContext);
      const fallbackSummary = (() => {
        const findings = summarySource.findings;
        const primaryIssue =
          typeof findings.primary_issue === "string" && findings.primary_issue.trim()
            ? findings.primary_issue
            : "an issue";
        const decision =
          typeof findings.decision === "string"
            ? findings.decision
            : findings.finalRecommendation &&
                typeof findings.finalRecommendation === "object" &&
                typeof (findings.finalRecommendation as Record<string, unknown>).decision === "string"
              ? String((findings.finalRecommendation as Record<string, unknown>).decision)
              : null;
        const confidence =
          typeof findings.confidence === "number"
            ? findings.confidence
            : typeof (summarySource.lastOutput as Record<string, unknown> | null)?.confidence === "number"
              ? Number((summarySource.lastOutput as Record<string, unknown>).confidence)
              : null;
        const first = `The workflow finished and identified ${primaryIssue}.`;
        const second = decision
          ? `The final decision was ${decision}${typeof confidence === "number" ? ` with confidence ${confidence.toFixed(2)}` : ""}.`
          : typeof confidence === "number"
            ? `The result confidence was ${confidence.toFixed(2)}.`
            : "No final decision was reported.";
        return `${first} ${second}`;
      })();

      const objectResult = await providerClient.askProviderForObject({
        provider,
        model,
        apiKey,
        systemPrompt: [
          systemPrompt,
          "Write an understandable result summary for operators.",
          "Use 3-4 short sentences.",
          "Cover what happened, key result, confidence/decision, and next action.",
          "Avoid generic filler language.",
          'Return strict JSON: {"overallSummary":"string","nextAction":"string"}'
        ].join("\n"),
        prompt: [
          `User goal: ${prompt}`,
          `Run summary source: ${JSON.stringify(summarySource).slice(0, 9000)}`,
          dbOutput ? `Database result: ${JSON.stringify(dbOutput).slice(0, 2000)}` : ""
        ]
          .filter(Boolean)
          .join("\n\n")
      });

      toolCalls.push({
        server: provider,
        tool: "chat.completions",
        args: {
          model,
          llmNodeMode: "summary_llm"
        }
      });

      const overallSummary =
        objectResult && typeof objectResult.overallSummary === "string" && objectResult.overallSummary.trim()
          ? objectResult.overallSummary.trim()
          : fallbackSummary;
      const nextAction =
        objectResult && typeof objectResult.nextAction === "string" && objectResult.nextAction.trim()
          ? objectResult.nextAction.trim()
          : "";

      return {
        output: {
          provider,
          model,
          llmNodeMode,
          prompt,
          database: dbOutput ?? null,
          answer: overallSummary,
          overallSummary,
          nextAction: nextAction || null,
          mockMode: false,
          llm_execution: {
            provider,
            model,
            llm_used: true,
            mock_mode: false
          }
        },
        confidence: 0.85,
        rationale: "Generated user-facing summary from workflow results.",
        toolCalls,
        mockMode: false
      };
    }

    const envelope = await providerClient.askProviderForJson({
      provider,
      model,
      apiKey,
      prompt: `${systemPrompt}\n\nUser prompt:\n${prompt}\n\nContext:\n${JSON.stringify(runContext).slice(0, 2000)}${
        dbOutput ? `\n\nDatabase result:\n${JSON.stringify(dbOutput).slice(0, 2000)}` : ""
      }`
    });

    toolCalls.push({
      server: provider,
      tool: "chat.completions",
      args: {
        model
      }
    });

    if (!envelope) {
      return {
        output: {
          provider,
          model,
          llmNodeMode,
          prompt,
          database: dbOutput ?? null,
          answer: "Provider call failed. No response envelope returned.",
          mockMode: false,
          llm_execution: {
            provider,
            model,
            llm_used: false,
            mock_mode: false,
            reason: "Provider call failed. No response envelope returned."
          }
        },
        confidence: 0.3,
        rationale: "Provider call failed for LLM Agent step.",
        toolCalls,
        mockMode: false
      };
    }

    return {
      output: {
        provider,
        model,
        llmNodeMode,
        prompt,
        database: dbOutput ?? null,
        answer: envelope.summary,
        mockMode: false,
        llm_execution: {
          provider,
          model,
          llm_used: true,
          mock_mode: false
        }
      },
      confidence: clamp(envelope.confidence),
      rationale: envelope.rationale,
      toolCalls,
      mockMode: false
    };
  }

  const databaseMode =
    stepParams.toolId === "database" ||
    stepParams.toolHint === "database" ||
    stepParams.mode === "external_db_query";
  if (databaseMode && typeof stepParams.query === "string") {
    const connectionString =
      String(
        stepParams.connectionString ??
          runContext.databaseConnectionString ??
          teamSettings.externalDbUrl ??
          process.env.EXTERNAL_DB_URL ??
          ""
      );
    if (!connectionString) {
      return {
        output: {
          error: "Database connection string missing.",
          hint: "Set Database tool connectionString or EXTERNAL_DB_URL."
        },
        confidence: 0.2,
        rationale: "External DB query requested but no connection string provided.",
        toolCalls,
        mockMode: true
      };
    }

    const query = String(stepParams.query);
    const queryParams = Array.isArray(stepParams.queryParams) ? stepParams.queryParams : [];
    const maxRows = typeof stepParams.maxRows === "number" ? stepParams.maxRows : 100;

    const result = await executeReadOnlyExternalQuery({
      connectionString,
      query,
      params: queryParams,
      maxRows
    });

    toolCalls.push({
      server: "external-db",
      tool: "read_only_query",
      args: {
        engine: result.engine,
        query: query.slice(0, 300),
        maxRows
      }
    });

    return {
      output: {
        engine: result.engine,
        rowCount: result.rowCount,
        rows: result.rows
      },
      confidence: 0.91,
      rationale: `Executed read-only ${result.engine} query and returned ${result.rowCount} rows.`,
      toolCalls,
      mockMode: false
    };
  }

  if (agentName === "Inventory Agent") {
    const orderId = String(stepParams.orderId ?? runContext.orderId ?? "ORD-1001");
    const order = db.prepare("SELECT * FROM orders WHERE order_id = ? LIMIT 1").get(orderId) as
      | {
          order_id: string;
          sku: string;
          qty: number;
          destination: string;
          requested_date: string;
        }
      | undefined;

    const sku = String(stepParams.sku ?? order?.sku ?? "SKU-100");
    const inventory = db.prepare("SELECT * FROM inventory WHERE sku = ? LIMIT 1").get(sku) as
      | {
          sku: string;
          on_hand: number;
          reserved: number;
          reorder_days: number;
        }
      | undefined;

    toolCalls.push({
      server: "internal-db",
      tool: "select_order",
      args: { orderId }
    });
    toolCalls.push({
      server: "internal-db",
      tool: "select_inventory",
      args: { sku }
    });

    const available = Math.max(0, (inventory?.on_hand ?? 0) - (inventory?.reserved ?? 0));
    const qty = order?.qty ?? toNumber(stepParams.qty, 10);
    const shortage = Math.max(0, qty - available);

    const draftOutput = {
      orderId,
      sku,
      requestedQty: qty,
      availableQty: available,
      shortageQty: shortage,
      recommendedAction:
        shortage > 0 ? `Backorder ${shortage} units and expedite replenishment` : "Fulfill from stock"
    };

    const baseConfidence = shortage > 0 ? 0.74 : 0.9;
    const baseRationale =
      shortage > 0
        ? "Available stock does not meet requested quantity. Backorder path recommended."
        : "On-hand stock can satisfy order immediately.";

    const refined = await maybeRefineWithLlm(
      teamSettings,
      agentName,
      draftOutput,
      baseConfidence,
      baseRationale
    );

    return {
      output: draftOutput,
      confidence: refined.confidence,
      rationale: refined.rationale,
      toolCalls,
      mockMode: refined.mockMode
    };
  }

  if (agentName === "Supplier Risk Agent") {
    const supplierId = String(stepParams.supplierId ?? runContext.supplierId ?? "SUP-02");
    const supplier = db
      .prepare("SELECT * FROM suppliers WHERE supplier_id = ? LIMIT 1")
      .get(supplierId) as
      | {
          supplier_id: string;
          name: string;
          risk_score: number;
          on_time_pct: number;
          region: string;
        }
      | undefined;

    toolCalls.push({
      server: "internal-db",
      tool: "select_supplier",
      args: { supplierId }
    });

    const riskScore = supplier?.risk_score ?? 0.5;
    const riskBand = riskScore >= 0.7 ? "HIGH" : riskScore >= 0.4 ? "MEDIUM" : "LOW";
    const costImpactUSD = Math.round(riskScore * 900);

    const draftOutput = {
      supplierId,
      supplierName: supplier?.name ?? "Unknown",
      region: supplier?.region ?? "UNKNOWN",
      riskScore,
      onTimePct: supplier?.on_time_pct ?? 0,
      riskBand,
      mitigation: riskBand === "HIGH" ? "Require secondary source before PO release" : "Proceed",
      costImpactUSD
    };

    const baseConfidence = 0.82 - riskScore * 0.15;
    const baseRationale = `Supplier risk score ${riskScore.toFixed(
      2
    )} produced ${riskBand} classification.`;

    const refined = await maybeRefineWithLlm(
      teamSettings,
      agentName,
      draftOutput,
      baseConfidence,
      baseRationale
    );

    return {
      output: draftOutput,
      confidence: refined.confidence,
      rationale: refined.rationale,
      toolCalls,
      mockMode: refined.mockMode
    };
  }

  if (agentName === "Logistics Agent") {
    const destination = String(stepParams.destination ?? runContext.destination ?? "Indianapolis");
    const region = destinationToRegion(destination);
    const rates = db
      .prepare("SELECT * FROM shipping_rates WHERE region = ? ORDER BY rate_usd ASC")
      .all(region) as Array<{ carrier: string; mode: string; region: string; rate_usd: number; lead_days: number }>;

    toolCalls.push({
      server: "internal-db",
      tool: "select_shipping_rates",
      args: { region }
    });

    const choice = rates[0] ?? {
      carrier: "Fallback",
      mode: "ground",
      region,
      rate_usd: 300,
      lead_days: 5
    };

    const expedite = rates.find((rate) => rate.mode === "air") ?? choice;

    const draftOutput = {
      destination,
      region,
      selectedCarrier: choice.carrier,
      mode: choice.mode,
      etaDays: choice.lead_days,
      shippingCostUSD: choice.rate_usd,
      expeditedOption: {
        carrier: expedite.carrier,
        mode: expedite.mode,
        etaDays: expedite.lead_days,
        shippingCostUSD: expedite.rate_usd
      },
      costImpactUSD: choice.rate_usd
    };

    const baseConfidence = choice.mode === "ground" ? 0.86 : 0.78;
    const baseRationale = `Selected lowest-cost option ${choice.carrier}/${choice.mode} for ${region}.`;

    const refined = await maybeRefineWithLlm(
      teamSettings,
      agentName,
      draftOutput,
      baseConfidence,
      baseRationale
    );

    return {
      output: draftOutput,
      confidence: refined.confidence,
      rationale: refined.rationale,
      toolCalls,
      mockMode: refined.mockMode
    };
  }

  if (agentName === "Finance Agent") {
    const logisticsCost = toNumber(runContext.lastLogisticsCostUSD, 200);
    const shortageQty = toNumber(runContext.lastShortageQty, 0);
    const unitPrice = toNumber(runContext.unitPrice, 100);
    const penalty = shortageQty * unitPrice * 0.05;
    const costImpactUSD = Math.round(logisticsCost + penalty);

    const draftOutput = {
      logisticsCostUSD: logisticsCost,
      shortagePenaltyUSD: Math.round(penalty),
      costImpactUSD,
      estimatedMarginImpactPct: Number((costImpactUSD / 5000).toFixed(3)),
      recommendation:
        costImpactUSD > 500 ? "Route to approver due to financial impact" : "Proceed within delegated threshold"
    };

    const baseConfidence = costImpactUSD > 500 ? 0.62 : 0.83;
    const baseRationale = `Computed total cost impact from shipping + shortage penalty: ${costImpactUSD}.`;

    const refined = await maybeRefineWithLlm(
      teamSettings,
      agentName,
      draftOutput,
      baseConfidence,
      baseRationale
    );

    return {
      output: draftOutput,
      confidence: refined.confidence,
      rationale: refined.rationale,
      toolCalls,
      mockMode: refined.mockMode
    };
  }

  if (agentName === "Debate Agent") {
    const warnings: string[] = [];
    const debateConfig = stepParams as DebateNodeConfig & { arbiter?: Record<string, unknown> };
    const requestedMainProvider = String(
      stepParams.llmProvider ?? (debateConfig as Record<string, unknown>).llmProvider ?? teamSettings.defaultProvider
    ).toLowerCase();
    const mainProvider: Provider = isProvider(requestedMainProvider) ? requestedMainProvider : teamSettings.defaultProvider;
    const requestedMainModel = String(
      stepParams.llmModel ??
        (debateConfig as Record<string, unknown>).llmModel ??
        (teamSettings.defaultProvider === mainProvider ? teamSettings.defaultModel : DEFAULT_MODELS[mainProvider])
    ).trim();
    const mainModel =
      requestedMainModel ||
      (teamSettings.defaultProvider === mainProvider ? teamSettings.defaultModel : DEFAULT_MODELS[mainProvider]);
    const topicTemplate = String(
      debateConfig.debateTopic ??
        stepParams.prompt ??
        runContext.lastSummary ??
        runContext.orderId ??
        "Evaluate options and produce a final recommendation."
    );
    const resolvedTopic = resolveTemplates(topicTemplate, runContext);
    warnings.push(...resolvedTopic.warnings.map((warning) => `topic: ${warning}`));
    const topic = String(resolvedTopic.value ?? topicTemplate);
    const rounds = Math.max(1, Number(debateConfig.debateRounds ?? 2) || 2);
    const outputSchemaVersion = debateConfig.outputSchemaVersion === "v1" ? "v1" : "v1";
    const requireJson = debateConfig.requireJson !== false;
    const maxTokens = Number.isFinite(Number(debateConfig.maxTokens)) ? Number(debateConfig.maxTokens) : undefined;
    const temperature = Number.isFinite(Number(debateConfig.temperature))
      ? Number(debateConfig.temperature)
      : undefined;

    const defaultParticipants = [
      {
        id: "risk",
        label: "Risk Analyst",
        provider: mainProvider,
        model: mainModel,
        stance: "BLOCK" as DebateStance,
        systemPrompt: "You are a risk analyst focused on downside prevention and safety controls.",
        weight: 1
      },
      {
        id: "cost",
        label: "Cost Optimizer",
        provider: mainProvider,
        model: mainModel,
        stance: "APPROVE" as DebateStance,
        systemPrompt: "You are a cost optimizer focused on speed and budget efficiency.",
        weight: 1
      },
      {
        id: "ops",
        label: "Ops Reliability",
        provider: mainProvider,
        model: mainModel,
        stance: "CONDITIONAL" as DebateStance,
        systemPrompt: "You are an operations reliability lead balancing uptime and execution constraints.",
        weight: 1
      }
    ];

    const configuredParticipants = Array.isArray(debateConfig.participants)
      ? debateConfig.participants
          .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .map((entry, index) => {
            const requestedProvider = String(entry.provider ?? "").toLowerCase();
            if (requestedProvider && requestedProvider !== mainProvider) {
              warnings.push(
                `participants[${index}] provider "${requestedProvider}" overridden to "${mainProvider}" (main provider policy).`
              );
            }
            const stance = String(entry.stance ?? "").toUpperCase();
            if (!isDebateStance(stance)) {
              warnings.push(`participants[${index}] ignored: unsupported stance "${stance}".`);
              return null;
            }
            const id = String(entry.id ?? `participant_${index + 1}`).trim() || `participant_${index + 1}`;
            const label = String(entry.label ?? id).trim() || id;
            const requestedModel = String(entry.model ?? "").trim();
            if (requestedModel && requestedModel !== mainModel) {
              warnings.push(
                `participants[${index}] model "${requestedModel}" overridden to "${mainModel}" (main provider policy).`
              );
            }
            const weight = Math.max(0.1, Number(entry.weight ?? 1) || 1);
            const systemPrompt = typeof entry.systemPrompt === "string" ? entry.systemPrompt : "";
            return {
              id,
              label,
              provider: mainProvider,
              model: mainModel,
              stance,
              weight,
              systemPrompt
            };
          })
          .filter(
            (
              item
            ): item is {
              id: string;
              label: string;
              provider: Provider;
              model: string;
              stance: DebateStance;
              weight: number;
              systemPrompt: string;
            } => Boolean(item)
          )
      : [];

    const debateParticipants = configuredParticipants.length > 0 ? configuredParticipants : defaultParticipants;
    const participantMap = new Map(debateParticipants.map((participant) => [participant.id, participant]));
    const debateArguments: Array<{
      round: number;
      participantId: string;
      stance: DebateStance;
      summary: string;
      keyPoints: string[];
      risks: string[];
      mitigations: string[];
      confidence: number;
      raw?: string;
    }> = [];
    let usedFallback = false;

    for (let round = 1; round <= rounds; round += 1) {
      const priorRoundSummaries =
        round <= 1
          ? "No prior arguments."
          : debateArguments
              .filter((entry) => entry.round === round - 1)
              .map(
                (entry) =>
                  `${entry.participantId} (${entry.stance}) conf=${entry.confidence.toFixed(2)} summary=${entry.summary} risks=${entry.risks.join(
                    "; "
                  )} mitigations=${entry.mitigations.join("; ")}`
              )
              .join("\n");

      for (const participant of debateParticipants) {
        const fallbackArgument = {
          role: participant.label,
          stance: participant.stance,
          argument: {
            summary: `${participant.label} (${participant.stance}) fallback for topic "${topic}".`,
            key_points: [
              `Fallback argument generated for ${participant.id}.`,
              "Provider unavailable or invalid JSON response."
            ],
            risks: ["Potential model/provider outage during demo run."],
            mitigations: ["Use deterministic fallback output and continue workflow."]
          },
          evidence: [],
          confidence: 0.56
        };

        const roundSystemPromptTemplate =
          participant.systemPrompt ||
          `You are ${participant.label}. Keep stance ${participant.stance}. Provide concise enterprise decision support.`;
        const resolvedSystemPrompt = resolveTemplates(roundSystemPromptTemplate, runContext);
        warnings.push(
          ...resolvedSystemPrompt.warnings.map((warning) => `${participant.id} systemPrompt: ${warning}`)
        );
        const roundSystemPrompt = String(resolvedSystemPrompt.value ?? roundSystemPromptTemplate);

        const roundPrompt = [
          `Topic: ${topic}`,
          `Round: ${round}`,
          `Participant: ${participant.label} (${participant.id})`,
          `Required stance: ${participant.stance}`,
          round > 1 ? `Prior round summaries:\n${priorRoundSummaries}` : "Prior round summaries: none",
          "Return strict JSON:",
          "{",
          '  "role": "string",',
          '  "stance": "APPROVE|BLOCK|CONDITIONAL",',
          '  "argument": {',
          '    "summary": "string",',
          '    "key_points": ["string"],',
          '    "risks": ["string"],',
          '    "mitigations": ["string"]',
          "  },",
          '  "evidence": ["string"],',
          '  "confidence": 0.0',
          "}"
        ].join("\n");

        const strict = await providerClient.askProviderForStrictJson({
          provider: participant.provider,
          model: participant.model,
          apiKey: teamSettings.keys[participant.provider],
          systemPrompt: roundSystemPrompt,
          userPrompt: roundPrompt,
          jsonSchemaHint:
            "Must be valid JSON object with role, stance, argument{summary,key_points,risks,mitigations}, evidence[], confidence.",
          maxTokens,
          temperature,
          fallback: fallbackArgument
        });
        usedFallback = usedFallback || strict.usedFallback;
        warnings.push(...strict.warnings.map((warning) => `${participant.id}: ${warning}`));

        const response = strict.value;
        const responseArgument =
          response.argument && typeof response.argument === "object"
            ? (response.argument as Record<string, unknown>)
            : {};
        const responseStance = String(response.stance ?? participant.stance).toUpperCase();
        const normalizedStance = isDebateStance(responseStance) ? responseStance : participant.stance;
        if (responseStance !== normalizedStance) {
          warnings.push(`${participant.id}: stance normalized to ${normalizedStance}.`);
        }

        const summary = String(
          responseArgument.summary ??
            response.summary ??
            `${participant.label} recommends ${normalizedStance} for "${topic}".`
        );
        const keyPoints = sanitizeStringArray(responseArgument.key_points ?? responseArgument.keyPoints);
        const risks = sanitizeStringArray(responseArgument.risks);
        const mitigations = sanitizeStringArray(responseArgument.mitigations);
        const confidence = clamp(toNumber(response.confidence, 0.56));

        debateArguments.push({
          round,
          participantId: participant.id,
          stance: normalizedStance,
          summary,
          keyPoints,
          risks,
          mitigations,
          confidence,
          raw: requireJson ? undefined : JSON.stringify(response)
        });
      }
    }

    const finalRoundArguments = debateArguments.filter((entry) => entry.round === rounds);
    const scoreSource = finalRoundArguments.length > 0 ? finalRoundArguments : debateArguments;
    const scored = scoreSource.map((entry) => {
      const participant = participantMap.get(entry.participantId);
      const weight = participant?.weight ?? 1;
      return {
        entry,
        score: clamp(entry.confidence) * Math.max(0.1, weight)
      };
    });
    const bestScored = scored.reduce(
      (current, candidate) => (candidate.score > current.score ? candidate : current),
      scored[0]
    );
    const bestArgument = bestScored?.entry ?? {
      round: rounds,
      participantId: "fallback",
      stance: "CONDITIONAL" as DebateStance,
      summary: "No arguments generated.",
      keyPoints: [],
      risks: [],
      mitigations: [],
      confidence: 0.5
    };

    const bestRecommendation = {
      decision: bestArgument.stance,
      confidence: clamp(bestArgument.confidence),
      rationale: `${bestArgument.summary}${bestArgument.keyPoints.length ? ` Key points: ${bestArgument.keyPoints.join("; ")}` : ""}`,
      conditions:
        bestArgument.stance === "CONDITIONAL"
          ? bestArgument.mitigations.length > 0
            ? bestArgument.mitigations
            : ["Proceed only after additional safeguards are confirmed."]
          : [],
      nextActions:
        bestArgument.mitigations.length > 0
          ? bestArgument.mitigations
          : ["Log debate result and route to operator review."]
    };

    const arbiterConfig =
      debateConfig.arbiter && typeof debateConfig.arbiter === "object"
        ? (debateConfig.arbiter as Record<string, unknown>)
        : {};
    const arbiterEnabled = arbiterConfig.enabled !== false;
    const arbiterRequestedProvider = String(arbiterConfig.provider ?? "").toLowerCase();
    if (arbiterRequestedProvider && arbiterRequestedProvider !== mainProvider) {
      warnings.push(`arbiter provider "${arbiterRequestedProvider}" overridden to "${mainProvider}" (main provider policy).`);
    }
    const arbiterRequestedModel = String(arbiterConfig.model ?? "").trim();
    if (arbiterRequestedModel && arbiterRequestedModel !== mainModel) {
      warnings.push(`arbiter model "${arbiterRequestedModel}" overridden to "${mainModel}" (main provider policy).`);
    }
    const arbiterProvider = mainProvider;
    const arbiterModel = mainModel;
    const arbiterSystemTemplate =
      typeof arbiterConfig.systemPrompt === "string" && arbiterConfig.systemPrompt.trim()
        ? arbiterConfig.systemPrompt
        : "You are the final arbiter. Synthesize participant arguments into a final recommendation.";
    const resolvedArbiterSystem = resolveTemplates(arbiterSystemTemplate, runContext);
    warnings.push(...resolvedArbiterSystem.warnings.map((warning) => `arbiter: ${warning}`));

    let synthesisMode: "best_argument" | "arbiter" = "best_argument";
    let finalRecommendation = bestRecommendation;

    if (arbiterEnabled && scoreSource.length > 0) {
      const arbiterFallback = {
        decision: bestRecommendation.decision,
        confidence: bestRecommendation.confidence,
        rationale: bestRecommendation.rationale,
        conditions: bestRecommendation.conditions,
        nextActions: bestRecommendation.nextActions
      };

      const arbiter = await providerClient.askProviderForStrictJson({
        provider: arbiterProvider,
        model: arbiterModel,
        apiKey: teamSettings.keys[arbiterProvider],
        systemPrompt: String(resolvedArbiterSystem.value ?? arbiterSystemTemplate),
        userPrompt: [
          `Topic: ${topic}`,
          "Participant summaries from final round:",
          ...scoreSource.map((entry) => {
            const participant = participantMap.get(entry.participantId);
            return `- ${entry.participantId} (${participant?.label ?? "unknown"}, ${entry.stance}, conf ${entry.confidence.toFixed(
              2
            )}): ${entry.summary} | risks=${entry.risks.join("; ")} | mitigations=${entry.mitigations.join("; ")}`;
          }),
          "Return strict JSON:",
          "{",
          '  "decision": "APPROVE|BLOCK|CONDITIONAL",',
          '  "confidence": 0.0,',
          '  "rationale": "string",',
          '  "conditions": ["string"],',
          '  "nextActions": ["string"]',
          "}"
        ].join("\n"),
        jsonSchemaHint: "Final recommendation object with decision, confidence, rationale, conditions[], nextActions[].",
        maxTokens,
        temperature,
        fallback: arbiterFallback
      });
      usedFallback = usedFallback || arbiter.usedFallback;
      warnings.push(...arbiter.warnings.map((warning) => `arbiter: ${warning}`));

      if (!arbiter.usedFallback) {
        const rec = arbiter.value;
        const decisionRaw = String(rec.decision ?? bestRecommendation.decision).toUpperCase();
        const decision = isDebateStance(decisionRaw) ? decisionRaw : bestRecommendation.decision;
        const conditions = sanitizeStringArray(rec.conditions);
        finalRecommendation = {
          decision,
          confidence: clamp(toNumber(rec.confidence, bestRecommendation.confidence)),
          rationale: String(rec.rationale ?? bestRecommendation.rationale),
          conditions:
            decision === "CONDITIONAL"
              ? conditions.length > 0
                ? conditions
                : ["Proceed with explicit approval gates and monitoring."]
              : [],
          nextActions: sanitizeStringArray(rec.nextActions).length
            ? sanitizeStringArray(rec.nextActions)
            : bestRecommendation.nextActions
        };
        synthesisMode = "arbiter";
      }
    }

    const output = DebateOutputSchema.parse({
      schemaVersion: outputSchemaVersion,
      topic,
      rounds,
      participants: debateParticipants.map((participant) => ({
        id: participant.id,
        label: participant.label,
        provider: participant.provider,
        model: participant.model,
        stance: participant.stance
      })),
      arguments: debateArguments,
      finalRecommendation,
      synthesisMode,
      meta: {
        warnings
      }
    });

    toolCalls.push({
      server: "multi-model",
      tool: "debate",
      args: {
        rounds,
        participants: debateParticipants.map((item) => `${item.id}:${item.provider}/${item.model}`),
        arbiterEnabled,
        arbiterProvider,
        synthesisMode
      }
    });

    return {
      output,
      confidence: clamp(output.finalRecommendation.confidence),
      rationale: output.finalRecommendation.rationale,
      toolCalls,
      mockMode: usedFallback
    };
  }

  if (agentName === "Notification Agent") {
    const mode = String(stepParams.outputMode ?? "run_summary");
    const summary = String(runContext.lastSummary ?? "Workflow completed");
    const destination = String(runContext.destination ?? "Operations Team");
    const summarySource = buildSummarySource(runContext);
    const findings = (summarySource.findings ?? {}) as Record<string, unknown>;
    const recommendationObject =
      findings.finalRecommendation && typeof findings.finalRecommendation === "object"
        ? (findings.finalRecommendation as Record<string, unknown>)
        : null;
    const discoveredSourceUrl = summarySource.recentSteps
      .slice()
      .reverse()
      .map((entry) => (entry.output && typeof entry.output === "object" ? (entry.output as Record<string, unknown>) : null))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => {
        if (typeof entry.source_url === "string" && entry.source_url.trim()) {
          return entry.source_url.trim();
        }
        if (typeof entry.dataset_url === "string" && entry.dataset_url.trim()) {
          return entry.dataset_url.trim();
        }
        const meta = entry.dataset_meta;
        if (meta && typeof meta === "object" && typeof (meta as Record<string, unknown>).source_url === "string") {
          return String((meta as Record<string, unknown>).source_url).trim();
        }
        return "";
      })
      .find(Boolean);
    const decisionTitle =
      typeof stepParams.decision_title === "string" && stepParams.decision_title.trim()
        ? stepParams.decision_title.trim()
        : "Decision Console";
    const recommendedAction =
      typeof stepParams.recommended_action === "string" && stepParams.recommended_action.trim()
        ? stepParams.recommended_action.trim()
        : typeof findings.decision === "string" && findings.decision.trim()
          ? findings.decision.trim()
          : recommendationObject && typeof recommendationObject.decision === "string" && recommendationObject.decision.trim()
            ? recommendationObject.decision.trim()
            : "REVIEW";
    const reason =
      typeof stepParams.reason === "string" && stepParams.reason.trim()
        ? stepParams.reason.trim()
        : typeof findings.primary_issue === "string" && findings.primary_issue.trim()
          ? findings.primary_issue.trim()
          : "Decision routed for operator review.";
    const confidence =
      typeof findings.confidence === "number"
        ? findings.confidence
        : recommendationObject && typeof recommendationObject.confidence === "number"
          ? recommendationObject.confidence
          : null;
    const supportingFindings = Array.isArray(stepParams.supporting_findings)
      ? stepParams.supporting_findings
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .map((value) => value.trim())
      : Array.isArray(findings.recommended_actions)
        ? (findings.recommended_actions as unknown[])
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .slice(0, 4)
        : [];
    const sourceUrl =
      (typeof stepParams.source_url === "string" && stepParams.source_url.trim()) ||
      (typeof stepParams.dataset_url === "string" && stepParams.dataset_url.trim()) ||
      discoveredSourceUrl ||
      "";
    const messageTemplate =
      typeof stepParams.messageTemplate === "string" && stepParams.messageTemplate.trim()
        ? stepParams.messageTemplate
        : `# Run Summary\n\n- Destination: ${destination}\n- Summary: ${summary}`;
    const includeContext = stepParams.includeContext === true;
    const contextPayload = includeContext ? runContext : undefined;

    if (mode === "change_gate") {
      const lastOutputRecord =
        runContext.lastOutput && typeof runContext.lastOutput === "object"
          ? (runContext.lastOutput as Record<string, unknown>)
          : null;
      const recentOutputs = summarySource.recentSteps
        .map((entry) => (entry.output && typeof entry.output === "object" ? (entry.output as Record<string, unknown>) : null))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));
      const dbUpdated = recentOutputs.some((output) => hasDbUpdateSignal(output));
      const actionToken = normalizeActionToken(
        stepParams.recommended_action ??
          lastOutputRecord?.recommended_action ??
          lastOutputRecord?.decision ??
          findings.recommended_action ??
          findings.decision
      );
      const yesActions = new Set([
        "INSPECT",
        "ESCALATE",
        "SPLIT_ORDER",
        "EXPEDITE",
        "DISPATCH_RESERVE",
        "ISSUE_ALERT",
        "QUARANTINE_BATCH",
        "RECHECK_PROCESS"
      ]);
      const noActions = new Set(["MONITOR", "MONITOR_GRID", "HOLD", "CONTINUE_MONITORING"]);
      const makeChange =
        yesActions.has(actionToken) ? "YES" : noActions.has(actionToken) ? "NO" : typeof confidence === "number" && confidence >= 0.7 ? "YES" : "NO";
      const suggestedAction = actionToken && actionToken !== "UNKNOWN" ? actionToken : makeChange === "YES" ? "ESCALATE" : "MONITOR";
      const gateReason =
        makeChange === "YES"
          ? `Recommended action ${actionToken || "UNKNOWN"} requires an operational change.`
          : `Recommended action ${actionToken || "UNKNOWN"} favors monitoring/no immediate change.`;
      const nonDbNote = dbUpdated
        ? "Recommendation includes a persisted update signal."
        : "No database update was performed; recommendation is based on workflow outputs and risk signals.";
      return {
        output: {
          outputMode: "change_gate",
          decision_title: "Make A Change",
          make_change: makeChange,
          recommended_action: suggestedAction,
          suggested_action: suggestedAction,
          reason: `${gateReason} ${nonDbNote}`,
          db_update_performed: dbUpdated,
          confidence,
          source_url: sourceUrl || null,
          supporting_findings: supportingFindings
        },
        confidence: typeof confidence === "number" ? clamp(confidence) : 0.8,
        rationale: "Deterministic change gate decision derived from Decision Console recommendation.",
        toolCalls,
        mockMode: false
      };
    }

    if (mode === "webhook") {
      const webhookUrl = String(stepParams.webhookUrl ?? "").trim();
      if (!webhookUrl) {
        return {
          output: {
            outputMode: "webhook",
            error: "Missing webhookUrl."
          },
          confidence: 0.2,
          rationale: "Webhook output mode selected but webhook URL is missing.",
          toolCalls,
          mockMode: true
        };
      }

      const payload = {
        message: messageTemplate,
        summary,
        destination,
        context: contextPayload ?? null
      };

      let statusCode = 0;
      let responseText = "";
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        });
        statusCode = response.status;
        responseText = await response.text();
      } catch (error) {
        return {
          output: {
            outputMode: "webhook",
            webhookUrl,
            sent: false,
            error: error instanceof Error ? error.message : "Webhook request failed."
          },
          confidence: 0.25,
          rationale: "Webhook request failed.",
          toolCalls: [
            ...toolCalls,
            {
              server: "webhook",
              tool: "post",
              args: { webhookUrl }
            }
          ],
          mockMode: false
        };
      }

      return {
        output: {
          outputMode: "webhook",
          webhookUrl,
          sent: statusCode >= 200 && statusCode < 300,
          statusCode,
          responseText: responseText.slice(0, 2000)
        },
        confidence: statusCode >= 200 && statusCode < 300 ? 0.92 : 0.45,
        rationale: `Webhook POST completed with status ${statusCode}.`,
        toolCalls: [
          ...toolCalls,
          {
            server: "webhook",
            tool: "post",
            args: { webhookUrl, statusCode }
          }
        ],
        mockMode: false
      };
    }

    const draftOutput = {
      outputMode: "run_summary",
      artifactType: "markdown",
      markdown: messageTemplate,
      summary,
      decision_title: decisionTitle,
      recommended_action: recommendedAction,
      decision: recommendedAction,
      reason,
      confidence,
      supporting_findings: supportingFindings,
      source_url: sourceUrl || null,
      dataset_url: sourceUrl || null,
      recipientGroup: destination,
      context: contextPayload ?? null
    };

    const baseConfidence = 0.93;
    const baseRationale = "Run summary artifact generated from run context.";

    const refined = await maybeRefineWithLlm(
      teamSettings,
      agentName,
      draftOutput,
      baseConfidence,
      baseRationale
    );

    return {
      output: draftOutput,
      confidence: refined.confidence,
      rationale: refined.rationale,
      toolCalls,
      mockMode: refined.mockMode
    };
  }

  const draftOutput = {
    message: `No implementation for ${agentName}`
  };

  return {
    output: draftOutput,
    confidence: 0.5,
    rationale: "Unknown task agent",
    toolCalls,
    mockMode: true
  };
}
