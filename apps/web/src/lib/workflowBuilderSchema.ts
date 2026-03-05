export type AgentType =
  | "Orchestrator"
  | "Research"
  | "Code"
  | "Data/Analytics"
  | "Ops/DevOps"
  | "Custom";

export type LlmProvider = "openai" | "anthropic" | "gemini";

export type ToolId =
  | "web_search"
  | "http_requests"
  | "filesystem"
  | "database"
  | "calendar_email"
  | "code_execution"
  | "vector_store";

export type ToolCategory = "Discovery" | "Integration" | "System" | "Data" | "Communication" | "AI";

export type WorkflowNodeType =
  | "start"
  | "llm"
  | "tool"
  | "router"
  | "memory"
  | "debate"
  | "dataset_loader"
  | "feature_builder"
  | "db_write"
  | "output";

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  config: Record<string, unknown>;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
};

export type WorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type WorkflowToolConfig = {
  apiKey?: string;
  baseUrl?: string;
  scopes?: string[];
  rateLimitPerMin?: number;
  allowRead?: boolean;
  allowWrite?: boolean;
  connectionString?: string;
  sandboxProfile?: "restricted" | "standard";
  indexName?: string;
  isStub?: boolean;
};

export type WorkflowTool = {
  id: ToolId;
  label: string;
  category: ToolCategory;
  enabled: boolean;
  config: WorkflowToolConfig;
};

export type WorkflowConfig = {
  id: string;
  name: string;
  description?: string;
  agentType: AgentType;
  llmProvider: LlmProvider;
  llmModel: string;
  tools: WorkflowTool[];
  graph?: WorkflowGraph;
};

export type DevBuilderState = {
  id: string;
  name: string;
  agentType: AgentType;
  llmProvider: LlmProvider;
  llmModel: string;
  selectedToolIds: ToolId[];
  toolConfigs: Partial<Record<ToolId, WorkflowToolConfig>>;
};

export type FlowBuilderState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export const WORKFLOW_DRAFT_STORAGE_KEY = "agentfoundry.workflowDraft.step1";

export const TOOL_DEFINITIONS: Array<{
  id: ToolId;
  label: string;
  category: ToolCategory;
  defaultConfig: WorkflowToolConfig;
}> = [
  {
    id: "web_search",
    label: "Web search",
    category: "Discovery",
    defaultConfig: { baseUrl: "https://api.search.local", scopes: ["news", "docs"], rateLimitPerMin: 30 }
  },
  {
    id: "http_requests",
    label: "HTTP requests",
    category: "Integration",
    defaultConfig: { baseUrl: "https://api.example.com", scopes: ["read"], rateLimitPerMin: 60 }
  },
  {
    id: "filesystem",
    label: "Filesystem (read/write)",
    category: "System",
    defaultConfig: { allowRead: true, allowWrite: false, scopes: ["./data"] }
  },
  {
    id: "database",
    label: "Database",
    category: "Data",
    defaultConfig: { connectionString: "postgres://localhost:5432/app", scopes: ["read"], rateLimitPerMin: 120 }
  },
  {
    id: "calendar_email",
    label: "Calendar/Email (stub)",
    category: "Communication",
    defaultConfig: { isStub: true, scopes: ["calendar.read", "email.send"] }
  },
  {
    id: "code_execution",
    label: "Code execution (sandboxed)",
    category: "System",
    defaultConfig: { sandboxProfile: "restricted", rateLimitPerMin: 10 }
  },
  {
    id: "vector_store",
    label: "Vector store (stub)",
    category: "AI",
    defaultConfig: { isStub: true, indexName: "agentfoundry-default" }
  }
];

export const STEP_LIST = ["Model", "Tools", "Memory", "Routing", "Output", "Review"] as const;

export const LLM_MODEL_OPTIONS: Record<LlmProvider, string[]> = {
  openai: ["gpt-4.1-mini", "gpt-4.1", "o4-mini"],
  anthropic: ["claude-3-7-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"],
  gemini: ["gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-pro"]
};

export function getDefaultModelForProvider(provider: LlmProvider) {
  return LLM_MODEL_OPTIONS[provider][0];
}

function generateId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createDefaultWorkflowConfig(): WorkflowConfig {
  const startId = generateId("node");
  const datasetLoaderId = generateId("node");
  const featureBuilderId = generateId("node");
  const debateId = generateId("node");
  const orchestratorId = generateId("node");
  const dbWriteId = generateId("node");
  const outputId = generateId("node");

  return {
    id: generateId("wf"),
    name: "CMAPSS Incident Demo",
    description: "Start -> Dataset Loader -> Feature Builder -> Debate -> Orchestrator -> DB Write -> Output",
    agentType: "Data/Analytics",
    llmProvider: "openai",
    llmModel: "gpt-4.1-mini",
    tools: TOOL_DEFINITIONS.map((tool) => ({
      id: tool.id,
      label: tool.label,
      category: tool.category,
      enabled: false,
      config: { ...tool.defaultConfig }
    })),
    graph: {
      nodes: [
        { id: startId, type: "start", position: { x: 100, y: 150 }, config: { label: "Start" } },
        {
          id: datasetLoaderId,
          type: "dataset_loader",
          position: { x: 330, y: 150 },
          config: {
            label: "Dataset Loader",
            agentName: "DatasetLoaderAgent",
            dataset: "FD001",
            unit_id: 1,
            window: 50,
            source: "download",
            cache_dir: "./data/CMAPSS"
          }
        },
        {
          id: featureBuilderId,
          type: "feature_builder",
          position: { x: 560, y: 150 },
          config: {
            label: "Feature Builder",
            agentName: "FeatureBuilderAgent",
            window: 50,
            slope_window: 10
          }
        },
        {
          id: debateId,
          type: "debate",
          position: { x: 790, y: 150 },
          config: {
            label: "Debate",
            agentName: "CMAPSS Debate Agent",
            llmProvider: "openai",
            llmModel: "gpt-4.1-mini",
            debateTopic: "Diagnose probable failure mode using top CMAPSS anomalies.",
            debateRounds: 2,
            outputSchemaVersion: "v1",
            requireJson: true
          }
        },
        {
          id: orchestratorId,
          type: "llm",
          position: { x: 1020, y: 150 },
          config: {
            label: "Orchestrator",
            agentName: "Incident Orchestrator Agent"
          }
        },
        {
          id: dbWriteId,
          type: "db_write",
          position: { x: 1250, y: 150 },
          config: {
            label: "DB Write",
            agentName: "DbWriteAgent",
            db_target: "sqlite",
            sqlite_path: "./data/engine-incidents.db"
          }
        },
        {
          id: outputId,
          type: "output",
          position: { x: 1480, y: 150 },
          config: {
            label: "Output",
            outputMode: "run_summary",
            messageTemplate: "# CMAPSS Incident Result\n\n{{lastOutput}}",
            includeContext: false
          }
        }
      ],
      edges: [
        { id: generateId("edge"), source: startId, target: datasetLoaderId },
        { id: generateId("edge"), source: datasetLoaderId, target: featureBuilderId },
        { id: generateId("edge"), source: featureBuilderId, target: debateId },
        { id: generateId("edge"), source: debateId, target: orchestratorId },
        { id: generateId("edge"), source: orchestratorId, target: dbWriteId },
        { id: generateId("edge"), source: dbWriteId, target: outputId }
      ]
    }
  };
}

export function schemaToDevBuilder(config: WorkflowConfig): DevBuilderState {
  const selectedToolIds = config.tools.filter((tool) => tool.enabled).map((tool) => tool.id);
  const toolConfigs = config.tools.reduce<Partial<Record<ToolId, WorkflowToolConfig>>>((acc, tool) => {
    acc[tool.id] = { ...tool.config };
    return acc;
  }, {});

  return {
    id: config.id,
    name: config.name,
    agentType: config.agentType,
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
    selectedToolIds,
    toolConfigs
  };
}

export function devBuilderToSchema(devState: DevBuilderState, previous?: WorkflowConfig): WorkflowConfig {
  const tools = TOOL_DEFINITIONS.map((tool) => {
    const previousConfig = previous?.tools.find((entry) => entry.id === tool.id)?.config;
    const fromDev = devState.toolConfigs[tool.id];
    return {
      id: tool.id,
      label: tool.label,
      category: tool.category,
      enabled: devState.selectedToolIds.includes(tool.id),
      config: {
        ...tool.defaultConfig,
        ...previousConfig,
        ...fromDev
      }
    };
  });

  return {
    id: devState.id,
    name: devState.name,
    description: previous?.description ?? "",
    agentType: devState.agentType,
    llmProvider: devState.llmProvider,
    llmModel: devState.llmModel,
    tools,
    graph: previous?.graph
  };
}

export function schemaToFlowBuilder(config: WorkflowConfig): FlowBuilderState {
  const graph = config.graph ?? { nodes: [], edges: [] };
  return {
    nodes: graph.nodes.map((node) => ({ ...node, config: { ...node.config } })),
    edges: graph.edges.map((edge) => ({ ...edge }))
  };
}

export function flowBuilderToSchema(flowState: FlowBuilderState, previous: WorkflowConfig): WorkflowConfig {
  return {
    ...previous,
    graph: {
      nodes: flowState.nodes.map((node) => ({ ...node, config: { ...node.config } })),
      edges: flowState.edges.map((edge) => ({ ...edge }))
    }
  };
}

export function validateFlowGraph(graph: WorkflowGraph) {
  const errors: string[] = [];
  const starts = graph.nodes.filter((node) => node.type === "start");
  const outputs = graph.nodes.filter((node) => node.type === "output");

  if (starts.length !== 1) {
    errors.push("Graph must contain exactly one Start node.");
  }

  if (outputs.length < 1) {
    errors.push("Graph must contain at least one Output node.");
  }

  if (starts.length === 1 && outputs.length > 0) {
    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const list = adjacency.get(edge.source) ?? [];
      list.push(edge.target);
      adjacency.set(edge.source, list);
    }

    const startNodeId = starts[0].id;
    const visited = new Set<string>();
    const stack = [startNodeId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      const next = adjacency.get(current) ?? [];
      for (const candidate of next) {
        if (!visited.has(candidate)) {
          stack.push(candidate);
        }
      }
    }

    const hasConnectedOutput = outputs.some((output) => visited.has(output.id));
    if (!hasConnectedOutput) {
      errors.push("Graph must include a connected path from Start to at least one Output.");
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
