import type { ToolCategory, ToolId, WorkflowTool, WorkflowToolConfig } from "../lib/workflowBuilderSchema";

type ToolPickerProps = {
  tools: WorkflowTool[];
  onToggleTool: (toolId: ToolId, enabled: boolean) => void;
  onUpdateToolConfig: (toolId: ToolId, patch: Partial<WorkflowToolConfig>) => void;
};

const CATEGORY_ORDER: ToolCategory[] = ["Discovery", "Integration", "System", "Data", "Communication", "AI"];

function scopesToText(scopes?: string[]) {
  return scopes?.join(", ") ?? "";
}

function textToScopes(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ToolPicker({ tools, onToggleTool, onUpdateToolConfig }: ToolPickerProps) {
  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    tools: tools.filter((tool) => tool.category === category)
  })).filter((entry) => entry.tools.length > 0);

  return (
    <div className="space-y-3">
      {grouped.map((group) => (
        <section className="rounded border border-slate-200 bg-slate-50/70 p-3" key={group.category}>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{group.category}</h4>
          <div className="space-y-2">
            {group.tools.map((tool) => (
              <div className="rounded border border-slate-200 bg-white p-2" key={tool.id}>
                <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                  <input
                    checked={tool.enabled}
                    onChange={(event) => onToggleTool(tool.id, event.target.checked)}
                    type="checkbox"
                  />
                  {tool.label}
                </label>

                {tool.enabled ? (
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <input
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                      onChange={(event) => onUpdateToolConfig(tool.id, { apiKey: event.target.value })}
                      placeholder="API key (optional)"
                      type="password"
                      value={tool.config.apiKey ?? ""}
                    />
                    <input
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                      onChange={(event) => onUpdateToolConfig(tool.id, { baseUrl: event.target.value })}
                      placeholder="Base URL"
                      value={tool.config.baseUrl ?? ""}
                    />
                    <input
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                      onChange={(event) => onUpdateToolConfig(tool.id, { scopes: textToScopes(event.target.value) })}
                      placeholder="Scopes (comma-separated)"
                      value={scopesToText(tool.config.scopes)}
                    />
                    <input
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                      min={1}
                      onChange={(event) =>
                        onUpdateToolConfig(tool.id, { rateLimitPerMin: Number(event.target.value) || undefined })
                      }
                      placeholder="Rate limit / min"
                      type="number"
                      value={tool.config.rateLimitPerMin ?? ""}
                    />

                    <input
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                      onChange={(event) => onUpdateToolConfig(tool.id, { connectionString: event.target.value })}
                      placeholder="DB connection string"
                      value={tool.config.connectionString ?? ""}
                    />
                    <select
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                      onChange={(event) =>
                        onUpdateToolConfig(tool.id, {
                          sandboxProfile: (event.target.value as "restricted" | "standard") || undefined
                        })
                      }
                      value={tool.config.sandboxProfile ?? ""}
                    >
                      <option value="">Sandbox profile</option>
                      <option value="restricted">restricted</option>
                      <option value="standard">standard</option>
                    </select>

                    <input
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                      onChange={(event) => onUpdateToolConfig(tool.id, { indexName: event.target.value })}
                      placeholder="Vector index name"
                      value={tool.config.indexName ?? ""}
                    />

                    <div className="flex items-center gap-3 text-xs text-slate-700">
                      <label className="flex items-center gap-1">
                        <input
                          checked={Boolean(tool.config.allowRead)}
                          onChange={(event) => onUpdateToolConfig(tool.id, { allowRead: event.target.checked })}
                          type="checkbox"
                        />
                        Read
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          checked={Boolean(tool.config.allowWrite)}
                          onChange={(event) => onUpdateToolConfig(tool.id, { allowWrite: event.target.checked })}
                          type="checkbox"
                        />
                        Write
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          checked={Boolean(tool.config.isStub)}
                          onChange={(event) => onUpdateToolConfig(tool.id, { isStub: event.target.checked })}
                          type="checkbox"
                        />
                        Stub
                      </label>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
