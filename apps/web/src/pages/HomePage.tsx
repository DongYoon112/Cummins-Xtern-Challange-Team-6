import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { RunState, WorkflowSummary } from "../lib/types";

type Approval = {
  id: string;
};

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

export function HomePage() {
  const { token, user } = useAuth();
  const [runs, setRuns] = useState<RunState[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>("");

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const [runsPayload, workflowsPayload, approvalsPayload] = await Promise.all([
          apiFetch<{ runs: RunState[] }>("/runs", {}, token),
          apiFetch<{ workflows: WorkflowSummary[] }>("/workflows", {}, token),
          apiFetch<{ approvals: Approval[] }>("/approvals", {}, token).catch(() => ({ approvals: [] as Approval[] }))
        ]);

        if (cancelled) {
          return;
        }

        setRuns(runsPayload.runs ?? []);
        setWorkflows(workflowsPayload.workflows ?? []);
        setApprovals(approvalsPayload.approvals ?? []);
        setUpdatedAt(new Date().toLocaleTimeString());
        setError(null);
      } catch (err) {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load home metrics.");
      }
    };

    load().catch(() => undefined);
    const interval = window.setInterval(() => {
      load().catch(() => undefined);
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [token]);

  const stats = useMemo(() => {
    const totalOperations = runs.reduce((sum, run) => sum + run.steps.length, 0);
    const completedOperations = runs.reduce(
      (sum, run) => sum + run.steps.filter((step) => step.status === "COMPLETED").length,
      0
    );
    const responsesReceived = runs.reduce((sum, run) => sum + run.steps.filter((step) => step.output != null).length, 0);
    const activeRuns = runs.filter((run) => run.status === "RUNNING" || run.status === "PENDING").length;
    const finishedRuns = runs.filter((run) => run.status === "COMPLETED").length;
    const failedRuns = runs.filter((run) => run.status === "FAILED" || run.status === "REJECTED").length;
    const successRate = finishedRuns + failedRuns > 0 ? (finishedRuns / (finishedRuns + failedRuns)) * 100 : 100;
    const estimatedApiCredits = Math.round(completedOperations * 2.4 + responsesReceived * 0.8);

    return {
      totalOperations,
      completedOperations,
      responsesReceived,
      activeRuns,
      successRate,
      estimatedApiCredits
    };
  }, [runs]);

  return (
    <div className="space-y-4">
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-slate-900">Home Dashboard</h2>
        <p className="text-sm text-slate-600">
          Team overview for {user?.teamId}. Last updated: {updatedAt || "loading..."}
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <article className="rounded border border-slate-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">API Credits</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{formatNumber(stats.estimatedApiCredits)}</div>
          <p className="mt-1 text-xs text-slate-500">Derived from persisted run operations and response output volume.</p>
        </article>
        <article className="rounded border border-slate-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Responses Received</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{formatNumber(stats.responsesReceived)}</div>
          <p className="mt-1 text-xs text-slate-500">Run steps that produced output payloads.</p>
        </article>
        <article className="rounded border border-slate-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Operations</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{formatNumber(stats.totalOperations)}</div>
          <p className="mt-1 text-xs text-slate-500">
            Completed: {formatNumber(stats.completedOperations)} across all workflow runs.
          </p>
        </article>
        <article className="rounded border border-slate-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Success Rate</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{formatPercent(stats.successRate)}</div>
          <p className="mt-1 text-xs text-slate-500">Based on completed vs failed/rejected runs.</p>
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">Run Activity</h3>
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between rounded bg-slate-50 px-3 py-2">
              <span className="text-slate-600">Active runs</span>
              <span className="font-semibold text-slate-900">{formatNumber(stats.activeRuns)}</span>
            </div>
            <div className="flex items-center justify-between rounded bg-slate-50 px-3 py-2">
              <span className="text-slate-600">Total runs</span>
              <span className="font-semibold text-slate-900">{formatNumber(runs.length)}</span>
            </div>
            <div className="flex items-center justify-between rounded bg-slate-50 px-3 py-2">
              <span className="text-slate-600">Pending approvals</span>
              <span className="font-semibold text-slate-900">{formatNumber(approvals.length)}</span>
            </div>
          </div>
        </article>

        <article className="rounded border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">Workflow Inventory</h3>
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between rounded bg-slate-50 px-3 py-2 text-sm">
              <span className="text-slate-600">Total workflows</span>
              <span className="font-semibold text-slate-900">{formatNumber(workflows.length)}</span>
            </div>
            <div className="max-h-52 space-y-2 overflow-auto pr-1">
              {workflows.slice(0, 6).map((workflow) => (
                <div className="rounded border border-slate-200 px-3 py-2" key={workflow.workflowId}>
                  <div className="text-sm font-medium text-slate-900">{workflow.name}</div>
                  <div className="text-xs text-slate-500">
                    v{workflow.latestVersion} - {new Date(workflow.updatedAt).toLocaleString()}
                  </div>
                </div>
              ))}
              {workflows.length === 0 ? <p className="text-sm text-slate-500">No workflows found.</p> : null}
            </div>
          </div>
        </article>
      </section>

      {error ? <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-warn">{error}</p> : null}
    </div>
  );
}
