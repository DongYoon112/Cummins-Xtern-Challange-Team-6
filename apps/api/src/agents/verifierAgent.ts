import { z } from "zod";

const GenericOutputSchema = z
  .object({
    summary: z.string().optional(),
    costImpactUSD: z.number().optional()
  })
  .passthrough();

export function runVerifier(output: Record<string, unknown>, confidence: number, threshold?: number) {
  const parsed = GenericOutputSchema.safeParse(output);

  if (!parsed.success) {
    return {
      valid: false,
      lowConfidence: true,
      requiresApproval: true,
      rationale: `Schema validation failed: ${parsed.error.errors
        .map((entry) => entry.message)
        .join("; ")}`
    };
  }

  const minConfidence = threshold ?? 0.6;
  const lowConfidence = confidence < minConfidence;

  return {
    valid: true,
    lowConfidence,
    requiresApproval: lowConfidence,
    rationale: lowConfidence
      ? `Confidence ${confidence.toFixed(2)} is below configured threshold ${minConfidence.toFixed(2)}.`
      : "Output schema and confidence checks passed."
  };
}