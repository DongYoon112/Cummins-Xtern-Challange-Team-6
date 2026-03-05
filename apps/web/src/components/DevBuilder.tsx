import { useMemo, useState } from "react";
import { ToolPicker } from "./ToolPicker";
import {
  LLM_MODEL_OPTIONS,
  STEP_LIST,
  flowBuilderToSchema,
  schemaToDevBuilder,
  schemaToFlowBuilder,
  devBuilderToSchema,
  getDefaultModelForProvider,
  type AgentType,
  type LlmProvider,
  type WorkflowConfig,
  type WorkflowNodeType,
  type ToolId,
  type WorkflowToolConfig
} from "../lib/workflowBuilderSchema";

type DevBuilderProps = {
  config: WorkflowConfig;
  onConfigChange: (next: WorkflowConfig) => void;
};

function nodeDefaultPosition(type: WorkflowNodeType) {
  if (type === "memory") {
    return { x: 310, y: 300 };
  }
  if (type === "router") {
    return { x: 520, y: 280 };
  }
  return { x: 700, y: 160 };
}

export function DevBuilder({ config, onConfigChange }: DevBuilderProps) {
  const [activeStep, setActiveStep] = useState<(typeof STEP_LIST)[number]>("Model");
  const devState = useMemo(() => schemaToDevBuilder(config), [config]);
  const availableModels = LLM_MODEL_OPTIONS[devState.llmProvider];
  const modelOptions = availableModels.includes(devState.llmModel)
    ? availableModels
    : [devState.llmModel, ...availableModels].filter(Boolean);

  function updateFromDevState(patch: Partial<typeof devState>) {
    const next = devBuilderToSchema({ ...devState, ...patch }, config);
    onConfigChange(next);
  }

  function updateToolToggle(toolId: ToolId, enabled: boolean) {
    const selected = new Set(devState.selectedToolIds);
    if (enabled) {
      selected.add(toolId);
    } else {
      selected.delete(toolId);
    }
    updateFromDevState({ selectedToolIds: Array.from(selected) });
  }

  function updateToolConfig(toolId: ToolId, patch: Partial<WorkflowToolConfig>) {
    updateFromDevState({
      toolConfigs: {
        ...devState.toolConfigs,
        [toolId]: {
          ...devState.toolConfigs[toolId],
          ...patch
        }
      }
    });
  }

  function upsertNodeConfig(type: WorkflowNodeType, patch: Record<string, unknown>) {
    const flow = schemaToFlowBuilder(config);
    const existing = flow.nodes.find((node) => node.type === type);
    if (existing) {
      const nextFlow = {
        ...flow,
        nodes: flow.nodes.map((node) => (node.id === existing.id ? { ...node, config: { ...node.config, ...patch } } : node))
      };
      onConfigChange(flowBuilderToSchema(nextFlow, config));
      return;
    }

    const nextFlow = {
      ...flow,
      nodes: [
        ...flow.nodes,
        {
          id: `node_${Math.random().toString(36).slice(2, 10)}`,
          type,
          position: nodeDefaultPosition(type),
          config: patch
        }
      ]
    };
    onConfigChange(flowBuilderToSchema(nextFlow, config));
  }

  function readNodeConfig(type: WorkflowNodeType, key: string) {
    const flow = schemaToFlowBuilder(config);
    const node = flow.nodes.find((candidate) => candidate.type === type);
    return String(node?.config[key] ?? "");
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[220px,1fr]">
      <aside className="rounded border border-slate-200 bg-white p-3">
        <h3 className="mb-2 text-sm font-semibold">Builder Steps</h3>
        <div className="space-y-1">
          {STEP_LIST.map((step) => (
            <button
              className={`w-full rounded px-2 py-1 text-left text-sm ${
                activeStep === step ? "bg-accent text-white" : "bg-slate-100 text-slate-700"
              }`}
              key={step}
              onClick={() => setActiveStep(step)}
              type="button"
            >
              {step}
            </button>
          ))}
        </div>
      </aside>

      <section className="rounded border border-slate-200 bg-white p-4">
        {activeStep === "Model" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <div className="mb-1 text-slate-700">Workflow name</div>
              <input
                className="w-full rounded border border-slate-300 px-2 py-1"
                onChange={(event) => updateFromDevState({ name: event.target.value })}
                value={devState.name}
              />
            </label>

            <label className="text-sm">
              <div className="mb-1 text-slate-700">Agent Type</div>
              <select
                className="w-full rounded border border-slate-300 px-2 py-1"
                onChange={(event) => updateFromDevState({ agentType: event.target.value as AgentType })}
                value={devState.agentType}
              >
                <option value="Orchestrator">Orchestrator</option>
                <option value="Research">Research</option>
                <option value="Code">Code</option>
                <option value="Data/Analytics">Data/Analytics</option>
                <option value="Ops/DevOps">Ops/DevOps</option>
                <option value="Custom">Custom</option>
              </select>
            </label>

            <label className="text-sm">
              <div className="mb-1 text-slate-700">LLM Provider</div>
              <select
                className="w-full rounded border border-slate-300 px-2 py-1"
                onChange={(event) => {
                  const nextProvider = event.target.value as LlmProvider;
                  updateFromDevState({
                    llmProvider: nextProvider,
                    llmModel: getDefaultModelForProvider(nextProvider)
                  });
                }}
                value={devState.llmProvider}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Claude</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>

            <label className="text-sm">
              <div className="mb-1 text-slate-700">LLM Model</div>
              <select
                className="w-full rounded border border-slate-300 px-2 py-1"
                onChange={(event) => updateFromDevState({ llmModel: event.target.value })}
                value={devState.llmModel}
              >
                {modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {activeStep === "Model" ? (
          <div className="mt-2 text-xs text-slate-500">
            Provider-specific model options are shown automatically.
          </div>
        ) : null}
        
        {activeStep === "Tools" ? (
          <ToolPicker
            onToggleTool={updateToolToggle}
            onUpdateToolConfig={updateToolConfig}
            tools={config.tools}
          />
        ) : null}

        {activeStep === "Memory" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <div className="mb-1 text-slate-700">Memory strategy</div>
              <select
                className="w-full rounded border border-slate-300 px-2 py-1"
                onChange={(event) => upsertNodeConfig("memory", { strategy: event.target.value })}
                value={readNodeConfig("memory", "strategy")}
              >
                <option value="">Select strategy</option>
                <option value="window">window</option>
                <option value="summary">summary</option>
                <option value="episodic">episodic</option>
              </select>
            </label>
            <label className="text-sm">
              <div className="mb-1 text-slate-700">Window size</div>
              <input
                className="w-full rounded border border-slate-300 px-2 py-1"
                onChange={(event) => upsertNodeConfig("memory", { windowSize: Number(event.target.value) || 0 })}
                type="number"
                value={readNodeConfig("memory", "windowSize")}
              />
            </label>
          </div>
        ) : null}

        {activeStep === "Routing" ? (
          <label className="text-sm">
            <div className="mb-1 text-slate-700">Routing Condition</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => upsertNodeConfig("router", { condition: event.target.value })}
              placeholder="confidence < 0.6 or costImpactUSD > 500"
              value={readNodeConfig("router", "condition")}
            />
          </label>
        ) : null}

        {activeStep === "Output" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <div className="mb-1 text-slate-700">Output format</div>
              <select
                className="w-full rounded border border-slate-300 px-2 py-1"
                onChange={(event) => upsertNodeConfig("output", { format: event.target.value })}
                value={readNodeConfig("output", "format")}
              >
                <option value="">Select output format</option>
                <option value="json">JSON</option>
                <option value="markdown">Markdown</option>
                <option value="html">HTML</option>
              </select>
            </label>
            <label className="text-sm">
              <div className="mb-1 text-slate-700">Destination</div>
              <input
                className="w-full rounded border border-slate-300 px-2 py-1"
                onChange={(event) => upsertNodeConfig("output", { destination: event.target.value })}
                placeholder="dashboard, email, webhook..."
                value={readNodeConfig("output", "destination")}
              />
            </label>
          </div>
        ) : null}

        {activeStep === "Review" ? (
          <div className="space-y-2 text-sm">
            <p>
              Agent Type: <span className="font-semibold">{config.agentType}</span>
            </p>
            <p>
              Model:{" "}
              <span className="font-semibold">
                {config.llmProvider} / {config.llmModel}
              </span>
            </p>
            <p>
              Enabled Tools:{" "}
              <span className="font-semibold">
                {config.tools.filter((tool) => tool.enabled).map((tool) => tool.label).join(", ") || "none"}
              </span>
            </p>
            <p className="text-xs text-slate-500">
              Use Save Draft to persist locally and to `/api/workflows/draft`.
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
