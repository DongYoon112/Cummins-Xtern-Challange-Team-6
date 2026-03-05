import {
  LLM_MODEL_OPTIONS,
  getDefaultModelForProvider,
  type LlmProvider,
  type ToolId,
  type WorkflowNode,
  type WorkflowTool
} from "../lib/workflowBuilderSchema";

type ConfigDrawerProps = {
  node: WorkflowNode | null;
  tools: WorkflowTool[];
  onClose: () => void;
  onUpdateNode: (nodeId: string, patch: Partial<WorkflowNode>) => void;
  onDeleteNode: (nodeId: string) => void;
};

function getNodeTitle(type: WorkflowNode["type"]) {
  switch (type) {
    case "start":
      return "Start Node";
    case "llm":
      return "LLM Node";
    case "tool":
      return "Tool Node";
    case "router":
      return "Router/Condition Node";
    case "memory":
      return "Memory Node";
    case "debate":
      return "Multi-Agent Debate Node";
    case "output":
      return "Output Node";
    default:
      return "Node";
  }
}

function getNodeDescriptionSummary(node: WorkflowNode, tools: WorkflowTool[]) {
  if (node.type === "start") {
    return "Starts the workflow and passes initial context to downstream nodes.";
  }

  if (node.type === "llm") {
    const provider = String(node.config.llmProvider ?? "").trim();
    const model = String(node.config.llmModel ?? "").trim();
    if (provider && model) {
      return `Analyzes context with ${provider}/${model} and produces structured reasoning output.`;
    }
    return "Uses a language model to interpret context and generate the next decision or output.";
  }

  if (node.type === "tool") {
    const toolId = String(node.config.toolId ?? "").trim();
    const matchedTool = tools.find((tool) => tool.id === toolId);
    if (matchedTool) {
      return `Calls ${matchedTool.label} to fetch or update operational data for the workflow.`;
    }
    return "Executes an external tool or integration to retrieve or send workflow data.";
  }

  if (node.type === "router") {
    const condition = String(node.config.condition ?? "").trim();
    if (condition) {
      return `Routes execution based on condition: ${condition}.`;
    }
    return "Evaluates rules and routes execution to the correct downstream path.";
  }

  if (node.type === "memory") {
    return "Stores or retrieves memory state so future nodes can use prior context.";
  }

  if (node.type === "debate") {
    return "Runs a multi-agent debate to compare alternatives before selecting a recommendation.";
  }

  return "Delivers the final workflow result to destination systems and user-facing views.";
}

export function ConfigDrawer({ node, tools, onClose, onUpdateNode, onDeleteNode }: ConfigDrawerProps) {
  if (!node) {
    return (
      <aside className="h-full rounded border border-slate-200 bg-white p-4 xl:overflow-auto">
        <h3 className="text-sm font-semibold">Config Drawer</h3>
        <p className="mt-2 text-xs text-slate-500">Select a node on the canvas to edit its config.</p>
      </aside>
    );
  }

  const enabledTools = tools.filter((tool) => tool.enabled);
  const label = String(node.config.label ?? "");
  const description = String(node.config.description ?? "");
  const linkedToolId = String(node.config.toolId ?? "");
  const llmProvider = String(node.config.llmProvider ?? "");
  const llmModel = String(node.config.llmModel ?? "");
  const hasKnownProvider = llmProvider === "openai" || llmProvider === "anthropic" || llmProvider === "gemini";
  const providerModels = hasKnownProvider ? LLM_MODEL_OPTIONS[llmProvider as LlmProvider] : [];
  const llmModelOptions =
    llmModel && !providerModels.includes(llmModel) ? [llmModel, ...providerModels] : providerModels;
  const condition = String(node.config.condition ?? "");
  const query = String(node.config.query ?? "");
  const queryParams = Array.isArray(node.config.queryParams) ? node.config.queryParams : [];
  const queryParamsRaw = JSON.stringify(queryParams);
  const maxRows = String(node.config.maxRows ?? "100");
  const connectionString = String(node.config.connectionString ?? "");
  const debateTopic = String(node.config.debateTopic ?? "");
  const debateRounds = String(node.config.debateRounds ?? "1");
  const participants = Array.isArray(node.config.participants) ? node.config.participants : [];
  const participantsRaw = JSON.stringify(participants);
  const nodeDescriptionSummary = getNodeDescriptionSummary(node, tools);

  return (
    <aside className="h-full space-y-3 rounded border border-slate-200 bg-white p-4 xl:overflow-auto">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{getNodeTitle(node.type)}</h3>
          <div className="text-xs text-slate-500">id: {node.id}</div>
        </div>
        <button className="rounded border border-slate-300 px-2 py-1 text-xs" onClick={onClose} type="button">
          Close
        </button>
      </div>

      <label className="block text-xs">
        <div className="mb-1 text-slate-600">Label</div>
        <input
          className="w-full rounded border border-slate-300 px-2 py-1"
          onChange={(event) =>
            onUpdateNode(node.id, { config: { ...node.config, label: event.target.value } })
          }
          value={label}
        />
      </label>

      <label className="block text-xs">
        <div className="mb-1 text-slate-600">Description</div>
        <textarea
          className="w-full rounded border border-slate-300 px-2 py-1"
          onChange={(event) =>
            onUpdateNode(node.id, { config: { ...node.config, description: event.target.value } })
          }
          placeholder={nodeDescriptionSummary}
          rows={3}
          value={description}
        />
        <div className="mt-1 text-[11px] text-slate-500">Suggested summary: {nodeDescriptionSummary}</div>
      </label>

      {node.type === "llm" ? (
        <div className="grid grid-cols-1 gap-2">
          <label className="text-xs">
            <div className="mb-1 text-slate-600">LLM Provider</div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => {
                const nextProvider = event.target.value as LlmProvider | "";
                if (!nextProvider) {
                  onUpdateNode(node.id, { config: { ...node.config, llmProvider: "", llmModel: "" } });
                  return;
                }
                onUpdateNode(node.id, {
                  config: {
                    ...node.config,
                    llmProvider: nextProvider,
                    llmModel: getDefaultModelForProvider(nextProvider)
                  }
                });
              }}
              value={llmProvider}
            >
              <option value="">Select provider</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Claude</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>
          <label className="text-xs">
            <div className="mb-1 text-slate-600">LLM Model</div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, llmModel: event.target.value } })
              }
              disabled={!hasKnownProvider}
              value={llmModel}
            >
              {!hasKnownProvider ? (
                <option value="">Select provider first</option>
              ) : null}
              {llmModelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {node.type === "tool" ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Linked Tool</div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, toolId: event.target.value as ToolId } })
              }
              value={linkedToolId}
            >
              <option value="">Select enabled tool</option>
              {enabledTools.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.label}
                </option>
              ))}
            </select>
          </label>

          {linkedToolId === "database" ? (
            <>
              <label className="block text-xs">
                <div className="mb-1 text-slate-600">Connection String Override (optional)</div>
                <input
                  className="w-full rounded border border-slate-300 px-2 py-1"
                  onChange={(event) =>
                    onUpdateNode(node.id, { config: { ...node.config, connectionString: event.target.value } })
                  }
                  placeholder="postgresql://user:pass@host:5432/db"
                  value={connectionString}
                />
              </label>
              <label className="block text-xs">
                <div className="mb-1 text-slate-600">SQL Query (read-only)</div>
                <textarea
                  className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px]"
                  onChange={(event) => onUpdateNode(node.id, { config: { ...node.config, query: event.target.value } })}
                  placeholder="SELECT * FROM orders LIMIT 20"
                  rows={4}
                  value={query}
                />
              </label>
              <label className="block text-xs">
                <div className="mb-1 text-slate-600">Query Params JSON Array</div>
                <input
                  className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px]"
                  onChange={(event) => {
                    let parsed: unknown[] = [];
                    try {
                      const next = JSON.parse(event.target.value) as unknown;
                      if (Array.isArray(next)) {
                        parsed = next;
                      }
                    } catch {
                      parsed = [];
                    }
                    onUpdateNode(node.id, { config: { ...node.config, queryParams: parsed } });
                  }}
                  placeholder='["ORD-1001"]'
                  value={queryParamsRaw}
                />
              </label>
              <label className="block text-xs">
                <div className="mb-1 text-slate-600">Max Rows</div>
                <input
                  className="w-full rounded border border-slate-300 px-2 py-1"
                  onChange={(event) =>
                    onUpdateNode(node.id, {
                      config: { ...node.config, maxRows: Number(event.target.value) || 100 }
                    })
                  }
                  type="number"
                  value={maxRows}
                />
              </label>
            </>
          ) : null}
        </div>
      ) : null}

      {node.type === "router" ? (
        <label className="block text-xs">
          <div className="mb-1 text-slate-600">Condition</div>
          <input
            className="w-full rounded border border-slate-300 px-2 py-1"
            onChange={(event) =>
              onUpdateNode(node.id, { config: { ...node.config, condition: event.target.value } })
            }
            placeholder="confidence < 0.6"
            value={condition}
          />
        </label>
      ) : null}

      {node.type === "debate" ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Debate Topic / Question</div>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, debateTopic: event.target.value } })
              }
              placeholder="Should we expedite order ORD-1001 given cost and risk?"
              rows={3}
              value={debateTopic}
            />
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Debate Rounds</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              min={1}
              onChange={(event) =>
                onUpdateNode(node.id, {
                  config: { ...node.config, debateRounds: Math.max(1, Number(event.target.value) || 1) }
                })
              }
              type="number"
              value={debateRounds}
            />
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Participants JSON Array</div>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px]"
              onChange={(event) => {
                let next: unknown[] = [];
                try {
                  const parsed = JSON.parse(event.target.value) as unknown;
                  if (Array.isArray(parsed)) {
                    next = parsed;
                  }
                } catch {
                  next = [];
                }
                onUpdateNode(node.id, { config: { ...node.config, participants: next } });
              }}
              placeholder='[{"provider":"openai","model":"gpt-4.1-mini"},{"provider":"anthropic","model":"claude-3-5-haiku-latest"}]'
              rows={4}
              value={participantsRaw}
            />
          </label>
        </div>
      ) : null}

      <button
        className="rounded border border-rose-300 px-2 py-1 text-xs text-rose-700"
        onClick={() => onDeleteNode(node.id)}
        type="button"
      >
        Delete Node
      </button>
    </aside>
  );
}
