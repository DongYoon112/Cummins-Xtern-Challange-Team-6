import type { RunEvent } from "../../domain/RunEvent";

type RunTimelineProps = {
  events: RunEvent[];
};

function formatMetricLabel(event: RunEvent) {
  if (!event.data || typeof event.data !== "object") {
    return null;
  }

  const payload = event.data as Record<string, unknown>;
  const tokens: string[] = [];

  if (typeof payload.cost === "number") {
    tokens.push(`cost $${payload.cost.toFixed(2)}`);
  }
  if (typeof payload.latencyMs === "number") {
    tokens.push(`latency ${payload.latencyMs}ms`);
  }

  return tokens.length > 0 ? tokens.join(" | ") : null;
}

export function RunTimeline({ events }: RunTimelineProps) {
  return (
    <section className="rounded border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-slate-900">Timeline</h2>
      <div className="mt-3 space-y-3">
        {events.map((event) => {
          const metrics = formatMetricLabel(event);
          return (
            <article className="rounded border border-slate-200 p-3" key={`${event.ts}-${event.kind}-${event.title}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium text-slate-900">{event.title}</div>
                <div className="rounded bg-slate-100 px-2 py-0.5 text-xs uppercase tracking-wide text-slate-600">
                  {event.kind}
                </div>
              </div>
              <div className="mt-1 text-xs text-slate-500">{new Date(event.ts).toLocaleString()}</div>
              {metrics ? <div className="mt-1 text-xs text-orange-700">{metrics}</div> : null}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-slate-600">View event JSON</summary>
                <pre className="mt-2 max-h-56 overflow-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">
                  {JSON.stringify(event.data, null, 2)}
                </pre>
              </details>
            </article>
          );
        })}
        {events.length === 0 ? <p className="text-sm text-slate-500">No events yet.</p> : null}
      </div>
    </section>
  );
}
