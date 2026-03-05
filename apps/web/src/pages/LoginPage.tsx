import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (user) {
    return <Navigate to="/home" replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-orange-50 via-amber-50 to-stone-50 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-3.5 w-3.5 rounded-full bg-orange-400 shadow-[0_0_18px_5px_rgba(251,146,60,0.9)]"
          />
          <h1 className="text-2xl font-semibold text-accentDark">Orange Lantern</h1>
        </div>
        <p className="mt-1 text-sm text-slate-600">Sign in to run governed multi-agent workflows.</p>

        <form
          className="mt-6 space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setLoading(true);
            setError(null);
            try {
              await login(username, password);
              navigate("/home", { replace: true });
            } catch (err) {
              setError(err instanceof Error ? err.message : "Login failed");
            } finally {
              setLoading(false);
            }
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block text-slate-700">Username</span>
            <input
              className="w-full rounded border border-slate-300 px-3 py-2"
              onChange={(event) => setUsername(event.target.value)}
              value={username}
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-slate-700">Password</span>
            <input
              className="w-full rounded border border-slate-300 px-3 py-2"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>

          {error ? <p className="text-sm text-warn">{error}</p> : null}

          <button
            className="w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accentDark"
            disabled={loading}
            type="submit"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div className="mt-5 rounded bg-slate-50 p-3 text-xs text-slate-600">
          Use your configured account credentials.
        </div>
      </div>
    </div>
  );
}
