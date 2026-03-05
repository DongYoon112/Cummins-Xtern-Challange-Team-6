import type { MissionSpec } from "../../domain/MissionSpec";

type MissionControlsProps = {
  runId: string;
  missionSpec: MissionSpec;
};

export function MissionControls({ runId, missionSpec }: MissionControlsProps) {
  const sources = missionSpec.constraints.allowlistedSources ?? ["internal_erp", "supplier_portal"];
  return (
    <section className="rounded border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-slate-900">Mission Control</h2>
      <p className="mt-1 text-sm text-slate-600">{missionSpec.objective}</p>
      <p className="mt-1 font-mono text-xs text-slate-500">Run: {runId}</p>

      <div className="mt-3 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Constraints</div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">
            Budget cap: {missionSpec.constraints.budgetCap ?? 5000}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">
            Sources: {sources.join(", ")}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">
            Model policy: {missionSpec.constraints.modelPolicy ?? "governed-default"}
          </span>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Controls</div>
        <div className="grid grid-cols-1 gap-2">
          <button className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700" type="button">
            Run now
          </button>
          <button className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700" type="button">
            Rerun
          </button>
          <button className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700" type="button">
            Export
          </button>
        </div>
      </div>
    </section>
  );
}
