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
        <div className="rounded border border-slate-200 p-3" key={approval.id}>
          <div className="text-sm font-medium">
            {approval.stepName} ({approval.kind})
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Run {approval.runId} | Workflow {approval.workflowId}
          </div>
          <pre className="mt-2 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
            {JSON.stringify(approval.context, null, 2)}
          </pre>
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