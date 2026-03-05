import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { AppLayout } from "./components/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { RunsPage } from "./pages/RunsPage";
import { OperationsPage } from "./pages/OperationsPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { SettingsPage } from "./pages/SettingsPage";
import { DocsPage } from "./pages/DocsPage";
import { WarRoomPage } from "./pages/WarRoomPage";
import { HomePage } from "./pages/HomePage";
import { ProcurementPage } from "./pages/ProcurementPage";
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
  if (!user || (user.role !== "ADMIN" && !roles.includes(user.role))) {
    return <div className="rounded border border-warn/30 bg-rose-50 p-4 text-sm text-warn">Not authorized.</div>;
  }

  return <>{children}</>;
}

function Shell() {
  return (
    <RequireAuth>
      <AppLayout>
        <Routes>
          <Route path="/home" element={<HomePage />} />
          <Route
            path="/workflows"
            element={
              <RequireRole roles={["BUILDER", "OPERATOR", "ADMIN"]}>
                <WorkflowsPage />
              </RequireRole>
            }
          />
          <Route path="/operations" element={<OperationsPage />} />
          <Route path="/procurement" element={<ProcurementPage />} />
          <Route path="/run" element={<RunsPage />} />
          <Route path="/runs" element={<Navigate replace to="/run" />} />
          <Route path="/war-room" element={<WarRoomPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route
            path="/approvals"
            element={
              <RequireRole roles={["APPROVER", "ADMIN"]}>
                <ApprovalsPage />
              </RequireRole>
            }
          />
          <Route
            path="/audit"
            element={
              <RequireRole roles={["AUDITOR", "BUILDER", "APPROVER", "ADMIN"]}>
                <AuditLogPage />
              </RequireRole>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireRole roles={["BUILDER", "ADMIN"]}>
                <SettingsPage />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate replace to="/home" />} />
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
