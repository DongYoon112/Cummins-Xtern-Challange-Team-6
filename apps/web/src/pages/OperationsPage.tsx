import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { RunState, WorkflowSummary } from "../lib/types";

type Approval = {
  id: string;
  runId: string;
  workflowId: string;
  stepId: string;
  stepName: string;
  kind: string;
  requestedAt: string;
  context: Record<string, unknown>;
};

function formatTime(value?: string) {
  if (!value) {
    return "n/a";
  }
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? value : new Date(ts).toLocaleString();
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

export function OperationsPage() {
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const [runs, setRuns] = useState<RunState[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunState | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflowToRun, setWorkflowToRun] = useState("");
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [comment, setComment] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canDecide = user?.role === "APPROVER" || user?.role === "ADMIN";

  async function loadRuns() {
    const payload = await apiFetch<{ runs: RunState[] }>("/runs", {}, token ?? undefined);
    setRuns(payload.runs ?? []);
    if (!selectedRunId && payload.runs.length > 0) {
      setSelectedRunId(payload.runs[0].runId);
    }
  }

  async function loadRun(runId: string) {
    const payload = await apiFetch<{ run: RunState }>(`/runs/${runId}`, {}, token ?? undefined);
    setSelectedRun(payload.run);
  }

  async function loadWorkflows() {
    const payload = await apiFetch<{ workflows: WorkflowSummary[] }>("/workflows", {}, token ?? undefined);
    const next = payload.workflows ?? [];
    setWorkflows(next);
    if (!workflowToRun && next.length > 0) {
      setWorkflowToRun(next[0].workflowId);
    }
  }

  async function loadApprovals() {
    if (!canDecide) {
      setApprovals([]);
      return;
    }
    const payload = await apiFetch<{ approvals: Approval[] }>("/approvals", {}, token ?? undefined);
    setApprovals(payload.approvals ?? []);
  }

  async function startRun() {
    setStatus(null);
    setError(null);
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

  async function decideApproval(approvalId: string, decision: "APPROVE" | "REJECT") {
    setStatus(null);
    setError(null);
    try {
      await apiFetch(
        `/approvals/${approvalId}/decision`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            comment: comment[approvalId] ?? ""
          })
        },
        token ?? undefined
      );
      setStatus(`Decision submitted: ${decision}`);
      await Promise.all([loadApprovals(), loadRuns()]);
      if (selectedRunId) {
        await loadRun(selectedRunId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process approval");
    }
  }

  useEffect(() => {
    if (!token) {
      return;
    }

    loadRuns().catch((err) => setError(err instanceof Error ? err.message : "Failed to load runs"));
    loadWorkflows().catch((err) => setError(err instanceof Error ? err.message : "Failed to load workflows"));
    loadApprovals().catch(() => undefined);

    const interval = window.setInterval(() => {
      loadRuns().catch(() => undefined);
      loadApprovals().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(interval);
  }, [token, canDecide]);

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

  const activeRun = useMemo(
    () => selectedRun ?? runs.find((entry) => entry.runId === selectedRunId) ?? null,
    [runs, selectedRun, selectedRunId]
  );

  const waitingRuns = runs.filter((run) => run.status === "WAITING_APPROVAL");

  return (
    <div className="grid gap-4 xl:grid-cols-[300px,minmax(0,1fr),360px]">
      <section className="rounded border border-slate-200 bg-white p-4">
        <div className="mb-2 text-sm font-semibold">Operations</div>
        <label className="block text-xs text-slate-700">
          Start workflow run
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
        <button className="mt-2 w-full rounded bg-slate-900 px-3 py-1 text-sm text-white" onClick={startRun} type="button">
          Start Run
        </button>

        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
          Active runs: {runs.length} | Waiting approval: {waitingRuns.length}
        </div>

        <div className="mt-3 text-sm font-semibold">Run list</div>
        <div className="mt-2 space-y-2">
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
        <div className="mb-2 text-sm font-semibold">Process View</div>
        {!activeRun ? (
          <p className="text-sm text-slate-500">Select a run to inspect process timeline.</p>
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

            <div className="space-y-2">
              {activeRun.steps.map((step, index) => (
                <div className="rounded border border-slate-200 p-3" key={step.stepId}>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">
                      {index + 1}. {step.name}
                    </div>
                    <div className="rounded bg-slate-100 px-2 py-1 text-xs">{step.status}</div>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {step.kind} {step.agentName ? `- ${step.agentName}` : ""}
                  </div>
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
                  {step.output ? (
                    <pre className="mt-2 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
                      {JSON.stringify(step.output, null, 2)}
                    </pre>
                  ) : null}
                  {typeof step.confidence === "number" ? (
                    <div className="mt-2 text-xs text-slate-600">
                      Confidence: {step.confidence.toFixed(2)}
                    </div>
                  ) : null}
                  {step.rationale ? <div className="mt-1 text-xs text-slate-600">Rationale: {step.rationale}</div> : null}
                </div>
              ))}
            </div>

            <div className="mt-3 text-xs text-slate-500">
              Started: {formatTime(activeRun.startedAt)} | Updated: {formatTime(activeRun.updatedAt)} | Completed:{" "}
              {formatTime(activeRun.completedAt)}
            </div>
            {activeRun.error ? <p className="mt-2 text-sm text-warn">{activeRun.error}</p> : null}
          </div>
        )}
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <div className="mb-2 text-sm font-semibold">Human-in-the-Loop</div>
        {!canDecide ? (
          <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            Your role is not approver. You can still monitor runs in <code>Process View</code>.
          </div>
        ) : approvals.length === 0 ? (
          <p className="text-sm text-slate-500">No pending approvals.</p>
        ) : (
          <div className="space-y-3">
            {approvals.map((approval) => (
              <div className="rounded border border-slate-200 p-3" key={approval.id}>
                <div className="text-sm font-medium">
                  {approval.stepName} ({approval.kind})
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Run {approval.runId} | Workflow {approval.workflowId} | Requested {formatTime(approval.requestedAt)}
                </div>
                <pre className="mt-2 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
                  {JSON.stringify(approval.context, null, 2)}
                </pre>
                <textarea
                  className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  onChange={(event) => setComment((current) => ({ ...current, [approval.id]: event.target.value }))}
                  placeholder="Decision comment"
                  rows={2}
                  value={comment[approval.id] ?? ""}
                />
                <div className="mt-2 flex gap-2">
                  <button
                    className="rounded bg-emerald-700 px-3 py-1 text-sm text-white"
                    onClick={() => decideApproval(approval.id, "APPROVE")}
                    type="button"
                  >
                    Approve
                  </button>
                  <button
                    className="rounded bg-warn px-3 py-1 text-sm text-white"
                    onClick={() => decideApproval(approval.id, "REJECT")}
                    type="button"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {status ? <p className="text-sm text-emerald-700 xl:col-span-3">{status}</p> : null}
      {error ? <p className="text-sm text-warn xl:col-span-3">{error}</p> : null}
    </div>
  );
}
