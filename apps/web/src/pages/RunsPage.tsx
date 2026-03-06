import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { RunState, WorkflowSummary } from "../lib/types";

const MAX_TABLE_ROWS = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function DataTable({ rows, title }: { rows: Array<Record<string, unknown>>; title?: string }) {
  if (rows.length === 0) {
    return null;
  }
  const columns = Object.keys(rows[0] ?? {}).slice(0, 12);
  const visibleRows = rows.slice(0, MAX_TABLE_ROWS);
  return (
    <div className="mt-2 rounded border border-slate-200">
      {title ? <div className="border-b border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700">{title}</div> : null}
      <div className="overflow-auto">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {columns.map((column) => (
                <th className="border-b border-slate-200 px-2 py-1 text-left font-semibold" key={column}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <tr className="border-b border-slate-100" key={index}>
                {columns.map((column) => (
                  <td className="max-w-[260px] truncate px-2 py-1 text-slate-800" key={column} title={formatCell(row[column])}>
                    {formatCell(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_TABLE_ROWS ? (
        <div className="border-t border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
          Showing {MAX_TABLE_ROWS} of {rows.length} rows.
        </div>
      ) : null}
    </div>
  );
}

function OutputView({ output }: { output: unknown }) {
  if (output === null || output === undefined) {
    return null;
  }

  if (typeof output === "string" || typeof output === "number" || typeof output === "boolean") {
    return <div className="mt-2 rounded bg-slate-50 px-2 py-1 text-xs text-slate-700">{String(output)}</div>;
  }

  if (Array.isArray(output)) {
    if (output.every((item) => isRecord(item))) {
      return <DataTable rows={output as Array<Record<string, unknown>>} title="Rows" />;
    }
    return (
      <pre className="mt-2 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{JSON.stringify(output.slice(0, 30), null, 2)}</pre>
    );
  }

  if (!isRecord(output)) {
    return <pre className="mt-2 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{JSON.stringify(output, null, 2)}</pre>;
  }

  const engineRows = Array.isArray(output.engine_rows) && output.engine_rows.every((item) => isRecord(item))
    ? (output.engine_rows as Array<Record<string, unknown>>)
    : null;
  const summaryEntries = Object.entries(output).filter(([, value]) => {
    return value === null || ["string", "number", "boolean"].includes(typeof value);
  });
  const nestedEntries = Object.entries(output).filter(([, value]) => {
    return value !== null && !["string", "number", "boolean"].includes(typeof value) && value !== engineRows;
  });

  return (
    <div className="mt-2 space-y-2">
      {summaryEntries.length > 0 ? (
        <div className="overflow-auto rounded border border-slate-200">
          <table className="min-w-full text-xs">
            <tbody>
              {summaryEntries.map(([key, value]) => (
                <tr className="border-b border-slate-100" key={key}>
                  <td className="w-40 bg-slate-50 px-2 py-1 font-semibold text-slate-700">{key}</td>
                  <td className="px-2 py-1 text-slate-800">{formatCell(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {engineRows ? <DataTable rows={engineRows} title="engine_rows" /> : null}
      {nestedEntries.map(([key, value]) => (
        <details className="rounded border border-slate-200" key={key}>
          <summary className="cursor-pointer bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700">{key}</summary>
          <pre className="overflow-auto bg-slate-900 p-2 text-xs text-slate-100">{JSON.stringify(value, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}

function parseRunResult(output: unknown) {
  if (!isRecord(output)) {
    return null;
  }

  const summary = typeof output.summary === "string" ? output.summary : "";
  const markdown = typeof output.markdown === "string" ? output.markdown : "";
  const recipientGroup = typeof output.recipientGroup === "string" ? output.recipientGroup : "";

  let details: Record<string, unknown> | null = null;
  if (markdown.includes("{") && markdown.includes("}")) {
    const start = markdown.indexOf("{");
    const end = markdown.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        details = JSON.parse(markdown.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        details = null;
      }
    }
  }

  if (!summary && !markdown && !recipientGroup && !details) {
    return null;
  }

  return { summary, markdown, recipientGroup, details };
}

function readLlmExecution(output: unknown) {
  if (!output || typeof output !== "object") {
    return null;
  }
  const meta = (output as Record<string, unknown>).llm_execution;
  if (!meta || typeof meta !== "object") {
    return null;
  }
  const value = meta as Record<string, unknown>;
  return {
    provider: typeof value.provider === "string" ? value.provider : "",
    model: typeof value.model === "string" ? value.model : "",
    llmUsed: value.llm_used === true,
    mockMode: value.mock_mode === true,
    reason: typeof value.reason === "string" ? value.reason : ""
  };
}

export function RunsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { token } = useAuth();
  const [runs, setRuns] = useState<RunState[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflowToRun, setWorkflowToRun] = useState<string>("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadRuns() {
    const payload = await apiFetch<{ runs: RunState[] }>("/runs", {}, token ?? undefined);
    const ordered = [...(payload.runs ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    setRuns(ordered);
    if (ordered.length > 0) {
      const preferred = ordered.find((run) => run.status === "COMPLETED") ?? ordered[0];
      setSelectedRunId((current) => current ?? preferred.runId);
    }
  }

  async function loadWorkflows() {
    const payload = await apiFetch<{ workflows: WorkflowSummary[] }>("/workflows", {}, token ?? undefined);
    const next = payload.workflows ?? [];
    setWorkflows(next);
    if (next.length > 0) {
      setWorkflowToRun((current) => current || next[0].workflowId);
    }
  }

  async function startRun() {
    setError(null);
    setStatus(null);
    if (!workflowToRun) {
      setError("Select a workflow first.");
      return;
    }

    try {
      const payload = await apiFetch<{ run: RunState }>(
        "/runs",
        {
          method: "POST",
          body: JSON.stringify({ workflowId: workflowToRun })
        },
        token ?? undefined
      );
      setStatus(`Run started: ${payload.run.runId}`);
      setSelectedRunId(payload.run.runId);
      navigate(`/run?runId=${encodeURIComponent(payload.run.runId)}`);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    }
  }

  async function loadRun(runId: string) {
    const payload = await apiFetch<{ run: RunState }>(`/runs/${runId}`, {}, token ?? undefined);
    setSelectedRun(payload.run);
  }

  useEffect(() => {
    if (!token) {
      return;
    }

    loadRuns().catch((err) => setError(err instanceof Error ? err.message : "Failed to load runs"));
    loadWorkflows().catch((err) => setError(err instanceof Error ? err.message : "Failed to load workflows"));
    const interval = window.setInterval(() => {
      loadRuns().catch(() => undefined);
    }, 4000);

    return () => window.clearInterval(interval);
  }, [token]);

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const runIdFromQuery = query.get("runId");
    if (!runIdFromQuery) {
      return;
    }
    setSelectedRunId(runIdFromQuery);
  }, [location.search]);

  useEffect(() => {
    if (!token || !selectedRunId) {
      return;
    }

    loadRun(selectedRunId).catch((err) => setError(err instanceof Error ? err.message : "Failed to load run"));
    const interval = window.setInterval(() => {
      loadRun(selectedRunId).catch(() => undefined);
    }, 2000);

    return () => window.clearInterval(interval);
  }, [token, selectedRunId]);

  const activeRun = useMemo(() => {
    return selectedRun ?? runs.find((candidate) => candidate.runId === selectedRunId) ?? null;
  }, [selectedRun, runs, selectedRunId]);
  const latestCompletedRun = useMemo(() => runs.find((run) => run.status === "COMPLETED") ?? null, [runs]);
  const debateStep = useMemo(() => {
    if (!activeRun) {
      return null;
    }
    return activeRun.steps.find((step) => step.name.toLowerCase().includes("debate")) ?? null;
  }, [activeRun]);
  const outputStep = useMemo(() => {
    if (!activeRun) {
      return null;
    }
    const namedOutput = activeRun.steps.find((step) => step.name.toLowerCase().includes("output") && step.output);
    if (namedOutput) {
      return namedOutput;
    }
    return [...activeRun.steps].reverse().find((step) => step.output) ?? null;
  }, [activeRun]);
  const runResult = useMemo(() => parseRunResult(outputStep?.output), [outputStep]);

  return (
    <div className="grid gap-4 lg:grid-cols-[320px,1fr]">
      <section className="rounded border border-slate-200 bg-white p-4">
        <div className="mb-2 text-sm font-semibold">Run</div>
        <div className="mb-3 space-y-2 rounded border border-slate-200 bg-slate-50 p-2">
          <label className="block text-xs text-slate-700">
            Workflow
            <select
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              onChange={(event) => setWorkflowToRun(event.target.value)}
              value={workflowToRun}
            >
              {workflows.map((workflow) => (
                <option key={workflow.workflowId} value={workflow.workflowId}>
                  {workflow.name} ({workflow.workflowId})
                </option>
              ))}
            </select>
          </label>
          <button className="w-full rounded bg-slate-900 px-3 py-1 text-sm text-white" onClick={startRun} type="button">
            Start Run
          </button>
        </div>

        {status ? <p className="mb-2 text-xs text-emerald-700">{status}</p> : null}

        <div className="mb-2 text-sm font-semibold">Recent Runs</div>
        <button
          className="mb-2 w-full rounded border border-slate-300 px-3 py-1 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!latestCompletedRun}
          onClick={() => {
            if (latestCompletedRun) {
              setSelectedRunId(latestCompletedRun.runId);
            }
          }}
          type="button"
        >
          Jump To Latest Completed Result
        </button>
        <div className="space-y-2">
          {runs.map((run) => (
            <button
              className={`w-full rounded border px-3 py-2 text-left text-sm ${
                selectedRunId === run.runId ? "border-accent bg-orange-50" : "border-slate-200"
              }`}
              key={run.runId}
              onClick={() => setSelectedRunId(run.runId)}
              type="button"
            >
              <div className="font-medium">{run.workflowName}</div>
              <div className="text-xs text-slate-500">{run.runId}</div>
              <div className="mt-1 text-xs">Status: {run.status}</div>
            </button>
          ))}
          {runs.length === 0 ? <p className="text-sm text-slate-500">No runs yet.</p> : null}
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        {!activeRun ? (
          <p className="text-sm text-slate-500">Select a run to inspect details.</p>
        ) : (
          <div>
            <div className="mb-3 grid gap-2 md:grid-cols-3">
              <div className="rounded bg-slate-50 p-2 text-sm">
                <div className="text-xs text-slate-500">Workflow</div>
                <div className="font-medium">
                  {activeRun.workflowName} v{activeRun.workflowVersion}
                </div>
              </div>
              <div className="rounded bg-slate-50 p-2 text-sm">
                <div className="text-xs text-slate-500">Run ID</div>
                <div className="font-mono text-xs">{activeRun.runId}</div>
              </div>
              <div className="rounded bg-slate-50 p-2 text-sm">
                <div className="text-xs text-slate-500">Status</div>
                <div className="font-medium">{activeRun.status}</div>
              </div>
            </div>

            <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-3">
              {runResult ? (
                <div className="mb-3 rounded border border-emerald-200 bg-white p-3">
                  <div className="text-sm font-semibold text-emerald-900">Run Result</div>
                  {runResult.summary ? <div className="mt-1 text-sm text-slate-800">{runResult.summary}</div> : null}
                  {runResult.recipientGroup ? (
                    <div className="mt-1 text-xs text-slate-600">Recipient: {runResult.recipientGroup}</div>
                  ) : null}
                  {runResult.markdown ? (
                    <pre className="mt-2 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{runResult.markdown}</pre>
                  ) : null}
                  {runResult.details ? (
                    <div className="mt-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">Parsed Details</div>
                      <OutputView output={runResult.details} />
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="text-sm font-semibold text-slate-900">Completed Results</div>
              <div className="mt-1 text-xs text-slate-600">
                Debate:{" "}
                {debateStep
                  ? `${debateStep.status}${typeof debateStep.confidence === "number" ? ` (confidence ${debateStep.confidence.toFixed(2)})` : ""}`
                  : "Not found"}
              </div>
              <div className="mt-1 text-xs text-slate-600">
                Output: {outputStep ? `${outputStep.name} (${outputStep.status})` : "No output payload yet"}
              </div>
              {outputStep?.output ? <OutputView output={outputStep.output} /> : null}
            </div>

            <div className="space-y-2">
              {activeRun.steps.map((step, index) => (
                <div className="rounded border border-slate-200 p-3" key={step.stepId}>
                  {(() => {
                    const llm = readLlmExecution(step.output);
                    if (!llm) {
                      return null;
                    }
                    return (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        <span className={`rounded px-2 py-0.5 ${llm.llmUsed ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                          {llm.llmUsed ? "LLM Used" : "Mock/Fallback"}
                        </span>
                        {llm.provider ? <span className="rounded bg-slate-100 px-2 py-0.5">{llm.provider}</span> : null}
                        {llm.model ? <span className="rounded bg-slate-100 px-2 py-0.5">{llm.model}</span> : null}
                        {llm.reason ? <span className="text-slate-600">{llm.reason}</span> : null}
                      </div>
                    );
                  })()}
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">
                      {index + 1}. {step.name}
                    </div>
                    <div className="rounded bg-slate-100 px-2 py-1 text-xs">{step.status}</div>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {step.kind} {step.agentName ? `- ${step.agentName}` : ""}
                  </div>
                  {step.output ? <OutputView output={step.output} /> : null}
                  {typeof step.confidence === "number" ? (
                    <div className="mt-2 text-xs text-slate-600">
                      Confidence: {step.confidence.toFixed(2)}
                    </div>
                  ) : null}
                  {step.rationale ? <div className="mt-1 text-xs text-slate-600">Rationale: {step.rationale}</div> : null}
                </div>
              ))}
            </div>

            {activeRun.error ? <p className="mt-2 text-sm text-warn">{activeRun.error}</p> : null}
          </div>
        )}

        {error ? <p className="mt-2 text-sm text-warn">{error}</p> : null}
      </section>
    </div>
  );
}
