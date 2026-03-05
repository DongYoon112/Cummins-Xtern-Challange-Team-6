import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

type PurchaseOrder = {
  id: string;
  vendorId: string;
  partId: string;
  qty: number;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function ProcurementPage() {
  const { token } = useAuth();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadOrders() {
    const payload = await apiFetch<{ purchaseOrders: PurchaseOrder[] }>("/procurement/po", {}, token ?? undefined);
    setOrders(payload.purchaseOrders ?? []);
  }

  async function runScan() {
    setStatus(null);
    setError(null);
    try {
      const payload = await apiFetch<{ createdDraftPos: Array<{ id: string }> }>(
        "/procurement/scan",
        {
          method: "POST",
          body: JSON.stringify({})
        },
        token ?? undefined
      );
      setStatus(`Created ${payload.createdDraftPos.length} draft POs.`);
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run scan");
    }
  }

  async function postAction(path: string, successMessage: string) {
    setStatus(null);
    setError(null);
    try {
      await apiFetch(path, { method: "POST", body: JSON.stringify({}) }, token ?? undefined);
      setStatus(successMessage);
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to execute action");
    }
  }

  useEffect(() => {
    if (!token) {
      return;
    }
    loadOrders().catch((err) => setError(err instanceof Error ? err.message : "Failed to load POs"));
  }, [token]);

  return (
    <section className="space-y-4 rounded border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Procurement</h2>
        <button className="rounded bg-slate-900 px-3 py-1 text-sm text-white" onClick={runScan} type="button">
          Run Agent Scan
        </button>
      </div>

      <div className="space-y-2">
        {orders.map((po) => (
          <div className="rounded border border-slate-200 p-3" key={po.id}>
            <div className="text-sm font-medium">
              {po.partId} x {po.qty} ({po.vendorId})
            </div>
            <div className="text-xs text-slate-500">
              {po.id} | Status: {po.status}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className="rounded border border-slate-300 px-2 py-1 text-xs"
                onClick={() => postAction(`/procurement/po/${encodeURIComponent(po.id)}/request-approval`, "Approval requested")}
                type="button"
              >
                Request Approval
              </button>
              <button
                className="rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-700"
                onClick={() => postAction(`/procurement/po/${encodeURIComponent(po.id)}/approve`, "PO approved")}
                type="button"
              >
                Approve
              </button>
              <button
                className="rounded border border-rose-300 px-2 py-1 text-xs text-rose-700"
                onClick={() => postAction(`/procurement/po/${encodeURIComponent(po.id)}/reject`, "PO rejected")}
                type="button"
              >
                Reject
              </button>
              <button
                className="rounded border border-slate-300 px-2 py-1 text-xs"
                onClick={() => postAction(`/procurement/po/${encodeURIComponent(po.id)}/submit-to-vendor`, "Submitted to vendor")}
                type="button"
              >
                Submit to Vendor
              </button>
              <button
                className="rounded border border-slate-300 px-2 py-1 text-xs"
                onClick={() => postAction(`/procurement/po/${encodeURIComponent(po.id)}/advance-status`, "Status advanced")}
                type="button"
              >
                Advance Status
              </button>
            </div>
          </div>
        ))}
        {orders.length === 0 ? <p className="text-sm text-slate-500">No purchase orders yet.</p> : null}
      </div>

      {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
      {error ? <p className="text-sm text-warn">{error}</p> : null}
    </section>
  );
}
