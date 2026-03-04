import type { WorkflowStep } from "@agentfoundry/shared";

type DraftNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
};

type DraftEdge = {
  id: string;
  source: string;
  target: string;
};

type DraftGraph = {
  nodes: DraftNode[];
  edges: DraftEdge[];
};

type DraftConfig = {
  id: string;
  name: string;
  description?: string;
  tools?: Array<{
    id: string;
    enabled: boolean;
    config: Record<string, unknown>;
  }>;
  graph?: DraftGraph;
};

type CompileResult = {
  steps: WorkflowStep[];
};

function inferAgentName(node: DraftNode) {
  const explicit = node.config.agentName;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }

  if (node.type === "llm") {
    return "Notification Agent";
  }
  if (node.type === "tool") {
    return "Logistics Agent";
  }
  if (node.type === "memory") {
    return "Inventory Agent";
  }
  if (node.type === "output") {
    return "Notification Agent";
  }

  return `${node.type.toUpperCase()} Node`;
}

function nodeLabel(node: DraftNode) {
  const label = node.config.label;
  if (typeof label === "string" && label.trim()) {
    return label.trim();
  }
  return node.type.toUpperCase();
}

export function compileWorkflowDraft(config: DraftConfig): CompileResult {
  const graph = config.graph;
  if (!graph) {
    throw new Error("Draft has no graph to publish.");
  }

  const starts = graph.nodes.filter((node) => node.type === "start");
  if (starts.length !== 1) {
    throw new Error("Graph must contain exactly one Start node.");
  }

  const outputs = graph.nodes.filter((node) => node.type === "output");
  if (outputs.length < 1) {
    throw new Error("Graph must contain at least one Output node.");
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const sourceList = adjacency.get(edge.source) ?? [];
    sourceList.push(edge.target);
    adjacency.set(edge.source, sourceList);
  }

  const ordered: DraftNode[] = [];
  const visited = new Set<string>();
  const queue = [starts[0].id];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const node = nodeById.get(current);
    if (!node) {
      continue;
    }
    if (node.type !== "start") {
      ordered.push(node);
    }

    const next = adjacency.get(current) ?? [];
    for (const candidate of next) {
      if (!visited.has(candidate)) {
        queue.push(candidate);
      }
    }
  }

  const hasConnectedOutput = outputs.some((node) => visited.has(node.id));
  if (!hasConnectedOutput) {
    throw new Error("Graph must include a connected path from Start to at least one Output.");
  }

  if (ordered.length === 0) {
    throw new Error("Cannot publish draft with no executable steps.");
  }

  const toolConfigById = new Map(
    (config.tools ?? [])
      .filter((tool) => tool.enabled)
      .map((tool) => [tool.id, tool.config])
  );

  const steps: WorkflowStep[] = ordered.map((node) => {
    const isApproval = node.type === "router" || node.type === "approval";
    const toolId = typeof node.config.toolId === "string" ? node.config.toolId : "";
    const linkedToolConfig = toolId ? toolConfigById.get(toolId) : undefined;
    return {
      id: node.id,
      name: nodeLabel(node),
      kind: isApproval ? "APPROVAL" : "AGENT",
      agentName: isApproval ? undefined : inferAgentName(node),
      params: {
        ...linkedToolConfig,
        ...node.config
      }
    };
  });

  return { steps };
}
