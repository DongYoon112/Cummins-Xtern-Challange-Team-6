import type { RunEvent } from "../../domain/RunEvent";

type DebateArgument = {
  provider?: string;
  model?: string;
  stance?: string;
  summary?: string;
  rationale?: string;
  confidence?: number;
};

export type DebateResult = {
  eventTs: string;
  title: string;
  topic: string;
  rounds?: number;
  synthesisMode?: string;
  finalRecommendation: string;
  arguments: DebateArgument[];
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toDebateResult(event: RunEvent): DebateResult | null {
  const root = toRecord(event.data);
  if (!root) {
    return null;
  }

  const payload = toRecord(root.output) ?? root;
  const finalRecommendation =
    typeof payload.finalRecommendation === "string"
      ? payload.finalRecommendation
      : typeof payload.recommendation === "string"
        ? payload.recommendation
        : "";

  const topic = typeof payload.topic === "string" ? payload.topic : "";
  const argsRaw = Array.isArray(payload.arguments) ? payload.arguments : [];
  const argumentsList = argsRaw
    .map((entry) => toRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      provider: typeof entry.provider === "string" ? entry.provider : undefined,
      model: typeof entry.model === "string" ? entry.model : undefined,
      stance: typeof entry.stance === "string" ? entry.stance : undefined,
      summary: typeof entry.summary === "string" ? entry.summary : undefined,
      rationale: typeof entry.rationale === "string" ? entry.rationale : undefined,
      confidence: typeof entry.confidence === "number" ? entry.confidence : undefined
    }));

  const looksLikeDebate =
    topic.length > 0 || argumentsList.length > 0 || (event.title.toLowerCase().includes("debate") && finalRecommendation.length > 0);
  if (!looksLikeDebate || !finalRecommendation) {
    return null;
  }

  return {
    eventTs: event.ts,
    title: event.title,
    topic,
    rounds: typeof payload.rounds === "number" ? payload.rounds : undefined,
    synthesisMode: typeof payload.synthesisMode === "string" ? payload.synthesisMode : undefined,
    finalRecommendation,
    arguments: argumentsList
  };
}

export function extractDebateResults(events: RunEvent[]) {
  return events.map((event) => toDebateResult(event)).filter((entry): entry is DebateResult => Boolean(entry));
}

type DebateResultsPanelProps = {
  events: RunEvent[];
  reportText: string;
  onAppendAll: () => void;
  onClearReport: () => void;
  onDownloadReport: () => void;
};

export function DebateResultsPanel({
  events,
  reportText,
  onAppendAll,
  onClearReport,
  onDownloadReport
}: DebateResultsPanelProps) {
  const results = extractDebateResults(events);

  return (
    <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Debate Results</h2>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{results.length} result(s)</span>
      </div>

      <div className="space-y-2">
        {results.map((result) => (
          <article className="rounded border border-slate-200 p-2" key={`${result.eventTs}-${result.title}`}>
            <div className="text-sm font-medium text-slate-900">{result.title}</div>
            <div className="mt-1 text-xs text-slate-500">{new Date(result.eventTs).toLocaleString()}</div>
            {result.topic ? <div className="mt-1 text-xs text-slate-700">Topic: {result.topic}</div> : null}
            <div className="mt-1 text-xs text-orange-800">Final: {result.finalRecommendation}</div>
            <div className="mt-1 text-[11px] text-slate-500">
              Rounds: {result.rounds ?? "N/A"} | Args: {result.arguments.length} | Mode: {result.synthesisMode ?? "fallback"}
            </div>
          </article>
        ))}
        {results.length === 0 ? <p className="text-sm text-slate-500">No debate results detected yet.</p> : null}
      </div>

      <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">Report Builder</div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-orange-600 px-2 py-1 text-xs font-medium text-white" onClick={onAppendAll} type="button">
            Append All Debate Results
          </button>
          <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={onDownloadReport} type="button">
            Download Report
          </button>
          <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={onClearReport} type="button">
            Clear
          </button>
        </div>
        <textarea
          className="h-40 w-full rounded border border-slate-300 bg-white p-2 font-mono text-[11px] text-slate-800"
          readOnly
          value={reportText || "Report is empty. Use 'Append All Debate Results'."}
        />
      </div>
    </section>
  );
}
