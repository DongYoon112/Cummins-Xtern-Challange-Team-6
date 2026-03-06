import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { summarizeRunForReport } from "../lib/runReport";
import type { RunState } from "../lib/types";

function statusClass(status: RunState["status"]) {
  if (status === "COMPLETED") return "bg-emerald-100 text-emerald-800 border-emerald-300";
  if (status === "FAILED" || status === "REJECTED") return "bg-rose-100 text-rose-800 border-rose-300";
  if (status === "WAITING_APPROVAL") return "bg-amber-100 text-amber-800 border-amber-300";
  return "bg-slate-100 text-slate-700 border-slate-300";
}

function formatDate(value?: string) {
  if (!value) {
    return "n/a";
  }
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    return value;
  }
  return new Date(ts).toLocaleString();
}

export function RunReportPage() {
  const { token } = useAuth();
  const { runId = "" } = useParams();
  const [run, setRun] = useState<RunState | null>(null);
  const [overallReview, setOverallReview] = useState<string>("");
  const [overallReviewLoading, setOverallReviewLoading] = useState(false);
  const [overallReviewError, setOverallReviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token || !runId) {
      return;
    }
    setLoading(true);
    setError(null);
    apiFetch<{ run: RunState }>(`/runs/${encodeURIComponent(runId)}/report`, {}, token)
      .then((payload) => {
        setRun(payload.run);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load run report");
      })
      .finally(() => setLoading(false));
  }, [runId, token]);

  useEffect(() => {
    if (!token || !runId) {
      return;
    }
    setOverallReviewLoading(true);
    setOverallReviewError(null);
    apiFetch<{ overallReview: string; provider: string; model: string; mockMode: boolean }>(
      `/runs/${encodeURIComponent(runId)}/overall-review`,
      { method: "POST", body: JSON.stringify({}) },
      token
    )
      .then((payload) => {
        setOverallReview(payload.overallReview);
      })
      .catch((err) => {
        setOverallReviewError(err instanceof Error ? err.message : "Failed to generate overall review");
      })
      .finally(() => setOverallReviewLoading(false));
  }, [runId, token]);

  const report = useMemo(() => (run ? summarizeRunForReport(run) : null), [run]);
  const stepSummaryByName = useMemo(() => {
    if (!report) {
      return new Map<string, string>();
    }
    return new Map(report.timeline.map((item) => [item.step.name, item.summary]));
  }, [report]);

  const insightCards = useMemo(() => {
    if (!report) {
      return [];
    }
    return report.findings.map((finding) => ({
      ...finding,
      evidence: finding.sourceStepName ? stepSummaryByName.get(finding.sourceStepName) : undefined
    }));
  }, [report, stepSummaryByName]);

  if (loading) {
    return <div className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading report...</div>;
  }

  if (!run || !report) {
    return (
      <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-slate-900">Workflow Report Dashboard</h2>
        <p className="text-sm text-warn">{error ?? "Run report not available."}</p>
        <Link className="inline-flex rounded border border-slate-300 px-3 py-1 text-sm text-slate-700" to="/run">
          Back to Runs
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Workflow Report Dashboard</h1>
            <p className="mt-1 text-sm text-slate-700">{report.headline}</p>
          </div>
          <div className={`rounded border px-2 py-1 text-xs font-semibold ${statusClass(run.status)}`}>{run.status}</div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-5">
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Workflow</div>
            <div className="text-sm font-semibold text-slate-900">{run.workflowName}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Run ID</div>
            <div className="truncate font-mono text-xs text-slate-800">{run.runId}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Started</div>
            <div className="text-xs text-slate-800">{formatDate(run.startedAt)}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Finished</div>
            <div className="text-xs text-slate-800">{formatDate(run.completedAt ?? run.updatedAt)}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Total Steps</div>
            <div className="text-sm font-semibold text-slate-900">{run.steps.length}</div>
          </div>
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-slate-900">Run Overview</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Status</div>
            <div className="text-sm font-semibold text-slate-900">{run.status}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Duration</div>
            <div className="text-sm font-semibold text-slate-900">{report.durationLabel}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Steps Executed</div>
            <div className="text-sm font-semibold text-slate-900">{report.stepsExecuted}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Approvals Triggered</div>
            <div className="text-sm font-semibold text-slate-900">{report.approvalsTriggered}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Final Decision/Action</div>
            <div className="text-sm font-semibold text-slate-900">{report.finalDecision}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] text-slate-500">Confidence</div>
            <div className="text-sm font-semibold text-slate-900">{report.confidence}</div>
          </div>
        </div>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-slate-900">Overall Review</h2>
        <p className="mt-2 text-sm leading-6 text-slate-800">
          {overallReviewLoading ? "generating..." : overallReview || report.finalNarrative}
        </p>
        {overallReviewError ? <p className="mt-1 text-xs text-warn">{overallReviewError}</p> : null}
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Why this matters</div>
          <p className="mt-1 text-sm text-slate-800">{report.headline}</p>
        </div>
        {insightCards.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No key insights were detected from the run outputs.</p>
        ) : (
          <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {insightCards.map((finding) => (
              <article className="rounded border border-slate-200 bg-slate-50 p-3" key={`${finding.key}-${finding.sourceStepName ?? ""}`}>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{finding.label}</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">{finding.value}</div>
                {finding.sourceStepName ? <div className="mt-1 text-[11px] text-slate-500">From: {finding.sourceStepName}</div> : null}
                {finding.evidence ? <p className="mt-2 text-xs leading-5 text-slate-700">Interpretation: {finding.evidence}</p> : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-slate-900">Database Persistence</h2>
        {!report.dbPersistence.present ? (
          <p className="mt-2 text-sm text-slate-500">No DB write step detected in this run.</p>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <div className="text-[11px] text-slate-500">Success</div>
              <div className="text-sm font-semibold text-slate-900">{report.dbPersistence.success ? "Yes" : "No"}</div>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <div className="text-[11px] text-slate-500">Target DB</div>
              <div className="text-sm font-semibold text-slate-900">{report.dbPersistence.target ?? "n/a"}</div>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <div className="text-[11px] text-slate-500">Table</div>
              <div className="text-sm font-semibold text-slate-900">{report.dbPersistence.table ?? "n/a"}</div>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <div className="text-[11px] text-slate-500">Insert ID</div>
              <div className="text-sm font-semibold text-slate-900">{report.dbPersistence.insertId ?? "n/a"}</div>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <div className="text-[11px] text-slate-500">Record ID</div>
              <div className="text-sm font-semibold text-slate-900">{report.dbPersistence.recordId ?? "n/a"}</div>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <div className="text-[11px] text-slate-500">Status</div>
              <div className="text-sm font-semibold text-slate-900">{report.dbPersistence.status ?? "n/a"}</div>
            </div>
          </div>
        )}
        {report.dbPersistence.error ? <p className="mt-2 text-sm text-warn">{report.dbPersistence.error}</p> : null}
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-slate-900">Raw Data</h2>
        <details className="mt-2 rounded border border-slate-200">
          <summary className="cursor-pointer bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700">Run JSON</summary>
          <pre className="max-h-96 overflow-auto rounded-b bg-slate-900 p-2 text-[11px] text-slate-100">{JSON.stringify(run, null, 2)}</pre>
        </details>
        <details className="mt-2 rounded border border-slate-200">
          <summary className="cursor-pointer bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700">Step Outputs JSON</summary>
          <pre className="max-h-96 overflow-auto rounded-b bg-slate-900 p-2 text-[11px] text-slate-100">
            {JSON.stringify(
              run.steps.map((step) => ({
                stepId: step.stepId,
                name: step.name,
                status: step.status,
                output: step.output ?? null
              })),
              null,
              2
            )}
          </pre>
        </details>
      </section>
    </div>
  );
}
