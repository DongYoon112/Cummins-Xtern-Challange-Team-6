import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

type SettingsPayload = {
  teamId: string;
  defaultProvider: "openai" | "anthropic" | "gemini";
  defaultModel: string;
  keyPreviews: Record<"openai" | "anthropic" | "gemini", string>;
  hasKeys: Record<"openai" | "anthropic" | "gemini", boolean>;
  updatedAt: string;
};

export function SettingsPage() {
  const { token } = useAuth();
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [provider, setProvider] = useState<"openai" | "anthropic" | "gemini">("openai");
  const [model, setModel] = useState("gpt-4.1-mini");
  const [keys, setKeys] = useState<Record<"openai" | "anthropic" | "gemini", string>>({
    openai: "",
    anthropic: "",
    gemini: ""
  });
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadSettings() {
    const payload = await apiFetch<SettingsPayload>("/settings", {}, token ?? undefined);
    setSettings(payload);
    setProvider(payload.defaultProvider);
    setModel(payload.defaultModel);
  }

  useEffect(() => {
    if (!token) {
      return;
    }

    loadSettings().catch((err) => setError(err instanceof Error ? err.message : "Failed to load settings"));
  }, [token]);

  async function saveKey(target: "openai" | "anthropic" | "gemini") {
    setStatus(null);
    setError(null);

    try {
      await apiFetch(
        "/settings/key",
        {
          method: "POST",
          body: JSON.stringify({ provider: target, key: keys[target] })
        },
        token ?? undefined
      );
      setStatus(`${target} key saved (encrypted server-side).`);
      setKeys((current) => ({ ...current, [target]: "" }));
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save key");
    }
  }

  async function saveDefaults() {
    setStatus(null);
    setError(null);

    try {
      await apiFetch(
        "/settings/defaults",
        {
          method: "POST",
          body: JSON.stringify({ provider, model })
        },
        token ?? undefined
      );
      setStatus("Default provider/model updated.");
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save defaults");
    }
  }

  async function testConnection() {
    setStatus(null);
    setError(null);

    try {
      const payload = await apiFetch<{ ok: boolean; mockMode: boolean; message: string }>(
        "/settings/test",
        {
          method: "POST",
          body: JSON.stringify({ provider, model })
        },
        token ?? undefined
      );

      setStatus(`${payload.ok ? "Success" : "Failed"}: ${payload.message}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection test failed");
    }
  }

  if (!settings) {
    return <p className="text-sm text-slate-500">Loading settings...</p>;
  }

  return (
    <section className="space-y-4 rounded border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold">Provider Settings</h2>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <div className="mb-1 text-slate-700">Default provider</div>
          <select
            className="w-full rounded border border-slate-300 px-2 py-1"
            onChange={(event) => setProvider(event.target.value as "openai" | "anthropic" | "gemini")}
            value={provider}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Claude (Anthropic)</option>
            <option value="gemini">Gemini (Google)</option>
          </select>
        </label>

        <label className="text-sm">
          <div className="mb-1 text-slate-700">Default model</div>
          <input
            className="w-full rounded border border-slate-300 px-2 py-1"
            onChange={(event) => setModel(event.target.value)}
            value={model}
          />
        </label>
      </div>

      <div className="flex gap-2">
        <button className="rounded bg-accent px-3 py-1 text-sm text-white" onClick={saveDefaults} type="button">
          Save Defaults
        </button>
        <button className="rounded border border-slate-300 px-3 py-1 text-sm" onClick={testConnection} type="button">
          Test Connection
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {(["openai", "anthropic", "gemini"] as const).map((name) => (
          <div className="rounded border border-slate-200 p-3" key={name}>
            <div className="text-sm font-medium capitalize">{name}</div>
            <div className="mt-1 text-xs text-slate-500">
              Stored key: {settings.keyPreviews[name] || "(none)"}
            </div>
            <input
              className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              onChange={(event) => {
                setKeys((current) => ({ ...current, [name]: event.target.value }));
              }}
              placeholder={`Paste ${name} key`}
              type="password"
              value={keys[name]}
            />
            <button
              className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs"
              onClick={() => saveKey(name)}
              type="button"
            >
              Save {name} key
            </button>
          </div>
        ))}
      </div>

      {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
      {error ? <p className="text-sm text-warn">{error}</p> : null}
    </section>
  );
}