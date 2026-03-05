type ResolveWarnings = string[];

const TOKEN_RE = /\{\{([^}]+)\}\}/g;

function parsePath(path: string): Array<string | number> {
  const normalized = path
    .replace(/\[([0-9]+)\]/g, ".$1")
    .replace(/\[['"]([^'"]+)['"]\]/g, ".$1")
    .replace(/^\./, "");
  return normalized
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^[0-9]+$/.test(part) ? Number(part) : part));
}

export function getValueByPath(root: unknown, path: string): unknown {
  const tokens = parsePath(path);
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof token === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[token];
      continue;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function setValueByPath(root: Record<string, unknown>, path: string, value: unknown) {
  const tokens = parsePath(path);
  if (tokens.length === 0) {
    return;
  }

  let current: Record<string, unknown> | unknown[] = root;
  for (let idx = 0; idx < tokens.length - 1; idx += 1) {
    const token = tokens[idx];
    const nextToken = tokens[idx + 1];
    if (typeof token === "number") {
      if (!Array.isArray(current)) {
        return;
      }
      if (current[token] === undefined || current[token] === null) {
        current[token] = typeof nextToken === "number" ? [] : {};
      }
      current = current[token] as Record<string, unknown> | unknown[];
      continue;
    }
    if (Array.isArray(current)) {
      return;
    }
    const bucket = current[token];
    if (bucket === undefined || bucket === null || typeof bucket !== "object") {
      current[token] = typeof nextToken === "number" ? [] : {};
    }
    current = current[token] as Record<string, unknown> | unknown[];
  }

  const last = tokens[tokens.length - 1];
  if (typeof last === "number") {
    if (!Array.isArray(current)) {
      return;
    }
    current[last] = value;
    return;
  }
  if (Array.isArray(current)) {
    return;
  }
  current[last] = value;
}

function resolveTemplateString(input: string, context: Record<string, unknown>, warnings: ResolveWarnings) {
  if (!input.includes("{{")) {
    return input;
  }

  return input.replace(TOKEN_RE, (full, rawPath: string) => {
    const path = rawPath.trim();
    const resolved = getValueByPath(context, path);
    if (resolved === undefined) {
      warnings.push(`Unresolved template token: ${path}`);
      return full;
    }
    if (resolved === null) {
      return "null";
    }
    if (typeof resolved === "object") {
      try {
        return JSON.stringify(resolved);
      } catch {
        warnings.push(`Failed to stringify token value: ${path}`);
        return full;
      }
    }
    return String(resolved);
  });
}

export function resolveTemplates<T>(
  input: T,
  context: Record<string, unknown>
): { value: T; warnings: string[] } {
  const warnings: string[] = [];

  function visit(value: unknown): unknown {
    if (typeof value === "string") {
      return resolveTemplateString(value, context, warnings);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => visit(entry));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = visit(entry);
      }
      return out;
    }
    return value;
  }

  return {
    value: visit(input) as T,
    warnings
  };
}

const FORBIDDEN_ROUTE_TOKENS = [
  "constructor",
  "prototype",
  "__proto__",
  "globalThis",
  "process",
  "require",
  "Function",
  "eval",
  ";"
];

export function evaluateRouteCondition(expression: string, context: Record<string, unknown>) {
  const trimmed = expression.trim();
  if (!trimmed) {
    return {
      matched: false,
      error: "Route condition is empty."
    };
  }
  if (trimmed.length > 400) {
    return {
      matched: false,
      error: "Route condition exceeds max length."
    };
  }

  const forbidden = FORBIDDEN_ROUTE_TOKENS.find((token) => trimmed.includes(token));
  if (forbidden) {
    return {
      matched: false,
      error: `Route condition contains forbidden token: ${forbidden}`
    };
  }

  try {
    const fn = new Function(
      "ctx",
      `"use strict"; const { runId, workflowId, userId, variables, steps, lastOutput } = ctx; return (${trimmed});`
    ) as (ctx: Record<string, unknown>) => unknown;
    const output = fn(context);
    return {
      matched: Boolean(output),
      error: null as string | null
    };
  } catch (error) {
    return {
      matched: false,
      error: error instanceof Error ? error.message : "Failed to evaluate route condition."
    };
  }
}
