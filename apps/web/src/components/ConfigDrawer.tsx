import { useEffect, useState } from "react";
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
    case "dataset_loader":
      return "Dataset Loader Node";
    case "feature_builder":
      return "Feature Builder Node";
    case "db_write":
      return "DB Write Node";
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

  if (node.type === "dataset_loader") {
    return "Loads CMAPSS FD001 rows for a specific engine unit from local cache or download.";
  }

  if (node.type === "feature_builder") {
    return "Builds rolling stats and sensor trend features from recent CMAPSS cycles.";
  }

  if (node.type === "db_write") {
    return "Persists the orchestrated incident record into Postgres or SQLite.";
  }

  return "Delivers the final workflow result to destination systems and user-facing views.";
}

export function ConfigDrawer({ node, tools, onClose, onUpdateNode, onDeleteNode }: ConfigDrawerProps) {
  const [participantsJsonError, setParticipantsJsonError] = useState<string | null>(null);
  const [arbiterJsonError, setArbiterJsonError] = useState<string | null>(null);

  useEffect(() => {
    setParticipantsJsonError(null);
    setArbiterJsonError(null);
  }, [node?.id]);

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
  const llmPrompt = String(node.config.prompt ?? "");
  const llmSystemPrompt = String(node.config.systemPrompt ?? "");
  const llmQuery = String(node.config.query ?? "");
  const llmAllowDbWrite = node.config.allowDbWrite === true;
  const llmQueryParams = Array.isArray(node.config.queryParams) ? node.config.queryParams : [];
  const llmQueryParamsRaw = JSON.stringify(llmQueryParams);
  const llmMaxRows = String(node.config.maxRows ?? "100");
  const llmConnectionString = String(node.config.connectionString ?? "");
  const hasKnownProvider = llmProvider === "openai" || llmProvider === "anthropic" || llmProvider === "gemini";
  const providerModels = hasKnownProvider ? LLM_MODEL_OPTIONS[llmProvider as LlmProvider] : [];
  const llmModelOptions =
    llmModel && !providerModels.includes(llmModel) ? [llmModel, ...providerModels] : providerModels;
  const condition = String(node.config.condition ?? "");
  const routes = Array.isArray(node.config.routes) ? node.config.routes : [];
  const routesRaw = JSON.stringify(routes);
  const defaultRouteToNodeId = String(node.config.defaultRouteToNodeId ?? "");
  const requiresApproval = node.config.requiresApproval === true;
  const query = String(node.config.query ?? "");
  const queryParams = Array.isArray(node.config.queryParams) ? node.config.queryParams : [];
  const queryParamsRaw = JSON.stringify(queryParams);
  const maxRows = String(node.config.maxRows ?? "100");
  const connectionString = String(node.config.connectionString ?? "");
  const debateTopic = String(node.config.debateTopic ?? "");
  const debateRounds = String(node.config.debateRounds ?? "2");
  const debateAgentName =
    typeof node.config.agentName === "string" && node.config.agentName.trim()
      ? node.config.agentName
      : "Debate Agent";
  const participants = Array.isArray(node.config.participants) ? node.config.participants : [];
  const participantsRaw =
    typeof node.config.participantsRaw === "string"
      ? node.config.participantsRaw
      : JSON.stringify(participants, null, 2);
  const arbiter =
    node.config.arbiter && typeof node.config.arbiter === "object"
      ? (node.config.arbiter as Record<string, unknown>)
      : {};
  const arbiterRaw =
    typeof node.config.arbiterRaw === "string" ? node.config.arbiterRaw : JSON.stringify(arbiter, null, 2);
  const outputSchemaVersion = String(node.config.outputSchemaVersion ?? "v1");
  const requireJson = node.config.requireJson !== false;
  const debateMaxTokens = String(node.config.maxTokens ?? "");
  const debateTemperature = String(node.config.temperature ?? "");
  const memoryMode = String(node.config.mode ?? "write");
  const memoryKey = String(node.config.key ?? "");
  const memoryValueRaw =
    typeof node.config.value === "string" ? node.config.value : JSON.stringify(node.config.value ?? {});
  const memoryAssignTo = String(node.config.assignTo ?? "variables.memory");
  const outputMode = String(node.config.outputMode ?? "run_summary");
  const messageTemplate = String(node.config.messageTemplate ?? "");
  const webhookUrl = String(node.config.webhookUrl ?? "");
  const includeContext = node.config.includeContext === true;
  const dataset = String(node.config.dataset ?? "FD001");
  const unitId = String(node.config.unit_id ?? "1");
  const datasetWindow = String(node.config.window ?? "50");
  const datasetSource = String(node.config.source ?? "local");
  const cacheDir = String(node.config.cache_dir ?? "./data/CMAPSS");
  const slopeWindow = String(node.config.slope_window ?? "10");
  const dbTarget = String(node.config.db_target ?? "postgres");
  const sqlitePath = String(node.config.sqlite_path ?? "./data/engine-incidents.db");
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
          <label className="text-xs">
            <div className="mb-1 text-slate-600">Prompt</div>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, prompt: event.target.value } })
              }
              placeholder="Ask your question here. Example: Summarize risks for ORD-1001."
              rows={4}
              value={llmPrompt}
            />
          </label>
          <label className="text-xs">
            <div className="mb-1 text-slate-600">System Prompt (optional)</div>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, systemPrompt: event.target.value } })
              }
              placeholder="You are a supply-chain assistant. Return concise JSON."
              rows={3}
              value={llmSystemPrompt}
            />
            <div className="mt-1 text-[11px] text-slate-500">
              You can use context placeholders like {"{{orderId}}"} and {"{{lastSummary}}"}.
            </div>
          </label>
          <label className="text-xs">
            <div className="mb-1 text-slate-600">DB SQL (optional)</div>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px]"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, toolId: "database", query: event.target.value } })
              }
              placeholder="SELECT * FROM orders LIMIT 5"
              rows={4}
              value={llmQuery}
            />
          </label>
          <label className="text-xs">
            <div className="mb-1 text-slate-600">DB Query Params JSON Array</div>
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
              value={llmQueryParamsRaw}
            />
          </label>
          <label className="text-xs">
            <div className="mb-1 text-slate-600">DB Max Rows (for SELECT)</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, {
                  config: { ...node.config, maxRows: Number(event.target.value) || 100 }
                })
              }
              type="number"
              value={llmMaxRows}
            />
          </label>
          <label className="text-xs">
            <div className="mb-1 text-slate-600">DB Connection String Override (optional)</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, connectionString: event.target.value } })
              }
              placeholder="postgresql://user:pass@host:5432/db"
              value={llmConnectionString}
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              checked={llmAllowDbWrite}
              onChange={(event) =>
                onUpdateNode(node.id, {
                  config: {
                    ...node.config,
                    allowDbWrite: event.target.checked,
                    mode: event.target.checked ? "external_db_write" : "external_db_query",
                    toolId: "database"
                  }
                })
              }
              type="checkbox"
            />
            Allow DB INSERT/UPDATE/DELETE
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
        <div className="space-y-2">
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Condition (legacy)</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, condition: event.target.value } })
              }
              placeholder="variables.riskScore > 0.7"
              value={condition}
            />
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Routes JSON Array</div>
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
                onUpdateNode(node.id, { config: { ...node.config, routes: next } });
              }}
              placeholder='[{"label":"Approve","condition":"variables.riskScore < 0.7","toNodeId":"node_xxx"}]'
              rows={4}
              value={routesRaw}
            />
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Default Route Node ID</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, defaultRouteToNodeId: event.target.value } })
              }
              placeholder="node_target"
              value={defaultRouteToNodeId}
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              checked={requiresApproval}
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, requiresApproval: event.target.checked } })
              }
              type="checkbox"
            />
            Require approval before evaluating routes
          </label>
          <div className="text-[11px] text-slate-500">Current routes: {routes.length}</div>
        </div>
      ) : null}

      {node.type === "memory" ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Mode</div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => onUpdateNode(node.id, { config: { ...node.config, mode: event.target.value } })}
              value={memoryMode}
            >
              <option value="write">write</option>
              <option value="read">read</option>
            </select>
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Key</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => onUpdateNode(node.id, { config: { ...node.config, key: event.target.value } })}
              placeholder="customer_profile"
              value={memoryKey}
            />
          </label>
          {memoryMode === "write" ? (
            <label className="block text-xs">
              <div className="mb-1 text-slate-600">Value (JSON or string)</div>
              <textarea
                className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px]"
                onChange={(event) => {
                  let parsed: unknown = event.target.value;
                  try {
                    parsed = JSON.parse(event.target.value);
                  } catch {
                    parsed = event.target.value;
                  }
                  onUpdateNode(node.id, { config: { ...node.config, value: parsed } });
                }}
                rows={3}
                value={memoryValueRaw}
              />
            </label>
          ) : (
            <label className="block text-xs">
              <div className="mb-1 text-slate-600">Assign To</div>
              <input
                className="w-full rounded border border-slate-300 px-2 py-1"
                onChange={(event) =>
                  onUpdateNode(node.id, { config: { ...node.config, assignTo: event.target.value } })
                }
                placeholder="variables.customerProfile"
                value={memoryAssignTo}
              />
            </label>
          )}
        </div>
      ) : null}

      {node.type === "debate" ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Debate Agent</div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, agentName: event.target.value } })
              }
              value={debateAgentName}
            >
              <option value="Debate Agent">Debate Agent (Multi-LLM)</option>
              <option value="CMAPSS Debate Agent">CMAPSS Debate Agent</option>
            </select>
          </label>
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
                  config: { ...node.config, debateRounds: Math.max(1, Number(event.target.value) || 2) }
                })
              }
              type="number"
              value={debateRounds}
            />
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Output Schema Version</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, outputSchemaVersion: event.target.value || "v1" } })
              }
              value={outputSchemaVersion}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              checked={requireJson}
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, requireJson: event.target.checked } })
              }
              type="checkbox"
            />
            Require strict JSON output
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Max Tokens (optional)</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, {
                  config: {
                    ...node.config,
                    maxTokens: event.target.value.trim() ? Math.max(1, Number(event.target.value) || 1) : undefined
                  }
                })
              }
              placeholder="1200"
              type="number"
              value={debateMaxTokens}
            />
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Temperature (optional)</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, {
                  config: {
                    ...node.config,
                    temperature: event.target.value.trim() ? Number(event.target.value) || 0 : undefined
                  }
                })
              }
              placeholder="0"
              step="0.1"
              type="number"
              value={debateTemperature}
            />
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Participants JSON Array</div>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px]"
              onChange={(event) => {
                const raw = event.target.value;
                let next: unknown[] | null = null;
                try {
                  const parsed = JSON.parse(raw) as unknown;
                  if (Array.isArray(parsed)) {
                    next = parsed;
                  } else {
                    setParticipantsJsonError("Participants JSON must be an array.");
                  }
                } catch {
                  setParticipantsJsonError("Participants JSON is invalid. Keeping raw text.");
                }
                if (next) {
                  setParticipantsJsonError(null);
                }
                onUpdateNode(node.id, {
                  config: {
                    ...node.config,
                    participantsRaw: raw,
                    ...(next ? { participants: next } : {})
                  }
                });
              }}
              placeholder='[{"id":"risk","label":"Risk Analyst","provider":"openai","model":"gpt-4o-mini","stance":"BLOCK"}]'
              rows={6}
              value={participantsRaw}
            />
            {participantsJsonError ? <div className="mt-1 text-[11px] text-amber-700">{participantsJsonError}</div> : null}
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Arbiter JSON Object</div>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px]"
              onChange={(event) => {
                const raw = event.target.value;
                let next: Record<string, unknown> | null = null;
                try {
                  const parsed = JSON.parse(raw) as unknown;
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    next = parsed as Record<string, unknown>;
                  } else {
                    setArbiterJsonError("Arbiter JSON must be an object.");
                  }
                } catch {
                  setArbiterJsonError("Arbiter JSON is invalid. Keeping raw text.");
                }
                if (next) {
                  setArbiterJsonError(null);
                }
                onUpdateNode(node.id, {
                  config: {
                    ...node.config,
                    arbiterRaw: raw,
                    ...(next ? { arbiter: next } : {})
                  }
                });
              }}
              placeholder='{"enabled":true,"provider":"openai","model":"gpt-4o-mini"}'
              rows={4}
              value={arbiterRaw}
            />
            {arbiterJsonError ? <div className="mt-1 text-[11px] text-amber-700">{arbiterJsonError}</div> : null}
          </label>
        </div>
      ) : null}

      {node.type === "dataset_loader" ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Dataset</div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => onUpdateNode(node.id, { config: { ...node.config, dataset: event.target.value } })}
              value={dataset}
            >
              <option value="FD001">FD001</option>
            </select>
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Unit ID</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              min={1}
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, unit_id: Math.max(1, Number(event.target.value) || 1) } })
              }
              type="number"
              value={unitId}
            />
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Window</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              min={5}
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, window: Math.max(5, Number(event.target.value) || 50) } })
              }
              type="number"
              value={datasetWindow}
            />
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Source</div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => onUpdateNode(node.id, { config: { ...node.config, source: event.target.value } })}
              value={datasetSource}
            >
              <option value="local">local</option>
              <option value="download">download</option>
            </select>
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Cache Dir</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => onUpdateNode(node.id, { config: { ...node.config, cache_dir: event.target.value } })}
              value={cacheDir}
            />
          </label>
        </div>
      ) : null}

      {node.type === "feature_builder" ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Window</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              min={5}
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, window: Math.max(5, Number(event.target.value) || 50) } })
              }
              type="number"
              value={datasetWindow}
            />
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Slope Window</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              min={3}
              onChange={(event) =>
                onUpdateNode(node.id, {
                  config: { ...node.config, slope_window: Math.max(3, Number(event.target.value) || 10) }
                })
              }
              type="number"
              value={slopeWindow}
            />
          </label>
        </div>
      ) : null}

      {node.type === "db_write" ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">DB Target</div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => onUpdateNode(node.id, { config: { ...node.config, db_target: event.target.value } })}
              value={dbTarget}
            >
              <option value="postgres">postgres</option>
              <option value="sqlite">sqlite</option>
            </select>
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">SQLite Path (optional fallback)</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => onUpdateNode(node.id, { config: { ...node.config, sqlite_path: event.target.value } })}
              placeholder="./data/engine-incidents.db"
              value={sqlitePath}
            />
          </label>
          <div className="text-[11px] text-slate-500">
            Uses <code>DATABASE_URL</code> for postgres and local file for sqlite.
          </div>
        </div>
      ) : null}

      {node.type === "output" ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Output Mode</div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, outputMode: event.target.value } })
              }
              value={outputMode}
            >
              <option value="run_summary">run_summary</option>
              <option value="webhook">webhook</option>
            </select>
          </label>
          <label className="block text-xs">
            <div className="mb-1 text-slate-600">Message Template</div>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, messageTemplate: event.target.value } })
              }
              placeholder="# Summary for {{workflowId}}"
              rows={3}
              value={messageTemplate}
            />
          </label>
          {outputMode === "webhook" ? (
            <label className="block text-xs">
              <div className="mb-1 text-slate-600">Webhook URL</div>
              <input
                className="w-full rounded border border-slate-300 px-2 py-1"
                onChange={(event) =>
                  onUpdateNode(node.id, { config: { ...node.config, webhookUrl: event.target.value } })
                }
                placeholder="https://example.com/hook"
                value={webhookUrl}
              />
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-xs">
            <input
              checked={includeContext}
              onChange={(event) =>
                onUpdateNode(node.id, { config: { ...node.config, includeContext: event.target.checked } })
              }
              type="checkbox"
            />
            Include context payload
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
