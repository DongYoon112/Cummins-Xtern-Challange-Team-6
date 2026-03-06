import { useEffect, useMemo, useRef, useState } from "react";
import { ConfigDrawer } from "./ConfigDrawer";
import {
  flowBuilderToSchema,
  schemaToFlowBuilder,
  validateFlowGraph,
  type WorkflowConfig,
  type WorkflowNode,
  type WorkflowNodeType
} from "../lib/workflowBuilderSchema";

type FlowBuilderProps = {
  config: WorkflowConfig;
  onConfigChange: (next: WorkflowConfig) => void;
};

type ViewportState = {
  x: number;
  y: number;
  scale: number;
};

type CanvasPoint = {
  x: number;
  y: number;
};

type DragState =
  | {
      type: "node";
      nodeId: string;
      startClientX: number;
      startClientY: number;
      startNodeX: number;
      startNodeY: number;
    }
  | {
      type: "pan";
      startClientX: number;
      startClientY: number;
      startViewportX: number;
      startViewportY: number;
    }
  | null;

const NODE_SIZE = { width: 180, height: 84 };

const NODE_TYPE_LABELS: Record<WorkflowNodeType, string> = {
  start: "Start",
  llm: "LLM",
  tool: "Tool",
  router: "Router",
  memory: "Memory",
  debate: "Debate",
  dataset_loader: "Dataset Loader",
  feature_builder: "Feature Builder",
  db_write: "DB Write",
  output: "Output"
};

function getNodeModeBadge(node: WorkflowNode) {
  if (node.type !== "llm") {
    return node.type;
  }
  const mode = String(node.config.llmNodeMode ?? "llm").toLowerCase();
  if (mode === "debate") {
    return "debate";
  }
  if (mode === "orchestrator") {
    return "orchestrator";
  }
  if (mode === "summary_llm") {
    return "summary";
  }
  return "llm";
}

function nextId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function nodeColor(type: WorkflowNodeType) {
  switch (type) {
    case "start":
      return "border-emerald-400 bg-emerald-50";
    case "llm":
      return "border-orange-400 bg-orange-50";
    case "tool":
      return "border-amber-400 bg-amber-50";
    case "router":
      return "border-amber-400 bg-amber-50";
    case "memory":
      return "border-orange-300 bg-orange-50";
    case "debate":
      return "border-amber-300 bg-amber-50";
    case "dataset_loader":
      return "border-sky-400 bg-sky-50";
    case "feature_builder":
      return "border-cyan-400 bg-cyan-50";
    case "db_write":
      return "border-fuchsia-400 bg-fuchsia-50";
    case "output":
      return "border-orange-500 bg-orange-50";
    default:
      return "border-slate-300 bg-white";
  }
}

function buildCurvePath(x1: number, y1: number, x2: number, y2: number) {
  if (x2 >= x1) {
    const dx = Math.max(40, Math.min(120, (x2 - x1) * 0.5));
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  const liftY = Math.min(y1, y2) - 56;
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${x1 + 64} ${y1}, ${x1 + 64} ${liftY}, ${midX} ${liftY} C ${x2 - 64} ${liftY}, ${x2 - 64} ${y2}, ${x2} ${y2}`;
}

export function FlowBuilder({ config, onConfigChange }: FlowBuilderProps) {
  const flow = useMemo(() => schemaToFlowBuilder(config), [config]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectionDrag, setConnectionDrag] = useState<{ sourceId: string; point: CanvasPoint } | null>(null);
  const [nodeTypeToAdd, setNodeTypeToAdd] = useState<WorkflowNodeType>("llm");
  const [viewport, setViewport] = useState<ViewportState>({ x: 30, y: 30, scale: 1 });
  const viewportRef = useRef(viewport);
  const dragRef = useRef<DragState>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      setCanvasSize({ width: rect.width, height: rect.height });
    };

    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const selectedNode = flow.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const graphValidation = validateFlowGraph(config.graph ?? { nodes: [], edges: [] });

  function updateFlow(
    updater: (current: ReturnType<typeof schemaToFlowBuilder>) => ReturnType<typeof schemaToFlowBuilder>
  ) {
    const nextFlow = updater(schemaToFlowBuilder(config));
    onConfigChange(flowBuilderToSchema(nextFlow, config));
  }

  function addNode(type: WorkflowNodeType) {
    updateFlow((current) => {
      const id = nextId("node");
      const nextNode: WorkflowNode = {
        id,
        type,
        position: {
          x: Math.round((260 - viewportRef.current.x) / viewportRef.current.scale),
          y: Math.round((180 - viewportRef.current.y) / viewportRef.current.scale)
        },
        config:
          type === "llm"
            ? { label: NODE_TYPE_LABELS[type], description: "", llmNodeMode: "llm" }
            : { label: NODE_TYPE_LABELS[type], description: "" }
      };
      return {
        ...current,
        nodes: [...current.nodes, nextNode]
      };
    });
    setSelectedNodeId(null);
  }

  function updateNode(nodeId: string, patch: Partial<WorkflowNode>) {
    updateFlow((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node))
    }));
  }

  function deleteNode(nodeId: string) {
    updateFlow((current) => ({
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      edges: current.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
    }));
    setSelectedNodeId((current) => (current === nodeId ? null : current));
    setConnectionDrag((current) => (current?.sourceId === nodeId ? null : current));
    setSelectedEdgeId(null);
  }

  function beginNodeDrag(event: React.MouseEvent, node: WorkflowNode) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedNodeId(node.id);
    dragRef.current = {
      type: "node",
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startNodeX: node.position.x,
      startNodeY: node.position.y
    };
  }

  function beginPan(event: React.MouseEvent) {
    const target = event.target as HTMLElement;
    if (
      target.closest("[data-role='node-card']") ||
      target.closest("[data-role='edge-hit']") ||
      target.closest("button") ||
      target.closest("input") ||
      target.closest("textarea") ||
      target.closest("select")
    ) {
      return;
    }

    dragRef.current = {
      type: "pan",
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewportX: viewportRef.current.x,
      startViewportY: viewportRef.current.y
    };
    setSelectedNodeId(null);
  }

  function addEdge(source: string, target: string) {
    if (!source || !target || source === target) {
      return;
    }

    updateFlow((current) => {
      const exists = current.edges.some((edge) => edge.source === source && edge.target === target);
      if (exists) {
        return current;
      }
      return {
        ...current,
        edges: [...current.edges, { id: nextId("edge"), source, target }]
      };
    });
  }

  function deleteSelectedEdge() {
    if (!selectedEdgeId) {
      return;
    }
    updateFlow((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edge.id !== selectedEdgeId)
    }));
    setSelectedEdgeId(null);
  }

  function clientToCanvasPoint(clientX: number, clientY: number): CanvasPoint | null {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - viewportRef.current.x) / viewportRef.current.scale,
      y: (clientY - rect.top - viewportRef.current.y) / viewportRef.current.scale
    };
  }

  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      const state = dragRef.current;
      if (state) {
        if (state.type === "node") {
          const dx = (event.clientX - state.startClientX) / viewportRef.current.scale;
          const dy = (event.clientY - state.startClientY) / viewportRef.current.scale;
          updateNode(state.nodeId, {
            position: {
              x: Math.round(state.startNodeX + dx),
              y: Math.round(state.startNodeY + dy)
            }
          });
        } else {
          const dx = event.clientX - state.startClientX;
          const dy = event.clientY - state.startClientY;
          setViewport((current) => ({
            ...current,
            x: state.startViewportX + dx,
            y: state.startViewportY + dy
          }));
        }
      }

      if (connectionDrag) {
        const point = clientToCanvasPoint(event.clientX, event.clientY);
        if (point) {
          setConnectionDrag((current) => (current ? { ...current, point } : current));
        }
      }
    }

    function onMouseUp() {
      dragRef.current = null;
      setConnectionDrag(null);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isTypingTarget = tagName === "input" || tagName === "textarea" || target?.isContentEditable;
      if (isTypingTarget) {
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedNodeId) {
          event.preventDefault();
          deleteNode(selectedNodeId);
          return;
        }
        if (!selectedEdgeId) {
          return;
        }
        event.preventDefault();
        deleteSelectedEdge();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedEdgeId, selectedNodeId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const onNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const nextScale = Math.max(0.5, Math.min(1.8, viewportRef.current.scale + (event.deltaY < 0 ? 0.08 : -0.08)));
      setViewport((current) => ({ ...current, scale: Number(nextScale.toFixed(2)) }));
    };

    canvas.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onNativeWheel);
    };
  }, []);

  const minimap = useMemo(() => {
    const mapWidth = 180;
    const mapHeight = 110;
    const nodes = flow.nodes;
    if (nodes.length === 0) {
      return {
        mapWidth,
        mapHeight,
        scale: 1,
        originX: 0,
        originY: 0,
        world: { minX: 0, minY: 0, width: 1, height: 1 },
        viewportRect: { x: 0, y: 0, width: mapWidth, height: mapHeight }
      };
    }

    const minX = Math.min(...nodes.map((node) => node.position.x)) - 80;
    const minY = Math.min(...nodes.map((node) => node.position.y)) - 80;
    const maxX = Math.max(...nodes.map((node) => node.position.x + NODE_SIZE.width)) + 80;
    const maxY = Math.max(...nodes.map((node) => node.position.y + NODE_SIZE.height)) + 80;
    const worldWidth = Math.max(1, maxX - minX);
    const worldHeight = Math.max(1, maxY - minY);
    const scale = Math.min(mapWidth / worldWidth, mapHeight / worldHeight);
    const originX = (mapWidth - worldWidth * scale) / 2;
    const originY = (mapHeight - worldHeight * scale) / 2;

    const viewLeft = -viewport.x / viewport.scale;
    const viewTop = -viewport.y / viewport.scale;
    const viewWidth = canvasSize.width > 0 ? canvasSize.width / viewport.scale : worldWidth;
    const viewHeight = canvasSize.height > 0 ? canvasSize.height / viewport.scale : worldHeight;

    const viewportRect = {
      x: originX + (viewLeft - minX) * scale,
      y: originY + (viewTop - minY) * scale,
      width: viewWidth * scale,
      height: viewHeight * scale
    };

    return {
      mapWidth,
      mapHeight,
      scale,
      originX,
      originY,
      world: { minX, minY, width: worldWidth, height: worldHeight },
      viewportRect
    };
  }, [canvasSize.height, canvasSize.width, flow.nodes, viewport.scale, viewport.x, viewport.y]);

  return (
    <div className="flowchart-original grid grid-cols-1 gap-3 xl:h-[620px] xl:grid-cols-[1fr,320px]">
      <section className="rounded border border-slate-200 bg-white p-3 xl:h-full">
        <div className="grid gap-3 md:grid-cols-[220px,1fr] xl:h-full">
          <aside className="rounded border border-slate-200 bg-slate-50 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Canvas Tools</h3>
            <div className="mt-2 space-y-2">
              <select
                className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                onChange={(event) => setNodeTypeToAdd(event.target.value as WorkflowNodeType)}
                value={nodeTypeToAdd}
              >
                {(
                  [
                    "start",
                    "llm",
                    "tool",
                    "memory",
                    "dataset_loader",
                    "feature_builder",
                    "db_write",
                    "output"
                  ] as WorkflowNodeType[]
                ).map((type) => (
                  <option key={type} value={type}>
                    {NODE_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
              <button
                className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                onClick={() => addNode(nodeTypeToAdd)}
                type="button"
              >
                + Add Node
              </button>
              <button
                className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                onClick={() => setViewport({ x: 30, y: 30, scale: 1 })}
                type="button"
              >
                Reset View
              </button>
              <button
                className="w-full rounded border border-rose-300 px-2 py-1 text-xs text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!selectedNodeId}
                onClick={() => {
                  if (selectedNodeId) {
                    deleteNode(selectedNodeId);
                  }
                }}
                type="button"
              >
                Delete Selected Node
              </button>
              <button
                className="w-full rounded border border-rose-300 px-2 py-1 text-xs text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!selectedEdgeId}
                onClick={deleteSelectedEdge}
                type="button"
              >
                Delete Selected Line
              </button>
            </div>
            <div className="mt-3 space-y-1 text-[11px] text-slate-500">
              <p>Connect: drag source (right dot) to target (left dot).</p>
              <p>Delete node: click node + Delete key.</p>
              <p>Delete line: click line + Delete key.</p>
            </div>
          </aside>

          <div className="flex min-h-0 flex-col">
            <div
              className="relative h-[530px] overflow-hidden rounded border border-slate-200 xl:h-full"
              onClick={() => setSelectedEdgeId(null)}
              onMouseDown={beginPan}
              ref={canvasRef}
              style={{
                backgroundImage:
                  "linear-gradient(to right, rgba(148,163,184,0.25) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.25) 1px, transparent 1px)",
                backgroundPosition: `${viewport.x}px ${viewport.y}px`,
                backgroundSize: `${20 * viewport.scale}px ${20 * viewport.scale}px`
              }}
            >
              <div className="absolute inset-0" data-role="canvas-bg">
                <div
                  className="absolute inset-0"
                  style={{
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
                    transformOrigin: "0 0"
                  }}
                >
                  <svg className="absolute left-0 top-0 h-[2000px] w-[2600px]">
                    {flow.edges.map((edge) => {
                      const source = flow.nodes.find((node) => node.id === edge.source);
                      const target = flow.nodes.find((node) => node.id === edge.target);
                      if (!source || !target) {
                        return null;
                      }

                      const x1 = source.position.x + NODE_SIZE.width;
                      const y1 = source.position.y + NODE_SIZE.height / 2;
                      const x2 = target.position.x;
                      const y2 = target.position.y + NODE_SIZE.height / 2;
                      const path = buildCurvePath(x1, y1, x2, y2);

                      const selected = selectedEdgeId === edge.id;
                      return (
                        <g key={edge.id}>
                          <path
                            d={path}
                            fill="none"
                            data-role="edge-hit"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedNodeId(null);
                              setSelectedEdgeId(edge.id);
                            }}
                            stroke="transparent"
                            strokeWidth={10}
                          />
                          <path
                            d={path}
                            fill="none"
                            stroke={selected ? "#ef4444" : "#64748b"}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={selected ? 3 : 2}
                          />
                        </g>
                      );
                    })}
                    {connectionDrag ? (
                      (() => {
                        const source = flow.nodes.find((node) => node.id === connectionDrag.sourceId);
                        if (!source) {
                          return null;
                        }

                        const x1 = source.position.x + NODE_SIZE.width;
                        const y1 = source.position.y + NODE_SIZE.height / 2;
                        const x2 = connectionDrag.point.x;
                        const y2 = connectionDrag.point.y;
                        const path = buildCurvePath(x1, y1, x2, y2);

                        return (
                          <path
                            d={path}
                            fill="none"
                            stroke="#f59e0b"
                            strokeDasharray="5 4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                          />
                        );
                      })()
                    ) : null}
                  </svg>

                  {flow.nodes.map((node) => {
                    const selected = selectedNodeId === node.id;
                    const pending = connectionDrag?.sourceId === node.id;
                    const label = String(node.config.label ?? NODE_TYPE_LABELS[node.type]);
                    const description = String(node.config.description ?? "");
                    return (
                      <div
                        className={`absolute cursor-move rounded border p-2 text-xs shadow-sm ${nodeColor(node.type)} ${
                          selected ? "ring-2 ring-slate-500" : ""
                        } ${pending ? "ring-2 ring-amber-400" : ""}`}
                        data-role="node-card"
                        key={node.id}
                        onMouseDown={(event) => beginNodeDrag(event, node)}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedNodeId(node.id);
                          setSelectedEdgeId(null);
                        }}
                        style={{
                          left: node.position.x,
                          top: node.position.y,
                          width: NODE_SIZE.width,
                          height: NODE_SIZE.height
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">{label}</span>
                          <span className="text-[10px] uppercase text-slate-500">{getNodeModeBadge(node)}</span>
                        </div>
                        {description ? (
                          <div className="mt-1 truncate text-[11px] text-slate-600" title={description}>
                            {description}
                          </div>
                        ) : null}

                        <button
                          className="absolute left-[-7px] top-[36px] h-3.5 w-3.5 rounded-full border border-slate-600 bg-white"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onMouseUp={(event) => {
                            event.stopPropagation();
                            if (connectionDrag && connectionDrag.sourceId !== node.id) {
                              addEdge(connectionDrag.sourceId, node.id);
                              setConnectionDrag(null);
                            }
                          }}
                          title="Connect target"
                          type="button"
                        />
                        <button
                          className="absolute right-[-7px] top-[36px] h-3.5 w-3.5 rounded-full border border-slate-600 bg-white"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const point = clientToCanvasPoint(event.clientX, event.clientY);
                            if (!point) {
                              return;
                            }
                            setConnectionDrag({ sourceId: node.id, point });
                          }}
                          title="Connect source"
                          type="button"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="pointer-events-none absolute bottom-2 left-2 rounded border border-slate-300 bg-white/90 p-1 shadow">
                <svg height={minimap.mapHeight} width={minimap.mapWidth}>
                  <rect
                    fill="#f8fafc"
                    height={minimap.mapHeight}
                    rx={4}
                    stroke="#cbd5e1"
                    width={minimap.mapWidth}
                    x={0}
                    y={0}
                  />
                  {flow.edges.map((edge) => {
                    const source = flow.nodes.find((node) => node.id === edge.source);
                    const target = flow.nodes.find((node) => node.id === edge.target);
                    if (!source || !target) {
                      return null;
                    }
                    const x1 =
                      minimap.originX +
                      (source.position.x + NODE_SIZE.width / 2 - minimap.world.minX) * minimap.scale;
                    const y1 =
                      minimap.originY +
                      (source.position.y + NODE_SIZE.height / 2 - minimap.world.minY) * minimap.scale;
                    const x2 =
                      minimap.originX +
                      (target.position.x + NODE_SIZE.width / 2 - minimap.world.minX) * minimap.scale;
                    const y2 =
                      minimap.originY +
                      (target.position.y + NODE_SIZE.height / 2 - minimap.world.minY) * minimap.scale;
                    return <line key={edge.id} stroke="#94a3b8" strokeWidth={1} x1={x1} x2={x2} y1={y1} y2={y2} />;
                  })}
                  {flow.nodes.map((node) => {
                    const x = minimap.originX + (node.position.x - minimap.world.minX) * minimap.scale;
                    const y = minimap.originY + (node.position.y - minimap.world.minY) * minimap.scale;
                    const w = Math.max(3, NODE_SIZE.width * minimap.scale);
                    const h = Math.max(3, NODE_SIZE.height * minimap.scale);
                    return <rect key={node.id} fill="#0f172a" height={h} opacity={0.85} rx={1} width={w} x={x} y={y} />;
                  })}
                  <rect
                    fill="none"
                    height={Math.min(minimap.mapHeight, Math.max(8, minimap.viewportRect.height))}
                    rx={2}
                    stroke="#f97316"
                    strokeWidth={1.5}
                    width={Math.min(minimap.mapWidth, Math.max(8, minimap.viewportRect.width))}
                    x={Math.max(0, Math.min(minimap.mapWidth, minimap.viewportRect.x))}
                    y={Math.max(0, Math.min(minimap.mapHeight, minimap.viewportRect.y))}
                  />
                </svg>
              </div>
            </div>

            {!graphValidation.valid ? (
              <div className="mt-2 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
                {graphValidation.errors.join(" ")}
              </div>
            ) : (
              <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700">
                Graph validation passed.
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="xl:h-full">
        <ConfigDrawer
          node={selectedNode}
          onClose={() => setSelectedNodeId(null)}
          onDeleteNode={deleteNode}
          onUpdateNode={updateNode}
          tools={config.tools}
        />
      </div>
    </div>
  );
}
