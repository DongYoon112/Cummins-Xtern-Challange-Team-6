import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

export function WarRoomLoadingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const workflowId = searchParams.get("workflowId") ?? "";
  const workflowVersionRaw = searchParams.get("workflowVersion");
  const workflowVersion = workflowVersionRaw ? Number(workflowVersionRaw) : undefined;

  useEffect(() => {
    if (!token || started.current) {
      return;
    }
    started.current = true;

    if (!workflowId) {
      setError("Missing workflow ID.");
      return;
    }

    apiFetch<{ runId: string }>(
      "/api/war-room/start",
      {
        method: "POST",
        body: JSON.stringify({
          workflowId,
          workflowVersion: Number.isFinite(workflowVersion) ? workflowVersion : undefined
        })
      },
      token
    )
      .then((payload) => {
        navigate(`/war-room?runId=${encodeURIComponent(payload.runId)}`, { replace: true });
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to launch War Room run.");
      });
  }, [navigate, token, workflowId, workflowVersion]);

  return (
    <div className="mx-auto max-w-2xl rounded border border-slate-200 bg-white p-8">
      <div className="inline-flex items-center gap-2 rounded border border-cyan-300 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-800">
        <span className="warroom-pulse h-2 w-2 rounded-full bg-cyan-500" />
        Launching War Room
      </div>
      <h1 className="mt-3 text-2xl font-semibold text-slate-900">Preparing Live Run</h1>
      <p className="mt-2 text-sm text-slate-600">
        Creating run context and opening live stream board. This usually takes a few seconds.
      </p>
      <div className="mt-5 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-cyan-500" />
      </div>
      {error ? (
        <div className="mt-4 rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
          <div className="mt-2">
            <button
              className="rounded border border-rose-300 bg-white px-2 py-1 text-xs font-semibold text-rose-800"
              onClick={() => navigate("/workflows")}
              type="button"
            >
              Back to Builder
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

