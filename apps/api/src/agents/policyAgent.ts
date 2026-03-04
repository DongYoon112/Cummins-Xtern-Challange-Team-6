import { containsBlockedFields, evaluateApprovalRules, redactBlockedFields } from "../lib/policy";

export function runPolicyInputCheck(input: Record<string, unknown>) {
  const blocked = containsBlockedFields(input);
  const sanitized = redactBlockedFields(input);

  return {
    sanitizedInput: sanitized,
    blockedFields: blocked,
    rationale:
      blocked.length > 0
        ? `Detected blocked fields (${blocked.join(", ")}); values were redacted before task execution.`
        : "No blocked fields detected."
  };
}

export function runPolicyOutputCheck(output: Record<string, unknown>, confidence: number) {
  const decision = evaluateApprovalRules(output, confidence);
  return {
    ...decision,
    rationale: decision.requiresApproval
      ? `Approval required because ${decision.reasons.join(" and ")}.`
      : "Output passed governance thresholds without approval."
  };
}