import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { draftToMissionSpec } from "../adapters/draftToMissionSpec";
import { extractDebateResults } from "../components/warroom/DebateResultsPanel";
import { WarRoomLayout } from "../components/warroom/WarRoomLayout";
import type { RecommendationAction } from "../domain/Recommendation";
import type { MissionSpec } from "../domain/MissionSpec";
import type { RunEvent } from "../domain/RunEvent";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

function defaultMissionSpec(runId: string): MissionSpec {
  return {
    objective: `Mission: Generated from draft (${runId})`,
    steps: [{ id: "step-1", name: "Initial assessment" }],
    constraints: {
      budgetCap: 5000,
      allowlistedSources: ["internal_erp", "supplier_portal"],
      modelPolicy: "governed-default"
    }
  };
}

function missionSpecFromEvents(events: RunEvent[], runId: string): MissionSpec {
  const ingestEvent = events.find((event) => event.kind === "ingest");
  if (!ingestEvent) {
    return defaultMissionSpec(runId);
  }

  if (ingestEvent.data && typeof ingestEvent.data === "object" && "draftWorkflow" in ingestEvent.data) {
    return draftToMissionSpec((ingestEvent.data as { draftWorkflow: unknown }).draftWorkflow);
  }

  return draftToMissionSpec(ingestEvent.data);
}

function latestRecommendation(events: RunEvent[]) {
  return [...events].reverse().find((event) => event.kind === "recommendation") ?? null;
}

function recommendationActions(event: RunEvent | null): RecommendationAction[] {
  if (!event || !event.data || typeof event.data !== "object") {
    return [];
  }

  const rawActions = (event.data as Record<string, unknown>).actions;
  if (!Array.isArray(rawActions)) {
    return [];
  }

  return rawActions
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      actionId: typeof item.actionId === "string" ? item.actionId : "",
      title: typeof item.title === "string" ? item.title : "Untitled action",
      evidence_refs: Array.isArray(item.evidence_refs)
        ? item.evidence_refs.filter((ref): ref is string => typeof ref === "string")
        : undefined
    }))
    .filter((action) => action.actionId);
}

export function WarRoomPage() {
  const { token } = useAuth();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get("runId") ?? "";
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAlertEventTs, setLastAlertEventTs] = useState<string | null>(null);
  const [alarmOpen, setAlarmOpen] = useState(false);
  const [alarmVisible, setAlarmVisible] = useState(false);
  const [debateReportText, setDebateReportText] = useState("");

  const loadEvents = useCallback(async () => {
    if (!runId) {
      return;
    }

    setLoading(true);
    try {
      const payload = await apiFetch<RunEvent[]>(`/api/runs/${encodeURIComponent(runId)}/events`, {}, token ?? undefined);
      setEvents(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load war room events");
    } finally {
      setLoading(false);
    }
  }, [runId, token]);

  useEffect(() => {
    if (!token || !runId) {
      return;
    }

    loadEvents().catch(() => undefined);
    const timer = window.setInterval(() => {
      loadEvents().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadEvents, runId, token]);

  const missionSpec = useMemo(() => missionSpecFromEvents(events, runId), [events, runId]);
  const latestRecommendationEvent = useMemo(() => latestRecommendation(events), [events]);
  const latestActions = useMemo(() => recommendationActions(latestRecommendationEvent), [latestRecommendationEvent]);

  useEffect(() => {
    if (!latestRecommendationEvent) {
      return;
    }

    if (latestRecommendationEvent.ts !== lastAlertEventTs) {
      setLastAlertEventTs(latestRecommendationEvent.ts);
      setAlarmVisible(true);
      setAlarmOpen(true);
    }
  }, [latestRecommendationEvent, lastAlertEventTs]);

  async function submitDecision(actionId: string, decision: "approve" | "reject" | "more_evidence", rationale?: string) {
    if (!runId) {
      return;
    }

    setStatus(null);
    setError(null);
    const optimisticEvent: RunEvent = {
      runId,
      ts: new Date().toISOString(),
      kind: "decision",
      title: `Decision: ${decision.toUpperCase()} ${actionId}`,
      data: {
        actionId,
        decision,
        rationale: rationale ?? null,
        optimistic: true
      }
    };
    setEvents((current) => [...current, optimisticEvent]);

    try {
      await apiFetch<{ ok: true }>(
        `/api/runs/${encodeURIComponent(runId)}/decisions`,
        {
          method: "POST",
          body: JSON.stringify({ actionId, decision, rationale })
        },
        token ?? undefined
      );
      setStatus(`Decision submitted for ${actionId}`);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit decision");
      await loadEvents();
    }
  }

  function appendAllDebateResultsToReport() {
    const results = extractDebateResults(events);
    if (results.length === 0) {
      setStatus("No debate results available to append.");
      return;
    }

    const section = [
      `## Debate Results - ${new Date().toLocaleString()}`,
      ...results.map((result, index) => {
        const args = result.arguments
          .map((arg, argIndex) => {
            const label = `${arg.provider ?? "model"}/${arg.model ?? "default"}`;
            const conf = typeof arg.confidence === "number" ? arg.confidence.toFixed(2) : "n/a";
            return `- Arg ${argIndex + 1}: ${label} (conf ${conf}) ${arg.summary ?? ""}`.trim();
          })
          .join("\n");
        return [
          `### Debate ${index + 1}: ${result.title}`,
          `- Time: ${new Date(result.eventTs).toLocaleString()}`,
          `- Topic: ${result.topic || "N/A"}`,
          `- Rounds: ${result.rounds ?? "N/A"}`,
          `- Synthesis: ${result.synthesisMode ?? "fallback"}`,
          `- Final Recommendation: ${result.finalRecommendation}`,
          args ? "Arguments:\n" + args : "Arguments: none"
        ].join("\n");
      })
    ].join("\n\n");

    setDebateReportText((current) => (current ? `${current}\n\n${section}` : section));
    setStatus(`Appended ${results.length} debate result(s) to report.`);
  }

  function clearDebateReport() {
    setDebateReportText("");
    setStatus("Debate report cleared.");
  }

  function downloadDebateReport() {
    const content = debateReportText.trim();
    if (!content) {
      setStatus("Report is empty. Append results first.");
      return;
    }

    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `war-room-debate-report-${runId}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Debate report downloaded.");
  }

  if (!runId) {
    return <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">Missing runId query param.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="rounded border border-slate-200 bg-slate-900 p-3 text-slate-100">
        <h1 className="text-xl font-semibold">War Room</h1>
        <p className="mt-1 text-sm text-slate-300">Run monitor and decision console driven by event replay.</p>
      </div>

      {loading ? <p className="text-xs text-slate-500">Refreshing event stream...</p> : null}
      {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
      {error ? <p className="text-sm text-warn">{error}</p> : null}

      <WarRoomLayout
        events={events}
        missionSpec={missionSpec}
        onAppendAllDebateResults={appendAllDebateResultsToReport}
        onClearDebateReport={clearDebateReport}
        onDecision={submitDecision}
        onDownloadDebateReport={downloadDebateReport}
        reportText={debateReportText}
        runId={runId}
      />

      {alarmVisible ? (
        <aside className="fixed bottom-4 right-4 z-40 w-80">
          <div
            className={`overflow-hidden rounded border shadow-xl transition-all duration-300 ${
              alarmOpen ? "max-h-[420px] border-emerald-300 bg-white" : "max-h-16 border-amber-300 bg-amber-50"
            }`}
          >
            <button
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold ${
                alarmOpen ? "bg-emerald-50 text-emerald-900" : "bg-amber-100 text-amber-900"
              }`}
              onClick={() => setAlarmOpen((current) => !current)}
              type="button"
            >
              <span className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" />
                Results ready
              </span>
              <span>{alarmOpen ? "Hide" : "Review"}</span>
            </button>

            {alarmOpen ? (
              <div className="space-y-2 p-3">
                {latestActions.length === 0 ? <p className="text-sm text-slate-600">No actions available.</p> : null}
                {latestActions.map((action) => (
                  <div className="rounded border border-slate-200 p-2" key={action.actionId}>
                    <div className="text-sm font-medium text-slate-900">{action.title}</div>
                    <div className="mt-2 flex gap-2">
                      <button
                        className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white"
                        onClick={() => submitDecision(action.actionId, "approve")}
                        type="button"
                      >
                        Accept
                      </button>
                      <button
                        className="rounded bg-rose-600 px-2 py-1 text-xs font-medium text-white"
                        onClick={() => submitDecision(action.actionId, "reject")}
                        type="button"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  className="w-full rounded border border-slate-300 px-2 py-1 text-xs text-slate-600"
                  onClick={() => setAlarmVisible(false)}
                  type="button"
                >
                  Dismiss alarm
                </button>
              </div>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
