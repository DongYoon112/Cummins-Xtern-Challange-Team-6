import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type McpServerName = "registry" | "store" | "audit";

const endpoints: Record<McpServerName, string> = {
  registry: process.env.REGISTRY_MCP_URL ?? `http://localhost:${process.env.MCP_REGISTRY_PORT ?? 4101}/mcp`,
  store: process.env.STORE_MCP_URL ?? `http://localhost:${process.env.MCP_STORE_PORT ?? 4102}/mcp`,
  audit: process.env.AUDIT_MCP_URL ?? `http://localhost:${process.env.MCP_AUDIT_PORT ?? 4103}/mcp`
};

function unpackResult(result: unknown) {
  const maybe = result as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };

  if (maybe.structuredContent !== undefined) {
    return maybe.structuredContent;
  }

  const text = maybe.content?.find((entry) => entry.type === "text")?.text;
  if (!text) {
    return result;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function extractMcpError(result: unknown): string | null {
  const maybe = result as {
    isError?: unknown;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (maybe.isError !== true) {
    return null;
  }

  if (maybe.structuredContent && typeof maybe.structuredContent === "object") {
    const structured = maybe.structuredContent as { error?: unknown; message?: unknown };
    if (typeof structured.error === "string" && structured.error.trim()) {
      return structured.error.trim();
    }
    if (typeof structured.message === "string" && structured.message.trim()) {
      return structured.message.trim();
    }
  }

  const text = maybe.content?.find((entry) => entry.type === "text")?.text;
  if (typeof text === "string" && text.trim()) {
    return text.trim();
  }

  return "MCP tool call failed";
}

export async function callMcpTool<TArgs extends Record<string, unknown>, TResult>(
  serverName: McpServerName,
  toolName: string,
  args: TArgs
): Promise<TResult> {
  const client = new Client({ name: "agentfoundry-api", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoints[serverName]));

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: toolName,
      arguments: args
    });
    const mcpError = extractMcpError(result);
    if (mcpError) {
      throw new Error(mcpError);
    }
    return unpackResult(result) as TResult;
  } finally {
    const maybeClient = client as unknown as { close?: () => Promise<void> | void };
    const maybeTransport = transport as unknown as { close?: () => Promise<void> | void };

    await maybeClient.close?.();
    await maybeTransport.close?.();
  }
}

export { endpoints as mcpEndpoints };
