export type RunEvent = {
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
    | "error";
  stepId?: string;
  title: string;
  data: any;
};
