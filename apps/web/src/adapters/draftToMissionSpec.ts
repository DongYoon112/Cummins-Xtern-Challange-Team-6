import type { MissionSpec } from "../domain/MissionSpec";

function readString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function draftToMissionSpec(draftWorkflow: unknown): MissionSpec {
  const root = asRecord(draftWorkflow);
  const graph = asRecord(root.graph);
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const nonStartNodes = nodes
    .map((node) => asRecord(node))
    .filter((node) => node.type !== "start");

  const steps = nonStartNodes.map((node, index) => {
    const config = asRecord(node.config);
    const toolHints: string[] = [];
    if (typeof config.toolId === "string") {
      toolHints.push(config.toolId);
    }
    if (typeof config.toolName === "string") {
      toolHints.push(config.toolName);
    }

    return {
      id: readString(node.id, `step-${index + 1}`),
      name: readString(config.label, readString(node.type, `Step ${index + 1}`)),
      toolHints: toolHints.length > 0 ? toolHints : undefined
    };
  });

  const constraints = {
    budgetCap:
      typeof root.budgetCap === "number"
        ? root.budgetCap
        : typeof asRecord(root.budget).cap === "number"
          ? (asRecord(root.budget).cap as number)
          : undefined,
    allowlistedSources: Array.isArray(root.allowlistedSources)
      ? root.allowlistedSources.filter((item): item is string => typeof item === "string")
      : undefined,
    modelPolicy: typeof root.modelPolicy === "string" ? root.modelPolicy : "governed-default"
  };

  return {
    objective: readString(root.name, "Mission: Generated from draft"),
    steps: steps.length > 0 ? steps : [{ id: "step-1", name: "Initial assessment" }],
    constraints
  };
}
