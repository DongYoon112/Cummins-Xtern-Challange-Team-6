import type { MissionSpec } from "../../domain/MissionSpec";
import type { RunEvent } from "../../domain/RunEvent";
import { DebateResultsPanel } from "./DebateResultsPanel";
import { DecisionPanel } from "./DecisionPanel";
import { MissionControls } from "./MissionControls";
import { RunTimeline } from "./RunTimeline";

type WarRoomLayoutProps = {
  runId: string;
  missionSpec: MissionSpec;
  events: RunEvent[];
  onDecision: (actionId: string, decision: "approve" | "reject" | "more_evidence", rationale?: string) => Promise<void>;
  reportText: string;
  onAppendAllDebateResults: () => void;
  onClearDebateReport: () => void;
  onDownloadDebateReport: () => void;
};

export function WarRoomLayout({
  runId,
  missionSpec,
  events,
  onDecision,
  reportText,
  onAppendAllDebateResults,
  onClearDebateReport,
  onDownloadDebateReport
}: WarRoomLayoutProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-[280px,minmax(0,1fr),320px]">
      <MissionControls missionSpec={missionSpec} runId={runId} />
      <RunTimeline events={events} />
      <div className="space-y-4">
        <DecisionPanel
          events={events}
          onDecision={async (payload) => onDecision(payload.actionId, payload.decision, payload.rationale)}
        />
        <DebateResultsPanel
          events={events}
          onAppendAll={onAppendAllDebateResults}
          onClearReport={onClearDebateReport}
          onDownloadReport={onDownloadDebateReport}
          reportText={reportText}
        />
      </div>
    </div>
  );
}
