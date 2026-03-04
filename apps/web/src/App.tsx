import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { AppLayout } from "./components/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { RunsPage } from "./pages/RunsPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { Role } from "./lib/types";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="p-8 text-sm text-slate-500">Loading session...</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function RequireRole({
  roles,
  children
}: {
  roles: Role[];
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) {
    return <div className="rounded border border-warn/30 bg-rose-50 p-4 text-sm text-warn">Not authorized.</div>;
  }

  return <>{children}</>;
}

function Shell() {
  return (
    <RequireAuth>
      <AppLayout>
        <Routes>
          <Route
            path="/workflows"
            element={
              <RequireRole roles={["BUILDER", "OPERATOR"]}>
                <WorkflowsPage />
              </RequireRole>
            }
          />
          <Route path="/runs" element={<RunsPage />} />
          <Route
            path="/approvals"
            element={
              <RequireRole roles={["APPROVER"]}>
                <ApprovalsPage />
              </RequireRole>
            }
          />
          <Route
            path="/audit"
            element={
              <RequireRole roles={["AUDITOR", "BUILDER", "APPROVER"]}>
                <AuditLogPage />
              </RequireRole>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireRole roles={["BUILDER"]}>
                <SettingsPage />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate replace to="/workflows" />} />
        </Routes>
      </AppLayout>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={<Shell />} />
      </Routes>
    </AuthProvider>
  );
}