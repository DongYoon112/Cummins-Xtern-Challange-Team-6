import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { Provider } from "@agentfoundry/shared";

export type LlmEnvelope = {
  confidence: number;
  rationale: string;
  summary: string;
};

const SYSTEM_PROMPT =
  "Return strict JSON only with keys: confidence (0..1 number), rationale (string), summary (string).";

function parseEnvelope(raw: string): LlmEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LlmEnvelope>;
    if (
      typeof parsed.confidence === "number" &&
      typeof parsed.rationale === "string" &&
      typeof parsed.summary === "string"
    ) {
      return {
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        rationale: parsed.rationale,
        summary: parsed.summary
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function askProviderForJson(params: {
  provider: Provider;
  model: string;
  apiKey: string;
  prompt: string;
}): Promise<LlmEnvelope | null> {
  const { provider, model, apiKey, prompt } = params;

  try {
    if (provider === "openai") {
      const client = new OpenAI({ apiKey });
      const completion = await client.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ]
      });

      const text = completion.choices[0]?.message?.content;
      return text ? parseEnvelope(text) : null;
    }

    if (provider === "anthropic") {
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model,
        max_tokens: 200,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }]
      });

      const block = response.content.find((entry) => entry.type === "text");
      return block?.type === "text" ? parseEnvelope(block.text) : null;
    }

    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
      model,
      contents: `${SYSTEM_PROMPT}\n${prompt}`,
      config: {
        temperature: 0,
        responseMimeType: "application/json"
      }
    });

    return response.text ? parseEnvelope(response.text) : null;
  } catch {
    return null;
  }
}

export async function testProviderConnection(params: {
  provider: Provider;
  model: string;
  apiKey?: string;
}) {
  const { provider, model, apiKey } = params;
  if (!apiKey) {
    return {
      ok: true,
      mockMode: true,
      message: "No API key configured for this provider. Mock mode is active."
    };
  }

  const envelope = await askProviderForJson({
    provider,
    model,
    apiKey,
    prompt: "Respond that the connection test succeeded."
  });

  if (!envelope) {
    return {
      ok: false,
      mockMode: false,
      message: "Provider request failed or did not return valid JSON envelope."
    };
  }

  return {
    ok: true,
    mockMode: false,
    message: "Connection successful",
    sample: envelope
  };
}