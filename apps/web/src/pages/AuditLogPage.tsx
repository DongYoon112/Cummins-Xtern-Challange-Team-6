import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

type AuditRecord = {
  id: string;
  timestamp: string;
  runId: string;
  workflowId: string;
  stepId: string;
  agentName: string;
  confidence: number;
  rationale: string;
  output: unknown;
};

export function AuditLogPage() {
  const { token } = useAuth();
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [runId, setRunId] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function query() {
    setError(null);

    try {
      const params = new URLSearchParams();
      if (runId) {
        params.set("runId", runId);
      }
      if (workflowId) {
        params.set("workflowId", workflowId);
      }
      if (agentName) {
        params.set("agentName", agentName);
      }

      const payload = await apiFetch<{ records: AuditRecord[] }>(
        `/audit${params.toString() ? `?${params.toString()}` : ""}`,
        {},
        token ?? undefined
      );
      setRecords(payload.records);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to query audit records");
    }
  }

  useEffect(() => {
    if (!token) {
      return;
    }

    query().catch(() => undefined);
  }, [token]);

  function exportJson() {
    const blob = new Blob([JSON.stringify({ records }, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "audit-export.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold">Audit Log</h2>

      <div className="grid gap-2 md:grid-cols-4">
        <input
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          onChange={(event) => setRunId(event.target.value)}
          placeholder="runId"
          value={runId}
        />
        <input
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          onChange={(event) => setWorkflowId(event.target.value)}
          placeholder="workflowId"
          value={workflowId}
        />
        <input
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          onChange={(event) => setAgentName(event.target.value)}
          placeholder="agentName"
          value={agentName}
        />
        <div className="flex gap-2">
          <button className="rounded bg-accent px-3 py-1 text-sm text-white" onClick={query} type="button">
            Filter
          </button>
          <button className="rounded border border-slate-300 px-3 py-1 text-sm" onClick={exportJson} type="button">
            Export JSON
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {records.map((record) => (
          <div className="rounded border border-slate-200 p-3" key={record.id}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{record.agentName}</span>
              <span className="text-xs text-slate-500">{record.timestamp}</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              run {record.runId} | workflow {record.workflowId} | step {record.stepId}
            </div>
            <div className="mt-1 text-xs">confidence: {record.confidence.toFixed(2)}</div>
            <div className="mt-1 text-sm text-slate-700">{record.rationale}</div>
          </div>
        ))}
        {records.length === 0 ? <p className="text-sm text-slate-500">No records found.</p> : null}
      </div>

      {error ? <p className="text-sm text-warn">{error}</p> : null}
    </section>
  );
}