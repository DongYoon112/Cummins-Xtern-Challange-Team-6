export type Decision = {
  actionId: string;
  decision: "approve" | "reject" | "more_evidence";
  rationale?: string;
};
