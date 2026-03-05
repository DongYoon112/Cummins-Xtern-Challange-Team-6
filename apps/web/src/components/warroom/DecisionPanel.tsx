import type { Decision } from "../../domain/Decision";
import type { Finding } from "../../domain/Finding";
import type { Recommendation } from "../../domain/Recommendation";
import type { RunEvent } from "../../domain/RunEvent";

type DecisionPanelProps = {
  events: RunEvent[];
  onDecision: (payload: Decision) => Promise<void>;
};

function parseRecommendation(event: RunEvent): Recommendation | null {
  if (event.kind !== "recommendation" || !event.data || typeof event.data !== "object") {
    return null;
  }

  const data = event.data as Record<string, unknown>;
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const parsedActions = actions
    .map((action) => (action && typeof action === "object" ? (action as Record<string, unknown>) : null))
    .filter((action): action is Record<string, unknown> => Boolean(action))
    .map((action) => ({
      actionId: typeof action.actionId === "string" ? action.actionId : "",
      title: typeof action.title === "string" ? action.title : "Untitled action",
      evidence_refs: Array.isArray(action.evidence_refs)
        ? action.evidence_refs.filter((item): item is string => typeof item === "string")
        : undefined
    }))
    .filter((action) => action.actionId);

  return {
    summary: typeof data.summary === "string" ? data.summary : undefined,
    actions: parsedActions
  };
}

function parseFinding(event: RunEvent): Finding | null {
  if (event.kind !== "finding" || !event.data || typeof event.data !== "object") {
    return null;
  }

  const data = event.data as Record<string, unknown>;
  const severity =
    data.severity === "low" || data.severity === "medium" || data.severity === "high" || data.severity === "critical"
      ? data.severity
      : "medium";
  const trend = data.trend === "up" || data.trend === "down" || data.trend === "flat" ? data.trend : undefined;

  return {
    severity,
    drivers: Array.isArray(data.drivers) ? data.drivers.filter((item): item is string => typeof item === "string") : [],
    riskScore: typeof data.riskScore === "number" ? data.riskScore : undefined,
    trend
  };
}

export function DecisionPanel({ events, onDecision }: DecisionPanelProps) {
  const latestRecommendationEvent = [...events].reverse().find((event) => event.kind === "recommendation") ?? null;
  const recommendation = latestRecommendationEvent ? parseRecommendation(latestRecommendationEvent) : null;
  const latestFindingEvent = [...events].reverse().find((event) => event.kind === "finding") ?? null;
  const finding = latestFindingEvent ? parseFinding(latestFindingEvent) : null;
  const decisionEvents = events.filter((event) => event.kind === "decision");

  return (
    <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-slate-900">Decision Panel</h2>

      <article className="rounded border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current situation</div>
        <div className="mt-1 text-sm text-slate-800">Risk score: {finding?.riskScore ?? "N/A"}</div>
        <div className="text-sm text-slate-800">Trend: {finding?.trend ?? "N/A"}</div>
      </article>

      <article className="rounded border border-slate-200 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recommended actions</div>
        {recommendation?.summary ? <p className="mt-2 text-sm text-slate-700">{recommendation.summary}</p> : null}

        <div className="mt-2 space-y-3">
          {(recommendation?.actions ?? []).map((action) => (
            <div className="rounded border border-slate-200 p-2" key={action.actionId}>
              <div className="text-sm font-medium text-slate-900">{action.title}</div>
              {action.evidence_refs?.length ? (
                <div className="mt-1 text-xs text-slate-600">Evidence: {action.evidence_refs.join(", ")}</div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white"
                  onClick={() => onDecision({ actionId: action.actionId, decision: "approve" })}
                  type="button"
                >
                  Approve
                </button>
                <button
                  className="rounded bg-rose-600 px-2 py-1 text-xs font-medium text-white"
                  onClick={() => onDecision({ actionId: action.actionId, decision: "reject" })}
                  type="button"
                >
                  Reject
                </button>
                <button
                  className="rounded bg-amber-500 px-2 py-1 text-xs font-medium text-white"
                  onClick={() =>
                    onDecision({
                      actionId: action.actionId,
                      decision: "more_evidence",
                      rationale: "Need supporting evidence before commitment."
                    })
                  }
                  type="button"
                >
                  More evidence
                </button>
              </div>
            </div>
          ))}
          {!recommendation || recommendation.actions.length === 0 ? (
            <p className="text-sm text-slate-500">No recommended actions yet.</p>
          ) : null}
        </div>
      </article>

      <article className="rounded border border-slate-200 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Decision log</div>
        <div className="mt-2 space-y-2">
          {decisionEvents.map((event) => (
            <div className="rounded border border-slate-200 bg-slate-50 p-2 text-sm text-slate-700" key={`${event.ts}-${event.title}`}>
              <div className="font-medium">{event.title}</div>
              <div className="text-xs text-slate-500">{new Date(event.ts).toLocaleString()}</div>
            </div>
          ))}
          {decisionEvents.length === 0 ? <p className="text-sm text-slate-500">No decisions submitted yet.</p> : null}
        </div>
      </article>
    </section>
  );
}
