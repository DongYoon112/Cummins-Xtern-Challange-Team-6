import test from "node:test";
import assert from "node:assert/strict";
import { db, initApiDb } from "./db";

test("procurement tables exist", () => {
  initApiDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('purchase_orders', 'mock_vendor_orders')")
    .all() as Array<{ name: string }>;
  const names = new Set(tables.map((row) => row.name));
  assert.equal(names.has("purchase_orders"), true);
  assert.equal(names.has("mock_vendor_orders"), true);
});
