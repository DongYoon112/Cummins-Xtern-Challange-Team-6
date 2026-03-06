import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

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

type ApprovalInsight = {
  gateType: string;
  reason: string;
  confidence?: number;
  ruleTriggers: string[];
  primaryIssue?: string;
  recommendation?: string;
  costImpactUSD?: number;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function buildApprovalInsight(approval: Approval): ApprovalInsight {
  const context = toRecord(approval.context) ?? {};
  const output = toRecord(context.output) ?? {};
  const incident = toRecord(output.incident);
  const recommendation = toRecord(output.finalRecommendation);

  const gateType = readString(context.gateType, approval.kind || "UNKNOWN");
  const reason = readString(context.reason, "Policy or workflow gate requires approval.");
  const confidence = readNumber(context.confidence) ?? readNumber(output.confidence);
  const primaryIssue =
    readString(incident?.primary_issue, "") || readString(output.primary_issue, "") || undefined;
  const finalDecision =
    readString(recommendation?.decision, "") || readString(output.recommendation, "") || undefined;
  const costImpactUSD = readNumber(output.costImpactUSD) ?? readNumber((incident ?? {}).costImpactUSD);

  const ruleTriggers: string[] = [];
  if (approval.kind === "APPROVAL_NODE") {
    ruleTriggers.push("Workflow has an explicit manual approval node.");
  }
  if (gateType === "POLICY_GATE") {
    ruleTriggers.push("Policy gate was triggered.");
  }
  if (typeof confidence === "number" && confidence < 0.6) {
    ruleTriggers.push(`Confidence ${confidence.toFixed(2)} is below threshold 0.60.`);
  }
  if (typeof costImpactUSD === "number" && costImpactUSD > 500) {
    ruleTriggers.push(`Cost impact ${costImpactUSD.toFixed(2)} exceeds threshold 500.`);
  }
  if (primaryIssue === "Unknown issue") {
    ruleTriggers.push("Primary issue is unresolved (Unknown issue).");
  }
  if (ruleTriggers.length === 0) {
    ruleTriggers.push("Approval gate requested by workflow policy.");
  }

  return {
    gateType,
    reason,
    confidence,
    ruleTriggers,
    primaryIssue,
    recommendation: finalDecision,
    costImpactUSD
  };
}

export function ApprovalsPage() {
  const { token } = useAuth();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [comment, setComment] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function loadApprovals() {
    const payload = await apiFetch<{ approvals: Approval[] }>("/approvals", {}, token ?? undefined);
    setApprovals(payload.approvals);
  }

  useEffect(() => {
    if (!token) {
      return;
    }

    loadApprovals().catch((err) => setError(err instanceof Error ? err.message : "Failed to load approvals"));
    const interval = window.setInterval(() => {
      loadApprovals().catch(() => undefined);
    }, 5000);

    return () => window.clearInterval(interval);
  }, [token]);

  async function decide(approvalId: string, decision: "APPROVE" | "REJECT") {
    setError(null);
    setStatus(null);

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
      await loadApprovals();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit decision");
    }
  }

  return (
    <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold">Pending Approvals</h2>

      {approvals.length === 0 ? <p className="text-sm text-slate-500">No pending approvals.</p> : null}

      {approvals.map((approval) => (
        <div className="rounded border border-amber-200 bg-amber-50 p-3" key={approval.id}>
          {(() => {
            const insight = buildApprovalInsight(approval);
            return (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">
                    {approval.stepName} ({approval.kind})
                  </div>
                  <span className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                    {insight.gateType}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Run {approval.runId} | Workflow {approval.workflowId}
                </div>

                <div className="mt-2 rounded border border-slate-200 bg-white p-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Why Approval Is Required</div>
                  <div className="mt-1 text-sm text-slate-900">{insight.reason}</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-700">
                    {insight.ruleTriggers.map((trigger, index) => (
                      <li key={`${approval.id}-trigger-${index}`}>{trigger}</li>
                    ))}
                  </ul>
                </div>

                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded border border-slate-200 bg-white p-2">
                    <div className="text-[11px] text-slate-500">Confidence</div>
                    <div className="text-sm font-semibold text-slate-900">
                      {typeof insight.confidence === "number" ? insight.confidence.toFixed(2) : "n/a"}
                    </div>
                  </div>
                  <div className="rounded border border-slate-200 bg-white p-2">
                    <div className="text-[11px] text-slate-500">Primary Issue</div>
                    <div className="text-sm font-semibold text-slate-900">{insight.primaryIssue ?? "n/a"}</div>
                  </div>
                  <div className="rounded border border-slate-200 bg-white p-2">
                    <div className="text-[11px] text-slate-500">Recommendation</div>
                    <div className="text-sm font-semibold text-slate-900">{insight.recommendation ?? "n/a"}</div>
                  </div>
                  <div className="rounded border border-slate-200 bg-white p-2">
                    <div className="text-[11px] text-slate-500">Cost Impact</div>
                    <div className="text-sm font-semibold text-slate-900">
                      {typeof insight.costImpactUSD === "number" ? insight.costImpactUSD.toFixed(2) : "n/a"}
                    </div>
                  </div>
                </div>

                <details className="mt-2 rounded border border-slate-200 bg-white">
                  <summary className="cursor-pointer px-2 py-1 text-xs font-semibold text-slate-700">Raw Approval Context</summary>
                  <pre className="overflow-auto rounded-b bg-slate-900 p-2 text-xs text-slate-100">
                    {JSON.stringify(approval.context, null, 2)}
                  </pre>
                </details>
              </>
            );
          })()}
          <textarea
            className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            onChange={(event) => {
              setComment((current) => ({ ...current, [approval.id]: event.target.value }));
            }}
            placeholder="Decision comment"
            rows={2}
            value={comment[approval.id] ?? ""}
          />
          <div className="mt-2 flex gap-2">
            <button
              className="rounded bg-emerald-700 px-3 py-1 text-sm text-white"
              onClick={() => decide(approval.id, "APPROVE")}
              type="button"
            >
              Approve
            </button>
            <button
              className="rounded bg-warn px-3 py-1 text-sm text-white"
              onClick={() => decide(approval.id, "REJECT")}
              type="button"
            >
              Reject
            </button>
          </div>
        </div>
      ))}

      {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
      {error ? <p className="text-sm text-warn">{error}</p> : null}
    </section>
  );
}
