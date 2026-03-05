export type RunEvent = {
  id?: number;
  runId: string;
  ts: string;
  kind:
    | "ingest"
    | "step_start"
    | "step_done"
    | "debate"
    | "finding"
    | "recommendation"
    | "decision"
    | "action"
    | "error"
    | "AGENT_ALERT"
    | "DEBATE_RESULT"
    | "ROUTER_DECISION_REQUIRED"
    | "WORKFLOW_STATUS_UPDATE";
  stepId?: string;
  title: string;
  data: any;
};
