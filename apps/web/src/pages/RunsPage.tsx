import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { RunState } from "../lib/types";

export function RunsPage() {
  const { token } = useAuth();
  const [runs, setRuns] = useState<RunState[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadRuns() {
    const payload = await apiFetch<{ runs: RunState[] }>("/runs", {}, token ?? undefined);
    setRuns(payload.runs);
    if (!selectedRunId && payload.runs.length > 0) {
      setSelectedRunId(payload.runs[0].runId);
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
    const interval = window.setInterval(() => {
      loadRuns().catch(() => undefined);
    }, 4000);

    return () => window.clearInterval(interval);
  }, [token]);

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

  return (
    <div className="grid gap-4 lg:grid-cols-[320px,1fr]">
      <section className="rounded border border-slate-200 bg-white p-4">
        <div className="mb-2 text-sm font-semibold">Runs</div>
        <div className="space-y-2">
          {runs.map((run) => (
            <button
              className={`w-full rounded border px-3 py-2 text-left text-sm ${
                selectedRunId === run.runId ? "border-accent bg-cyan-50" : "border-slate-200"
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