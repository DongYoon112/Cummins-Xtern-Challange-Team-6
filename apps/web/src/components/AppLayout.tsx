import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Role, RunState } from "../lib/types";
import orangeLanternLogo from "../assets/orange-lantern-logo.svg";

type TabConfig = {
  to: string;
  label: string;
  summary: string;
  roles: Role[];
};

type ApprovalNotification = {
  id: string;
  stepName: string;
  workflowId: string;
  requestedBy?: string;
  requestedAt: string;
};

type NotificationItem = {
  id: string;
  title: string;
  detail: string;
  ts: string;
  route: string;
  tone: "info" | "warn";
};

const tabs: TabConfig[] = [
  {
    to: "/home",
    label: "Home",
    summary: "Overall dashboard with workflow KPIs, activity, and inventory.",
    roles: ["BUILDER", "OPERATOR", "APPROVER", "AUDITOR", "ADMIN"]
  },
  {
    to: "/workflows",
    label: "Workflows",
    summary: "Create, edit, and publish workflow graphs with AI-assisted tools.",
    roles: ["BUILDER", "OPERATOR", "APPROVER", "AUDITOR", "ADMIN"]
  },
  {
    to: "/operations",
    label: "Operations",
    summary: "Monitor active runs and operational health across the platform.",
    roles: ["BUILDER", "OPERATOR", "APPROVER", "AUDITOR", "ADMIN"]
  },
  {
    to: "/procurement",
    label: "Procurement",
    summary: "Run procurement scan, manage PO approvals, submit to vendor, and advance fulfillment status.",
    roles: ["BUILDER", "OPERATOR", "APPROVER", "ADMIN"]
  },
  {
    to: "/run",
    label: "Run",
    summary: "Start workflow runs and inspect step-by-step execution output.",
    roles: ["BUILDER", "OPERATOR", "APPROVER", "AUDITOR", "ADMIN"]
  },
  {
    to: "/docs",
    label: "Docs",
    summary: "Reference guides and implementation notes for teams.",
    roles: ["ADMIN", "BUILDER", "OPERATOR", "APPROVER", "AUDITOR"]
  },
  {
    to: "/approvals",
    label: "Approvals",
    summary: "Review pending requests and approve or reject guarded actions.",
    roles: ["APPROVER", "ADMIN"]
  },
  {
    to: "/audit",
    label: "Audit Log",
    summary: "Track governance events, decisions, and traceability records.",
    roles: ["AUDITOR", "BUILDER", "APPROVER", "ADMIN"]
  },
  {
    to: "/settings",
    label: "Settings",
    summary: "Configure providers, keys, and team-level platform defaults.",
    roles: ["BUILDER", "ADMIN"]
  }
];

function formatWhen(ts: string) {
  const value = Date.parse(ts);
  if (Number.isNaN(value)) {
    return ts;
  }
  return new Date(value).toLocaleString();
}

function describeRequester(requestedBy?: string) {
  if (!requestedBy) {
    return "a team member";
  }
  const normalized = requestedBy.toLowerCase();
  if (normalized.includes("builder") || normalized.includes("developer")) {
    return "developer";
  }
  return requestedBy.replace(/^u-/, "");
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, token, logout } = useAuth();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [runs, setRuns] = useState<RunState[]>([]);
  const [approvals, setApprovals] = useState<ApprovalNotification[]>([]);

  useEffect(() => {
    if (!token || !user) {
      return;
    }

    let cancelled = false;
    const canSeeApprovals = user.role === "ADMIN" || user.role === "APPROVER";

    const load = async () => {
      try {
        const runsPayload = await apiFetch<{ runs: RunState[] }>("/runs", {}, token);
        if (!cancelled) {
          setRuns(runsPayload.runs ?? []);
        }
      } catch {
        if (!cancelled) {
          setRuns([]);
        }
      }

      if (!canSeeApprovals) {
        if (!cancelled) {
          setApprovals([]);
        }
        return;
      }

      try {
        const approvalsPayload = await apiFetch<{ approvals: ApprovalNotification[] }>("/approvals", {}, token);
        if (!cancelled) {
          setApprovals(approvalsPayload.approvals ?? []);
        }
      } catch {
        if (!cancelled) {
          setApprovals([]);
        }
      }
    };

    load().catch(() => undefined);
    const interval = window.setInterval(() => {
      load().catch(() => undefined);
    }, 7000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [token, user]);

  const notifications = useMemo<NotificationItem[]>(() => {
    const approvalNotifications = approvals.map((approval) => ({
      id: `approval-${approval.id}`,
      title: `Approval needed: ${approval.stepName}`,
      detail: `Admin alert: approval request from ${describeRequester(approval.requestedBy)} on workflow ${approval.workflowId}.`,
      ts: approval.requestedAt,
      route: "/approvals",
      tone: "warn" as const
    }));

    const runNotifications = runs
      .filter((run) => run.status === "WAITING_APPROVAL" || run.status === "FAILED" || run.status === "COMPLETED")
      .slice(0, 8)
      .map((run) => ({
        id: `run-${run.runId}`,
        title:
          run.status === "WAITING_APPROVAL"
            ? `Run waiting approval: ${run.workflowName}`
            : run.status === "FAILED"
              ? `Run failed: ${run.workflowName}`
              : `Run completed: ${run.workflowName}`,
        detail: `Run ${run.runId} is currently ${run.status.toLowerCase()}.`,
        ts: run.updatedAt,
        route: `/run?runId=${encodeURIComponent(run.runId)}`,
        tone: run.status === "FAILED" ? ("warn" as const) : ("info" as const)
      }));

    return [...approvalNotifications, ...runNotifications]
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, 10);
  }, [approvals, runs]);

  return (
    <div className="min-h-screen bg-slate-50 text-ink md:flex">
      <aside className="border-b border-slate-200 bg-slate-950 text-slate-100 md:min-h-screen md:w-64 md:border-b-0 md:border-r md:border-slate-800">
        <div className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <img alt="Orange Lantern logo" className="h-9 w-9 shrink-0" src={orangeLanternLogo} />
              <div>
                <h1 className="text-lg font-semibold leading-tight tracking-tight text-white">Orange Lantern</h1>
                <p className="text-xs text-slate-400">Multi-agent workflow governance</p>
              </div>
            </div>
            <button
              className="relative rounded border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
              onClick={() => setNotificationsOpen((current) => !current)}
              type="button"
            >
              Alerts
              {notifications.length > 0 ? (
                <span className="absolute -right-1 -top-1 rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold text-white">
                  {notifications.length}
                </span>
              ) : null}
            </button>
          </div>
          {notificationsOpen ? (
            <div className="mt-3 max-h-60 space-y-2 overflow-auto rounded border border-slate-800 bg-slate-900/70 p-2">
              {notifications.length === 0 ? (
                <p className="text-xs text-slate-400">No notifications right now.</p>
              ) : (
                notifications.map((item) => (
                  <button
                    className={`rounded border p-2 ${
                      item.tone === "warn"
                        ? "border-rose-700 bg-rose-950/40 hover:bg-rose-900/50"
                        : "border-slate-700 bg-slate-800/70 hover:bg-slate-700/80"
                    }`}
                    key={item.id}
                    onClick={() => {
                      navigate(item.route);
                      setNotificationsOpen(false);
                    }}
                    type="button"
                  >
                    <div className="text-left text-xs font-semibold text-white">{item.title}</div>
                    <div className="mt-1 text-left text-[11px] text-slate-300">{item.detail}</div>
                    <div className="mt-1 text-left text-[10px] text-slate-500">{formatWhen(item.ts)}</div>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
        <nav className="px-3 pb-3">
          {tabs.map((tab) => {
            const allowed = user ? user.role === "ADMIN" || tab.roles.includes(user.role) : false;
            const active = location.pathname.startsWith(tab.to);
            const rolesLabel = tab.roles.join(", ");

            if (!allowed) {
              return (
                <div className="group relative mb-1" key={tab.to}>
                  <span className="block rounded border border-dashed border-slate-700 px-3 py-2 text-sm text-slate-500">
                    {tab.label}
                  </span>
                  <div className="pointer-events-none absolute left-full top-1/2 z-40 hidden w-64 -translate-y-1/2 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 shadow-xl group-hover:block">
                    <div className="font-semibold text-white">{tab.label}</div>
                    <div className="mt-1 text-slate-300">{tab.summary}</div>
                    <div className="mt-2 text-rose-300">Restricted: accessible only to roles {rolesLabel}.</div>
                  </div>
                </div>
              );
            }

            return (
              <div className="group relative mb-1" key={tab.to}>
                <Link
                  className={`block rounded px-3 py-2 text-sm ${
                    active ? "bg-orange-600 text-white" : "text-slate-200 hover:bg-slate-800"
                  }`}
                  to={tab.to}
                >
                  {tab.label}
                </Link>
                <div className="pointer-events-none absolute left-full top-1/2 z-40 hidden w-64 -translate-y-1/2 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 shadow-xl group-hover:block">
                  <div className="font-semibold text-white">{tab.label}</div>
                  <div className="mt-1 text-slate-300">{tab.summary}</div>
                  <div className="mt-2 text-slate-400">Access: {rolesLabel}</div>
                </div>
              </div>
            );
          })}
        </nav>
        <div className="border-t border-slate-800 p-4">
          <div className="text-sm font-medium text-white">{user?.username}</div>
          <div className="text-xs text-slate-400">Role: {user?.role}</div>
          <button
            className="mt-2 rounded bg-slate-800 px-2 py-1 text-xs text-white hover:bg-slate-700"
            onClick={logout}
            type="button"
          >
            Logout
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-4 md:px-6">{children}</main>
    </div>
  );
}
