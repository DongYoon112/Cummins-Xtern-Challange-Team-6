import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import type { Role } from "../lib/types";

type TabConfig = {
  to: string;
  label: string;
  roles: Role[];
};

const tabs: TabConfig[] = [
  { to: "/workflows", label: "Workflows", roles: ["BUILDER", "OPERATOR"] },
  { to: "/runs", label: "Runs", roles: ["BUILDER", "OPERATOR", "APPROVER", "AUDITOR"] },
  { to: "/approvals", label: "Approvals", roles: ["APPROVER"] },
  { to: "/audit", label: "Audit Log", roles: ["AUDITOR", "BUILDER", "APPROVER"] },
  { to: "/settings", label: "Settings", roles: ["BUILDER"] }
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen text-ink">
      <header className="border-b border-slate-200 bg-panel/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-accentDark">AgentFoundry</h1>
            <p className="text-xs text-slate-600">Multi-agent workflow governance</p>
          </div>
          <div className="text-right">
            <div className="text-sm font-medium">{user?.username}</div>
            <div className="text-xs text-slate-500">Role: {user?.role}</div>
            <button
              className="mt-1 rounded bg-slate-800 px-2 py-1 text-xs text-white"
              onClick={logout}
              type="button"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <nav className="border-b border-slate-200 bg-white/70">
        <div className="mx-auto flex max-w-7xl gap-2 px-4 py-2">
          {tabs.map((tab) => {
            const allowed = user ? tab.roles.includes(user.role) : false;
            const active = location.pathname.startsWith(tab.to);
            if (!allowed) {
              return (
                <span
                  key={tab.to}
                  className="rounded border border-dashed border-slate-300 px-3 py-1 text-sm text-slate-400"
                >
                  {tab.label}
                </span>
              );
            }

            return (
              <Link
                key={tab.to}
                className={`rounded px-3 py-1 text-sm ${
                  active ? "bg-accent text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
                to={tab.to}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-4 py-4">{children}</main>
    </div>
  );
}