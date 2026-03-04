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

export type WorkflowNodeType = "start" | "llm" | "tool" | "router" | "memory" | "output";

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

function generateId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createDefaultWorkflowConfig(): WorkflowConfig {
  const startId = generateId("node");
  const llmId = generateId("node");
  const outputId = generateId("node");

  return {
    id: generateId("wf"),
    name: "Step 1 Draft",
    description: "",
    agentType: "Orchestrator",
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
        { id: llmId, type: "llm", position: { x: 330, y: 150 }, config: { label: "Model" } },
        { id: outputId, type: "output", position: { x: 560, y: 150 }, config: { label: "Output" } }
      ],
      edges: [
        { id: generateId("edge"), source: startId, target: llmId },
        { id: generateId("edge"), source: llmId, target: outputId }
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
