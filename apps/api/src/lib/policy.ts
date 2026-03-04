const BLOCKED_FIELDS = new Set(["ssn", "phone", "email"]);

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(source)) {
      if (BLOCKED_FIELDS.has(key.toLowerCase())) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = redactValue(nested);
      }
    }

    return output;
  }

  return value;
}

export function redactBlockedFields<T>(input: T): T {
  return redactValue(input) as T;
}

export function evaluateApprovalRules(output: Record<string, unknown>, confidence: number): {
  requiresApproval: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (confidence < 0.6) {
    reasons.push("confidence below 0.6");
  }

  if (
    Object.prototype.hasOwnProperty.call(output, "costImpactUSD") &&
    Number(output.costImpactUSD) > 500
  ) {
    reasons.push("costImpactUSD exceeds 500");
  }

  return {
    requiresApproval: reasons.length > 0,
    reasons
  };
}

export function containsBlockedFields(input: unknown): string[] {
  const found = new Set<string>();

  const scan = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }

    if (value && typeof value === "object") {
      const source = value as Record<string, unknown>;
      for (const [key, nested] of Object.entries(source)) {
        if (BLOCKED_FIELDS.has(key.toLowerCase())) {
          found.add(key);
        }
        scan(nested);
      }
    }
  };

  scan(input);
  return Array.from(found);
}