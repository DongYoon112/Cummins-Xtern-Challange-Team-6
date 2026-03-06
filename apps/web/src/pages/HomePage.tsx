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

type ChartDatum = {
  label: string;
  value: number;
  color: string;
};

const DAY_BUCKETS = 7;

function DonutChart({ data, size = 172 }: { data: ChartDatum[]; size?: number }) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const radius = size / 2 - 14;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  if (total === 0) {
    return (
      <div className="flex h-[172px] items-center justify-center rounded bg-slate-50 text-sm text-slate-500">
        No data
      </div>
    );
  }

  return (
    <svg className="mx-auto" height={size} viewBox={`0 0 ${size} ${size}`} width={size}>
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {data.map((item) => {
          const segmentLength = (item.value / total) * circumference;
          const node = (
            <circle
              cx={size / 2}
              cy={size / 2}
              fill="transparent"
              key={item.label}
              r={radius}
              stroke={item.color}
              strokeDasharray={`${segmentLength} ${circumference - segmentLength}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              strokeWidth="14"
            />
          );
          offset += segmentLength;
          return node;
        })}
      </g>
      <text className="fill-slate-900 text-2xl font-semibold" textAnchor="middle" x={size / 2} y={size / 2}>
        {total}
      </text>
      <text className="fill-slate-500 text-xs" textAnchor="middle" x={size / 2} y={size / 2 + 18}>
        Total Runs
      </text>
    </svg>
  );
}

export function HomePage() {
  const { token, user } = useAuth();
  const [runs, setRuns] = useState<RunState[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [approvalsUnavailable, setApprovalsUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>("");

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;
    const canSeeApprovals = user?.role === "ADMIN" || user?.role === "APPROVER";

    const load = async () => {
      try {
        const [runsPayload, workflowsPayload] = await Promise.all([
          apiFetch<{ runs: RunState[] }>("/runs", {}, token),
          apiFetch<{ workflows: WorkflowSummary[] }>("/workflows", {}, token)
        ]);

        let approvalsPayload: { approvals: Approval[] } = { approvals: [] };
        let approvalsDenied = false;
        if (canSeeApprovals) {
          try {
            approvalsPayload = await apiFetch<{ approvals: Approval[] }>("/approvals", {}, token);
          } catch {
            approvalsDenied = true;
          }
        }

        if (cancelled) {
          return;
        }

        setRuns(runsPayload.runs ?? []);
        setWorkflows(workflowsPayload.workflows ?? []);
        setApprovals(approvalsPayload.approvals ?? []);
        setApprovalsUnavailable(approvalsDenied);
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
  }, [token, user?.role]);

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
    const pendingGates = runs.reduce(
      (sum, run) => sum + run.steps.filter((step) => step.status === "WAITING_APPROVAL").length,
      0
    );

    return {
      totalOperations,
      completedOperations,
      responsesReceived,
      activeRuns,
      successRate,
      estimatedApiCredits,
      pendingGates
    };
  }, [runs]);

  const runStatusChart = useMemo<ChartDatum[]>(() => {
    const statuses: Array<{ label: string; color: string; test: (run: RunState) => boolean }> = [
      { label: "Completed", color: "#16a34a", test: (run) => run.status === "COMPLETED" },
      { label: "Running", color: "#0284c7", test: (run) => run.status === "RUNNING" || run.status === "PENDING" },
      { label: "Waiting", color: "#d97706", test: (run) => run.status === "WAITING_APPROVAL" },
      { label: "Failed/Rejected", color: "#dc2626", test: (run) => run.status === "FAILED" || run.status === "REJECTED" }
    ];

    return statuses.map((entry) => ({
      label: entry.label,
      value: runs.filter(entry.test).length,
      color: entry.color
    }));
  }, [runs]);

  const stepStatusChart = useMemo<ChartDatum[]>(() => {
    const steps = runs.flatMap((run) => run.steps);
    const rows: Array<{ label: string; color: string; test: (status: string) => boolean }> = [
      { label: "Completed", color: "bg-emerald-500", test: (status) => status === "COMPLETED" },
      { label: "Running", color: "bg-sky-500", test: (status) => status === "RUNNING" },
      { label: "Waiting", color: "bg-amber-500", test: (status) => status === "WAITING_APPROVAL" },
      { label: "Failed/Rejected", color: "bg-rose-500", test: (status) => status === "FAILED" || status === "REJECTED" },
      { label: "Pending", color: "bg-slate-400", test: (status) => status === "PENDING" }
    ];

    return rows.map((row) => ({
      label: row.label,
      value: steps.filter((step) => row.test(step.status)).length,
      color: row.color
    }));
  }, [runs]);

  const runVolume = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    const today = new Date();
    const dayStarts = Array.from({ length: DAY_BUCKETS }, (_, index) => {
      const day = new Date(today);
      day.setHours(0, 0, 0, 0);
      day.setDate(today.getDate() - (DAY_BUCKETS - 1 - index));
      return day;
    });

    const counts = dayStarts.map((dayStart) => {
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      return runs.filter((run) => {
        const startedAt = Date.parse(run.startedAt);
        return !Number.isNaN(startedAt) && startedAt >= dayStart.getTime() && startedAt < dayEnd.getTime();
      }).length;
    });

    return dayStarts.map((day, index) => ({
      label: formatter.format(day),
      value: counts[index]
    }));
  }, [runs]);

  const runVolumeMax = Math.max(1, ...runVolume.map((item) => item.value));

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
              <span className="text-slate-600">Pending gates</span>
              <span className="font-semibold text-slate-900">{formatNumber(stats.pendingGates)}</span>
            </div>
            <div className="text-xs text-slate-500">
              Approval queue: {approvalsUnavailable ? "unavailable" : formatNumber(approvals.length)} | Router waits are included in
              pending gates.
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

      <section className="grid gap-4 xl:grid-cols-3">
        <article className="rounded border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">Run Status Distribution</h3>
          <div className="mt-2">
            <DonutChart data={runStatusChart} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            {runStatusChart.map((entry) => (
              <div className="flex items-center justify-between rounded bg-slate-50 px-2 py-1" key={entry.label}>
                <span className="flex items-center gap-1 text-slate-600">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
                  {entry.label}
                </span>
                <span className="font-semibold text-slate-900">{formatNumber(entry.value)}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="rounded border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">Step Status Mix</h3>
          <div className="mt-3 space-y-3">
            {stepStatusChart.map((entry) => {
              const total = stepStatusChart.reduce((sum, row) => sum + row.value, 0);
              const ratio = total > 0 ? (entry.value / total) * 100 : 0;
              return (
                <div key={entry.label}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-slate-600">{entry.label}</span>
                    <span className="font-medium text-slate-900">
                      {formatNumber(entry.value)} ({formatPercent(ratio)})
                    </span>
                  </div>
                  <div className="h-2 rounded bg-slate-100">
                    <div className={`h-2 rounded ${entry.color}`} style={{ width: `${Math.max(ratio, 2)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </article>

        <article className="rounded border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">7-Day Run Activity</h3>
          <div className="mt-3 flex h-40 items-end gap-2 rounded bg-slate-50 p-3">
            {runVolume.map((entry) => (
              <div className="flex min-w-0 flex-1 flex-col items-center justify-end" key={entry.label}>
                <div className="w-full rounded-t bg-slate-900/80" style={{ height: `${Math.max((entry.value / runVolumeMax) * 100, 4)}%` }} />
                <div className="mt-1 text-[11px] font-medium text-slate-700">{entry.value}</div>
                <div className="truncate text-[10px] text-slate-500">{entry.label}</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">Bars represent runs started each day.</p>
        </article>
      </section>

      {error ? <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-warn">{error}</p> : null}
    </div>
  );
}
