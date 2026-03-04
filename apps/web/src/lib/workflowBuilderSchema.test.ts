import test from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultWorkflowConfig,
  devBuilderToSchema,
  flowBuilderToSchema,
  schemaToDevBuilder,
  schemaToFlowBuilder,
  validateFlowGraph
} from "./workflowBuilderSchema";

test("validateFlowGraph accepts default graph", () => {
  const config = createDefaultWorkflowConfig();
  const result = validateFlowGraph(config.graph!);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateFlowGraph requires exactly one start node", () => {
  const config = createDefaultWorkflowConfig();
  config.graph!.nodes.push({
    id: "extra_start",
    type: "start",
    position: { x: 10, y: 10 },
    config: {}
  });

  const result = validateFlowGraph(config.graph!);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("exactly one Start")));
});

test("validateFlowGraph requires output reachable from start", () => {
  const config = createDefaultWorkflowConfig();
  const start = config.graph!.nodes.find((node) => node.type === "start")!;
  const output = config.graph!.nodes.find((node) => node.type === "output")!;
  config.graph!.edges = [{ id: "broken", source: output.id, target: start.id }];

  const result = validateFlowGraph(config.graph!);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("connected path")));
});

test("dev/schema converters preserve selected tools and settings", () => {
  const base = createDefaultWorkflowConfig();
  const devState = schemaToDevBuilder(base);
  devState.selectedToolIds = ["web_search", "database"];
  devState.agentType = "Data/Analytics";
  devState.toolConfigs.database = {
    connectionString: "postgres://localhost:5432/analytics",
    rateLimitPerMin: 99
  };

  const next = devBuilderToSchema(devState, base);
  assert.equal(next.agentType, "Data/Analytics");
  assert.equal(next.tools.find((tool) => tool.id === "web_search")?.enabled, true);
  assert.equal(next.tools.find((tool) => tool.id === "database")?.config.rateLimitPerMin, 99);
});

test("flow/schema converters keep graph data", () => {
  const base = createDefaultWorkflowConfig();
  const flow = schemaToFlowBuilder(base);
  flow.nodes.push({
    id: "memory_1",
    type: "memory",
    position: { x: 450, y: 260 },
    config: { strategy: "window" }
  });

  const next = flowBuilderToSchema(flow, base);
  assert.equal(next.graph?.nodes.some((node) => node.id === "memory_1"), true);
});
