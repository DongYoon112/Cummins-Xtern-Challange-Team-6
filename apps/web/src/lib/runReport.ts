import type { RunState, RunStep } from "./types";

type Primitive = string | number | boolean | null | undefined;

export type ReportFinding = {
  key: string;
  label: string;
  value: string;
  sourceStepName?: string;
};

export type ReportTimelineItem = {
  step: RunStep;
  index: number;
  summary: string;
};

export type DbPersistenceSummary = {
  present: boolean;
  success: boolean;
  target?: string;
  table?: string;
  insertId?: string;
  recordId?: string;
  status?: string;
  stepName?: string;
  error?: string;
};

export type RunReportSummary = {
  headline: string;
  durationLabel: string;
  stepsExecuted: number;
  approvalsTriggered: number;
  finalDecision: string;
  confidence: string;
  findings: ReportFinding[];
  timeline: ReportTimelineItem[];
  finalNarrative: string;
  dbPersistence: DbPersistenceSummary;
};

const FINDING_LABELS_BY_KEY: Record<string, string> = {
  dataset: "Dataset",
  dataset_url: "Dataset URL",
  source_url: "Source URL",
  unit_id: "Unit ID",
  primary_issue: "Primary Issue",
  confidence: "Confidence",
  hypotheses: "Hypotheses",
  recommended_actions: "Recommended Actions",
  recommended_action: "Recommended Action",
  make_change: "Make Change",
  suggested_action: "Suggested Action",
  db_update_performed: "DB Update Performed",
  decision_title: "Decision Title",
  reason: "Reason",
  supporting_findings: "Supporting Findings",
  transcript_summary: "Transcript Summary",
  stock_risk: "Stock Risk",
  supplier_risk: "Supplier Risk",
  policy_decision: "Policy Decision",
  top_anomalies: "Top Anomalies",
  selectedcarrier: "Selected Carrier",
  shippingcostusd: "Shipping Cost (USD)",
  insert_id: "DB Insert ID",
  incident_id: "Incident ID",
  po_id: "PO ID",
  decision: "Decision",
  finalrecommendation: "Final Recommendation"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toShortText(value: Primitive, max = 180) {
  const text = value === null || value === undefined ? "" : String(value);
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

function valueToDisplay(value: unknown): string {
  if (value === null || value === undefined) {
    return "n/a";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return toShortText(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const subset = value.slice(0, 3).map((entry) => {
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
        return String(entry);
      }
      if (isRecord(entry)) {
        if (typeof entry.sensor === "string") {
          const score = typeof entry.anomaly_score === "number" ? ` (${entry.anomaly_score.toFixed(2)})` : "";
          return `${entry.sensor}${score}`;
        }
        if (typeof entry.label === "string") {
          return entry.label;
        }
      }
      return "[item]";
    });
    return value.length > 3 ? `${subset.join(", ")} +${value.length - 3} more` : subset.join(", ");
  }
  if (isRecord(value)) {
    const decision = value.decision;
    if (typeof decision === "string" && decision.trim()) {
      return decision;
    }
  }
  return "[object]";
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const FINDING_LABELS = Object.entries(FINDING_LABELS_BY_KEY).reduce<Record<string, string>>((acc, [key, label]) => {
  acc[normalizeKey(key)] = label;
  return acc;
}, {});

const FINDING_KEYS = new Set(Object.keys(FINDING_LABELS));

function collectFindingsFromValue(
  value: unknown,
  sourceStepName: string,
  output: Map<string, ReportFinding>,
  depth = 0
) {
  if (depth > 5 || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) {
      collectFindingsFromValue(item, sourceStepName, output, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const normalized = normalizeKey(rawKey);
    if (FINDING_KEYS.has(normalized) && !output.has(normalized)) {
      output.set(normalized, {
        key: normalized,
        label: FINDING_LABELS[normalized] ?? rawKey,
        value: valueToDisplay(rawValue),
        sourceStepName
      });
    }
    if (normalized === "finalrecommendation" && isRecord(rawValue)) {
      if (!output.has("decision") && typeof rawValue.decision === "string") {
        output.set("decision", {
          key: "decision",
          label: "Decision",
          value: String(rawValue.decision),
          sourceStepName
        });
      }
      if (!output.has("confidence") && typeof rawValue.confidence === "number") {
        output.set("confidence", {
          key: "confidence",
          label: "Confidence",
          value: rawValue.confidence.toFixed(2),
          sourceStepName
        });
      }
    }
    collectFindingsFromValue(rawValue, sourceStepName, output, depth + 1);
  }
}

export function summarizeStepOutput(step: RunStep): string {
  if (step.status === "FAILED") {
    return step.rationale ? `Failed: ${toShortText(step.rationale, 140)}` : "Step failed during execution.";
  }

  const output = step.output;
  if (!output) {
    return step.rationale ? toShortText(step.rationale, 140) : "No output produced.";
  }

  if (typeof output === "string") {
    return toShortText(output, 140);
  }

  if (isRecord(output)) {
    if (typeof output.error === "string" && output.error.trim()) {
      return `Error: ${toShortText(output.error, 140)}`;
    }
    if (output.finalRecommendation && isRecord(output.finalRecommendation)) {
      const decision = typeof output.finalRecommendation.decision === "string" ? output.finalRecommendation.decision : "N/A";
      const confidence =
        typeof output.finalRecommendation.confidence === "number"
          ? ` (${output.finalRecommendation.confidence.toFixed(2)})`
          : "";
      return `Debate recommendation: ${decision}${confidence}`;
    }
    if (typeof output.primary_issue === "string" && output.primary_issue.trim()) {
      return `Primary issue: ${toShortText(output.primary_issue, 130)}`;
    }
    if (typeof output.summary === "string" && output.summary.trim()) {
      return toShortText(output.summary, 140);
    }
    if (typeof output.status === "string" && typeof output.db_target === "string") {
      const table = typeof output.table === "string" ? ` (${output.table})` : "";
      return `Database write ${output.status} to ${output.db_target}${table}.`;
    }
    if (isRecord(output.incident) && typeof output.incident.incident_id === "string") {
      return `Prepared incident payload ${output.incident.incident_id}.`;
    }
    const primitives = Object.entries(output)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 2)
      .map(([key, value]) => `${key}: ${valueToDisplay(value)}`);
    if (primitives.length > 0) {
      return primitives.join(" | ");
    }
  }

  return step.rationale ? toShortText(step.rationale, 140) : "Output captured.";
}

function formatDuration(startedAt: string, endedAt?: string) {
  const startTs = Date.parse(startedAt);
  const endTs = Date.parse(endedAt ?? "");
  if (Number.isNaN(startTs) || Number.isNaN(endTs) || endTs <= startTs) {
    return "n/a";
  }
  const totalMs = endTs - startTs;
  const seconds = Math.floor(totalMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${remSeconds}s`;
}

function deriveDbPersistence(run: RunState): DbPersistenceSummary {
  const candidate = [...run.steps]
    .reverse()
    .find((step) => step.agentName === "DbWriteAgent" || step.name.toLowerCase().includes("db write"));
  if (!candidate || !candidate.output || !isRecord(candidate.output)) {
    return { present: false, success: false };
  }
  const output = candidate.output;
  const status = typeof output.status === "string" ? output.status : candidate.status.toLowerCase();
  const success = status === "inserted" || candidate.status === "COMPLETED";
  const target = typeof output.db_target === "string" ? output.db_target : undefined;
  const table = typeof output.table === "string" ? output.table : undefined;
  const insertId = typeof output.insert_id === "string" ? output.insert_id : undefined;
  const recordId =
    (typeof output.incident_id === "string" ? output.incident_id : undefined) ??
    (typeof output.po_id === "string" ? output.po_id : undefined);
  const error = typeof output.error === "string" ? output.error : candidate.rationale;
  return {
    present: true,
    success,
    target,
    table,
    insertId,
    recordId,
    status,
    stepName: candidate.name,
    error
  };
}

function deriveFinalDecision(findings: Map<string, ReportFinding>) {
  return (
    findings.get("decision")?.value ??
    findings.get("recommendedaction")?.value ??
    findings.get("finalrecommendation")?.value ??
    "n/a"
  );
}

function deriveConfidence(findings: Map<string, ReportFinding>, run: RunState) {
  const found = findings.get("confidence")?.value;
  if (found && found !== "n/a") {
    return found;
  }
  const stepConfidence = [...run.steps]
    .reverse()
    .find((step) => typeof step.confidence === "number")?.confidence;
  return typeof stepConfidence === "number" ? stepConfidence.toFixed(2) : "n/a";
}

function deriveHeadline(run: RunState, findings: Map<string, ReportFinding>, db: DbPersistenceSummary) {
  if (run.status !== "COMPLETED") {
    return run.error ? `Run ended with error: ${run.error}` : `Run finished with status ${run.status}.`;
  }
  const primaryIssue = findings.get("primary_issue")?.value;
  const decision = deriveFinalDecision(findings);
  if (primaryIssue && db.present && db.success) {
    return `The run identified "${primaryIssue}" and successfully stored the result.`;
  }
  if (decision !== "n/a") {
    return `The run completed with a ${decision} decision.`;
  }
  return "The run completed successfully.";
}

function deriveFinalNarrative(
  run: RunState,
  findings: Map<string, ReportFinding>,
  db: DbPersistenceSummary,
  timeline: ReportTimelineItem[]
) {
  let incidentDataset = findings.get("dataset")?.value;
  let incidentUnitId: number | null = null;
  for (const item of timeline) {
    if (!isRecord(item.step.output) || !isRecord(item.step.output.incident)) {
      continue;
    }
    const incident = item.step.output.incident as Record<string, unknown>;
    if (!incidentDataset && typeof incident.dataset === "string" && incident.dataset.trim()) {
      incidentDataset = incident.dataset;
    }
    if (incidentUnitId === null && typeof incident.unit_id === "number" && Number.isFinite(incident.unit_id)) {
      incidentUnitId = incident.unit_id;
    }
  }
  const unitSuffix = incidentUnitId !== null ? ` for unit ${incidentUnitId}` : "";
  const rawPrimaryIssue = findings.get("primary_issue")?.value;
  const primaryIssue = rawPrimaryIssue && rawPrimaryIssue !== "n/a" ? rawPrimaryIssue : "an issue";
  const confidence = deriveConfidence(findings, run);
  const confidenceText = confidence === "n/a" ? "with no confidence score reported" : `with a confidence score of ${confidence}`;
  const decision = deriveFinalDecision(findings);
  const sourceUrl = findings.get("sourceurl")?.value ?? findings.get("dataseturl")?.value ?? null;
  const dbClause = db.present
    ? db.success
      ? `The result was saved to ${db.table ?? "the target table"} in ${db.target ?? "the configured database"}.`
      : `The database write did not complete${db.error ? `: ${db.error}.` : "."}`
    : "No database write step was executed.";
  const stepCount = timeline.length;
  const stepText = stepCount === 1 ? "1 step" : `${stepCount} steps`;
  const datasetText = incidentDataset ? ` using dataset ${incidentDataset}${unitSuffix}` : "";
  const decisionText = decision !== "n/a" ? ` The final decision was ${decision}.` : "";
  const sourceText = sourceUrl && sourceUrl !== "n/a" ? ` Source: ${sourceUrl}.` : "";
  return `This run executed ${stepText}${datasetText}, identified ${primaryIssue}, and finished ${confidenceText}.${decisionText}${sourceText} ${dbClause}`;
}

export function summarizeRunForReport(run: RunState): RunReportSummary {
  const stepsExecuted = run.steps.filter((step) => step.status !== "PENDING").length;
  const approvalsTriggered = new Set(run.steps.map((step) => step.approvalId).filter(Boolean)).size;
  const timeline = run.steps.map((step, index) => ({
    step,
    index: index + 1,
    summary: summarizeStepOutput(step)
  }));

  const findingsMap = new Map<string, ReportFinding>();
  for (const step of run.steps) {
    collectFindingsFromValue(step.output, step.name, findingsMap);
  }
  const dbPersistence = deriveDbPersistence(run);
  const finalDecision = deriveFinalDecision(findingsMap);
  const confidence = deriveConfidence(findingsMap, run);
  const headline = deriveHeadline(run, findingsMap, dbPersistence);
  const finalNarrative = deriveFinalNarrative(run, findingsMap, dbPersistence, timeline);

  const findings = Array.from(findingsMap.values())
    .filter((item) => item.value && item.value !== "n/a")
    .slice(0, 14);

  return {
    headline,
    durationLabel: formatDuration(run.startedAt, run.completedAt ?? run.updatedAt),
    stepsExecuted,
    approvalsTriggered,
    finalDecision,
    confidence,
    findings,
    timeline,
    finalNarrative,
    dbPersistence
  };
}
