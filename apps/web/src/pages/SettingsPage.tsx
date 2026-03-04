import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

type ProviderKey = "openai" | "anthropic" | "gemini";
type StorageMode = "server" | "local";

type SettingsPayload = {
  teamId: string;
  defaultProvider: ProviderKey;
  defaultModel: string;
  keyPreviews: Record<ProviderKey, string>;
  hasKeys: Record<ProviderKey, boolean>;
  updatedAt: string;
};

const LOCAL_KEYS_STORAGE = "agentfoundry.localProviderKeys";
const LOCAL_MODE_STORAGE = "agentfoundry.settingsStorageMode";

function loadLocalKeys() {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEYS_STORAGE);
    if (!raw) {
      return { openai: "", anthropic: "", gemini: "" } satisfies Record<ProviderKey, string>;
    }
    const parsed = JSON.parse(raw) as Record<ProviderKey, string>;
    return {
      openai: parsed.openai ?? "",
      anthropic: parsed.anthropic ?? "",
      gemini: parsed.gemini ?? ""
    };
  } catch {
    return { openai: "", anthropic: "", gemini: "" };
  }
}

export function SettingsPage() {
  const { token } = useAuth();
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [provider, setProvider] = useState<ProviderKey>("openai");
  const [model, setModel] = useState("gpt-4.1-mini");
  const [keys, setKeys] = useState<Record<ProviderKey, string>>({
    openai: "",
    anthropic: "",
    gemini: ""
  });
  const [localKeys, setLocalKeys] = useState<Record<ProviderKey, string>>(() =>
    typeof window === "undefined" ? { openai: "", anthropic: "", gemini: "" } : loadLocalKeys()
  );
  const [storageMode, setStorageMode] = useState<StorageMode>(() => {
    if (typeof window === "undefined") {
      return "server";
    }
    const mode = window.localStorage.getItem(LOCAL_MODE_STORAGE);
    return mode === "local" ? "local" : "server";
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(LOCAL_MODE_STORAGE, storageMode);
  }, [storageMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(LOCAL_KEYS_STORAGE, JSON.stringify(localKeys));
  }, [localKeys]);

  async function saveKey(target: ProviderKey) {
    setStatus(null);
    setError(null);

    if (storageMode === "local") {
      setLocalKeys((current) => ({ ...current, [target]: keys[target] }));
      setKeys((current) => ({ ...current, [target]: "" }));
      setStatus(`${target} key saved to localStorage (dev mode).`);
      return;
    }

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

    if (storageMode === "local") {
      setStatus("Local mode stores keys only in browser. Server connection test uses server-stored keys.");
      return;
    }

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Provider Settings</h2>
        <div className="flex items-center gap-2 rounded border border-slate-200 px-2 py-1 text-xs">
          <span className="text-slate-600">Storage mode:</span>
          <button
            className={`rounded px-2 py-0.5 ${storageMode === "server" ? "bg-accent text-white" : "bg-slate-100"}`}
            onClick={() => setStorageMode("server")}
            type="button"
          >
            Server Encrypted
          </button>
          <button
            className={`rounded px-2 py-0.5 ${storageMode === "local" ? "bg-accent text-white" : "bg-slate-100"}`}
            onClick={() => setStorageMode("local")}
            type="button"
          >
            Local Dev
          </button>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Server mode uses `MASTER_KEY` encryption in API. Local mode stores keys in browser localStorage for quick dev.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <div className="mb-1 text-slate-700">Default provider</div>
          <select
            className="w-full rounded border border-slate-300 px-2 py-1"
            onChange={(event) => setProvider(event.target.value as ProviderKey)}
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
              {storageMode === "server"
                ? `Stored key: ${settings.keyPreviews[name] || "(none)"}`
                : `Local key: ${localKeys[name] ? "******** (present)" : "(none)"}`}
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
