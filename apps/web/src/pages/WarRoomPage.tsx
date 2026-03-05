import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { API_BASE, apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

type RunStatus = "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "REJECTED" | "FAILED";

type WarRoomEventType = "AGENT_ALERT" | "DEBATE_RESULT" | "ROUTER_DECISION_REQUIRED" | "WORKFLOW_STATUS_UPDATE";

type WarRoomEvent = {
  id?: number;
  runId: string;
  workflowId: string;
  stepId?: string;
  type: WarRoomEventType;
  timestamp: string;
  payload: Record<string, unknown>;
};

type WarRoomDecision = {
  id: string;
  runId: string;
  workflowId: string;
  routerStepId: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decision?: "approve" | "reject" | null;
  requestedAt: string;
  decidedAt?: string | null;
};

type WarRoomSnapshot = {
  run: { runId: string; workflowId: string; status: RunStatus } | null;
  events: WarRoomEvent[];
  runSteps: Array<Record<string, unknown>>;
  activeSteps: Array<Record<string, unknown>>;
  pendingDecisions: WarRoomDecision[];
};

function readString(value: unknown, fallback = "N/A") {
  return typeof value === "string" ? value : fallback;
}

function mergeEvents(current: WarRoomEvent[], incoming: WarRoomEvent[]) {
  const map = new Map<string, WarRoomEvent>();
  for (const event of current) {
    map.set(`${event.id ?? "noid"}-${event.timestamp}-${event.type}-${event.stepId ?? ""}`, event);
  }
  for (const event of incoming) {
    map.set(`${event.id ?? "noid"}-${event.timestamp}-${event.type}-${event.stepId ?? ""}`, event);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function WarRoomPage() {
  const { token } = useAuth();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get("runId") ?? "";
  const [events, setEvents] = useState<WarRoomEvent[]>([]);
  const [runSteps, setRunSteps] = useState<Array<Record<string, unknown>>>([]);
  const [activeSteps, setActiveSteps] = useState<Array<Record<string, unknown>>>([]);
  const [pendingDecisions, setPendingDecisions] = useState<WarRoomDecision[]>([]);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportText, setReportText] = useState("");

  useEffect(() => {
    if (!token || !runId) {
      return;
    }

    apiFetch<WarRoomSnapshot>(`/api/war-room/${encodeURIComponent(runId)}/events`, {}, token)
      .then((snapshot) => {
        setEvents(snapshot.events ?? []);
        setRunSteps(snapshot.runSteps ?? []);
        setActiveSteps(snapshot.activeSteps ?? []);
        setPendingDecisions(snapshot.pendingDecisions ?? []);
        setRunStatus(snapshot.run?.status ?? null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load War Room snapshot");
      });
  }, [runId, token]);

  useEffect(() => {
    if (!token || !runId) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    const consumeStream = async () => {
      const response = await fetch(`${API_BASE}/api/war-room/${encodeURIComponent(runId)}/stream`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`Failed to connect stream: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "message";
      let currentData = "";

      const flush = () => {
        if (!currentData.trim()) {
          currentEvent = "message";
          currentData = "";
          return;
        }
        if (currentEvent === "event") {
          try {
            const payload = JSON.parse(currentData) as WarRoomEvent;
            setEvents((current) => mergeEvents(current, [payload]));
            if (payload.type === "WORKFLOW_STATUS_UPDATE") {
              const nextStatus = payload.payload.status;
              if (typeof nextStatus === "string") {
                setRunStatus(nextStatus as RunStatus);
              }
            }
          } catch {
            // Ignore malformed stream payload chunks.
          }
        }
        currentEvent = "message";
        currentData = "";
      };

      while (!cancelled) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line) {
            flush();
            continue;
          }
          if (line.startsWith(":")) {
            continue;
          }
          if (line.startsWith("event:")) {
            currentEvent = line.slice("event:".length).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            currentData += line.slice("data:".length).trim();
          }
        }
      }
    };

    consumeStream().catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "War Room stream disconnected");
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runId, token]);

  useEffect(() => {
    if (!token || !runId) {
      return;
    }
    const timer = window.setInterval(() => {
      apiFetch<WarRoomSnapshot>(`/api/war-room/${encodeURIComponent(runId)}/events`, {}, token)
        .then((snapshot) => {
          setRunSteps(snapshot.runSteps ?? []);
          setActiveSteps(snapshot.activeSteps ?? []);
          setPendingDecisions(snapshot.pendingDecisions ?? []);
          setRunStatus(snapshot.run?.status ?? null);
        })
        .catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [runId, token]);

  const threatFeed = useMemo(() => events.filter((event) => event.type === "AGENT_ALERT"), [events]);
  const debateFeed = useMemo(() => events.filter((event) => event.type === "DEBATE_RESULT"), [events]);
  const timeline = useMemo(
    () => [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)),
    [events]
  );
  const activeStepIds = useMemo(() => {
    const ids = new Set<string>();
    for (const step of activeSteps) {
      const candidate = step.stepId ?? step.id;
      if (typeof candidate === "string" && candidate.trim()) {
        ids.add(candidate);
      }
    }
    return ids;
  }, [activeSteps]);
  const workflowFlow = useMemo(() => {
    return runSteps
      .map((step) => {
        const stepId = typeof step.stepId === "string" ? step.stepId : "";
        const stepName = typeof step.name === "string" ? step.name : stepId;
        const kind = typeof step.kind === "string" ? step.kind : "STEP";
        const status = typeof step.status === "string" ? step.status : "PENDING";
        if (!stepId) {
          return null;
        }
        return { id: stepId, label: stepName || stepId, kind, status };
      })
      .filter((step): step is { id: string; label: string; kind: string; status: string } => Boolean(step));
  }, [runSteps]);
  const recentEventCount = useMemo(() => {
    const now = Date.now();
    return timeline.filter((event) => now - Date.parse(event.timestamp) <= 120_000).length;
  }, [timeline]);
  const requestsInFlight = Math.max(activeSteps.length, Math.min(8, Math.max(2, Math.ceil(recentEventCount / 2))));

  function appendDebatesToReport() {
    if (debateFeed.length === 0) {
      setStatus("No debate results available.");
      return;
    }
    const section = debateFeed
      .map((event, index) => {
        const payload = event.payload;
        const args = Array.isArray(payload.arguments)
          ? payload.arguments
              .map((arg, argIndex) => {
                const row = arg && typeof arg === "object" ? (arg as Record<string, unknown>) : {};
                return `- Arg ${argIndex + 1}: ${readString(row.provider, "model")}/${readString(row.model, "default")} ${readString(row.summary, "")}`.trim();
              })
              .join("\n")
          : "No arguments";
        return [
          `### Debate ${index + 1}`,
          `- Time: ${new Date(event.timestamp).toLocaleString()}`,
          `- Topic: ${readString(payload.topic)}`,
          `- Recommendation: ${readString(payload.finalRecommendation)}`,
          args
        ].join("\n");
      })
      .join("\n\n");
    setReportText((current) => (current ? `${current}\n\n${section}` : section));
    setStatus(`Appended ${debateFeed.length} debate result(s).`);
  }

  function downloadReport() {
    const content = reportText.trim();
    if (!content) {
      setStatus("Report is empty.");
      return;
    }
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `war-room-report-${runId}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Report downloaded.");
  }

  async function submitDecision(routerStepId: string, decision: "approve" | "reject") {
    if (!token || !runId) {
      return;
    }
    try {
      await apiFetch<{ run: { status: RunStatus } }>(
        "/api/war-room/decision",
        {
          method: "POST",
          body: JSON.stringify({ runId, routerStepId, decision })
        },
        token
      );
      setStatus(`Decision submitted: ${decision} (${routerStepId})`);
      const snapshot = await apiFetch<WarRoomSnapshot>(`/api/war-room/${encodeURIComponent(runId)}/events`, {}, token);
      setRunSteps(snapshot.runSteps ?? []);
      setActiveSteps(snapshot.activeSteps ?? []);
      setPendingDecisions(snapshot.pendingDecisions ?? []);
      setRunStatus(snapshot.run?.status ?? null);
      setEvents((current) => mergeEvents(current, snapshot.events ?? []));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit decision");
    }
  }

  if (!runId) {
    return <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">Missing runId query param.</div>;
  }

  return (
    <div className="space-y-4">
      <section className="rounded border border-slate-200 bg-slate-900 p-4 text-slate-100">
        <h1 className="text-xl font-semibold">War Room</h1>
        <p className="mt-1 text-sm text-slate-300">Live orchestration dashboard for workflow execution and procurement response.</p>
        <div className="mt-2 text-xs text-slate-300">
          Run: <span className="font-mono">{runId}</span> | Status: <span className="font-semibold">{runStatus ?? "unknown"}</span>
        </div>
      </section>

      {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
      {error ? <p className="text-sm text-warn">{error}</p> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(460px,1.4fr)_minmax(0,1fr)]">
        <section className="flex min-h-[520px] flex-col rounded border border-cyan-200 bg-cyan-50 p-4 xl:col-start-2 xl:row-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-cyan-900">Live Workflow Flow</h2>
            <div className="text-xs text-cyan-800">
              Active steps: <span className="font-semibold">{activeSteps.length}</span> | Request signals:{" "}
              <span className="font-semibold">{recentEventCount}</span>
            </div>
          </div>
          <div className="mt-3 flex flex-1 items-center overflow-x-auto pb-2">
            {workflowFlow.length === 0 ? (
              <p className="text-sm text-slate-600">No workflow steps loaded for this run yet.</p>
            ) : (
              <div className="inline-flex min-w-full items-center gap-2">
              {workflowFlow.map((step, index) => {
                const isActive = activeStepIds.has(step.id);
                return (
                  <div className="flex items-center gap-2" key={step.id}>
                    <article
                      className={[
                        "min-w-[130px] rounded border bg-white px-3 py-2",
                        isActive
                          ? "border-emerald-300 shadow-[0_0_0_2px_rgba(16,185,129,0.2)]"
                          : "border-cyan-200"
                      ].join(" ")}
                    >
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">{step.kind}</div>
                      <div className="text-sm font-medium text-slate-900">{step.label}</div>
                      <div className={["text-[11px]", isActive ? "text-emerald-700" : "text-slate-500"].join(" ")}>
                        {isActive ? "processing" : step.status.toLowerCase()}
                      </div>
                    </article>
                    {index < workflowFlow.length - 1 ? (
                      <div className="relative h-2 w-20 overflow-hidden rounded-full bg-cyan-100 sm:w-28">
                        <div className="absolute inset-y-0 left-0 right-0 my-auto h-[2px] bg-cyan-300" />
                        {Array.from({ length: requestsInFlight }).map((_, dotIndex) => (
                          <span
                            className="war-room-flow-dot absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-cyan-500"
                            key={`${step.id}-dot-${dotIndex}`}
                            style={{
                              animationDelay: `${dotIndex * 0.35}s`,
                              animationDuration: `${2.2 + (dotIndex % 3) * 0.4}s`
                            }}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-600">Moving dots represent request packets traversing step-to-step workflow links.</p>
        </section>

        <section className="rounded border border-rose-200 bg-rose-50 p-4 xl:col-start-1 xl:row-start-1">
          <h2 className="text-lg font-semibold text-rose-900">Threat Feed</h2>
          <div className="mt-3 space-y-2">
            {threatFeed.map((event) => (
              <article className="rounded border border-rose-200 bg-white p-3" key={`${event.id ?? event.timestamp}-${event.stepId ?? ""}`}>
                <div className="text-sm font-medium text-slate-900">{readString(event.payload.summary, event.stepId ?? "Agent alert")}</div>
                <div className="text-xs text-slate-500">{new Date(event.timestamp).toLocaleString()}</div>
                <div className="mt-1 text-xs text-rose-800">
                  Category: {readString(event.payload.category)} | Severity: {readString(event.payload.severity, "medium")} | Risk:{" "}
                  {readString(event.payload.riskScore, "n/a")}
                </div>
              </article>
            ))}
            {threatFeed.length === 0 ? <p className="text-sm text-slate-500">No active alerts.</p> : null}
          </div>
        </section>

        <section className="rounded border border-orange-200 bg-orange-50 p-4 xl:col-start-3 xl:row-start-1">
          <h2 className="text-lg font-semibold text-orange-900">AI Debate Panel</h2>
          <div className="mt-3 space-y-2">
            {debateFeed.map((event, index) => (
              <article className="rounded border border-orange-200 bg-white p-3" key={`${event.id ?? event.timestamp}-${index}`}>
                <div className="text-sm font-medium text-slate-900">{readString(event.payload.topic, event.stepId ?? "Debate")}</div>
                <div className="mt-1 text-xs text-orange-800">Final: {readString(event.payload.finalRecommendation)}</div>
                <div className="mt-1 text-xs text-slate-500">Confidence: {readString(event.payload.confidence, "n/a")}</div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-600">Arguments</summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">
                    {JSON.stringify(event.payload.arguments ?? [], null, 2)}
                  </pre>
                </details>
              </article>
            ))}
            {debateFeed.length === 0 ? <p className="text-sm text-slate-500">No debate results yet.</p> : null}
          </div>
          <div className="mt-3 rounded border border-orange-200 bg-white p-3">
            <div className="flex flex-wrap gap-2">
              <button className="rounded bg-orange-600 px-2 py-1 text-xs font-medium text-white" onClick={appendDebatesToReport} type="button">
                Append Debate Results
              </button>
              <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={downloadReport} type="button">
                Download Report
              </button>
              <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => setReportText("")} type="button">
                Clear
              </button>
            </div>
            <textarea
              className="mt-2 h-32 w-full rounded border border-slate-300 bg-white p-2 font-mono text-[11px] text-slate-800"
              readOnly
              value={reportText || "Report is empty."}
            />
          </div>
        </section>

        <section className="rounded border border-emerald-200 bg-emerald-50 p-4 xl:col-start-1 xl:row-start-2">
          <h2 className="text-lg font-semibold text-emerald-900">Decision Console</h2>
          <div className="mt-2 text-xs text-slate-600">Active steps: {activeSteps.length}</div>
          <div className="mt-3 space-y-2">
            {pendingDecisions.map((item) => (
              <article className="rounded border border-emerald-200 bg-white p-3" key={item.id}>
                <div className="text-sm font-medium text-slate-900">Router step: {item.routerStepId}</div>
                <div className="text-xs text-slate-500">Requested: {new Date(item.requestedAt).toLocaleString()}</div>
                <div className="mt-2 flex gap-2">
                  <button
                    className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white"
                    onClick={() => submitDecision(item.routerStepId, "approve")}
                    type="button"
                  >
                    Approve
                  </button>
                  <button
                    className="rounded bg-rose-600 px-2 py-1 text-xs font-medium text-white"
                    onClick={() => submitDecision(item.routerStepId, "reject")}
                    type="button"
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
            {pendingDecisions.length === 0 ? <p className="text-sm text-slate-500">No router decisions pending.</p> : null}
          </div>
        </section>

        <section className="rounded border border-slate-200 bg-white p-4 xl:col-start-3 xl:row-start-2">
          <h2 className="text-lg font-semibold text-slate-900">System Timeline</h2>
          <div className="mt-3 max-h-[540px] space-y-2 overflow-auto pr-1">
            {timeline.map((event, index) => (
              <article className="rounded border border-slate-200 p-3" key={`${event.id ?? event.timestamp}-${index}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-slate-900">{event.type}</div>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{event.stepId ?? "run"}</span>
                </div>
                <div className="text-xs text-slate-500">{new Date(event.timestamp).toLocaleString()}</div>
                <pre className="mt-2 max-h-36 overflow-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </article>
            ))}
            {timeline.length === 0 ? <p className="text-sm text-slate-500">No events yet.</p> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
