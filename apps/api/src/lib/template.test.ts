import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRouteCondition, resolveTemplates, setValueByPath } from "./template";

test("resolveTemplates replaces nested tokens and keeps unresolved tokens", () => {
  const context = {
    variables: {
      orderId: "ORD-1001"
    },
    steps: {
      s1: {
        output: {
          database: {
            rows: [{ qty: 42 }]
          }
        }
      }
    }
  };

  const resolved = resolveTemplates(
    {
      prompt: "Order {{variables.orderId}} qty {{steps.s1.output.database.rows[0].qty}} missing {{variables.nope}}"
    },
    context
  );

  assert.equal(
    resolved.value.prompt,
    "Order ORD-1001 qty 42 missing {{variables.nope}}"
  );
  assert.equal(resolved.warnings.length, 1);
});

test("evaluateRouteCondition supports context fields", () => {
  const context = {
    variables: {
      riskScore: 0.8
    }
  };

  const passed = evaluateRouteCondition("variables.riskScore > 0.7", context);
  const failed = evaluateRouteCondition("variables.riskScore < 0.7", context);

  assert.equal(passed.matched, true);
  assert.equal(failed.matched, false);
});

test("setValueByPath writes deeply nested values", () => {
  const root: Record<string, unknown> = {};
  setValueByPath(root, "variables.customer.profile.name", "Acme");
  assert.equal((root.variables as any).customer.profile.name, "Acme");
});
