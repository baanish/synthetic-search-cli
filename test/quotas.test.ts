import assert from "node:assert/strict";
import test from "node:test";

import { saveApiKey } from "../src/lib/auth.ts";
import { runCliCapture, createTempConfigDir, removeTempConfigDir } from "./helpers.ts";

type QuotasPayload = {
  buckets: Array<{
    key: string;
    label: string;
    limit: number;
    requestsUsed: number;
    remaining: number;
    renewsAt: string | null;
  }>;
};

test("quotas reports the search (hourly) bucket first, then subscription", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  // The real /v2/quotas response shape: search usage is the hourly bucket, which
  // is the quota that actually constrains searches.
  const body = JSON.stringify({
    subscription: { limit: 750, requests: 0, renewsAt: "2026-06-26T00:55:20.529Z" },
    search: { hourly: { limit: 250, requests: 26, renewsAt: "2026-06-25T21:00:02.530Z" } },
    weeklyTokenLimit: { percentRemaining: 77.04 },
    rollingFiveHourLimit: { remaining: 750, max: 750 },
  });

  const fetchImpl: typeof fetch = async () => new Response(body, { status: 200 });

  const textResult = await runCliCapture(["quotas"], { configDir, env: {}, fetchImpl });
  assert.equal(textResult.exitCode, 0);
  assert.match(textResult.stdout, /Search \(hourly\):/);
  assert.match(textResult.stdout, /Limit: 250/);
  assert.match(textResult.stdout, /Requests used: 26/);
  assert.match(textResult.stdout, /Remaining: 224/);
  assert.match(textResult.stdout, /Subscription:/);
  assert.match(textResult.stdout, /Limit: 750/);
  // Search section must come before Subscription section.
  assert.ok(textResult.stdout.indexOf("Search (hourly)") < textResult.stdout.indexOf("Subscription"));

  const jsonResult = await runCliCapture(["quotas", "--json"], { configDir, env: {}, fetchImpl });
  assert.equal(jsonResult.exitCode, 0);
  const payload = JSON.parse(jsonResult.stdout) as QuotasPayload;
  assert.deepEqual(payload, {
    buckets: [
      {
        key: "search",
        label: "Search (hourly)",
        limit: 250,
        requestsUsed: 26,
        remaining: 224,
        renewsAt: "2026-06-25T21:00:02.530Z",
      },
      {
        key: "subscription",
        label: "Subscription",
        limit: 750,
        requestsUsed: 0,
        remaining: 750,
        renewsAt: "2026-06-26T00:55:20.529Z",
      },
    ],
  });
});

test("quotas renders the documented subscription-only shape", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  // Exactly the example from the official docs.
  const body = JSON.stringify({
    subscription: { limit: 135, requests: 12, renewsAt: "2025-09-21T14:36:14.288Z" },
  });

  const jsonResult = await runCliCapture(["quotas", "--json"], {
    configDir,
    env: {},
    fetchImpl: async () => new Response(body, { status: 200 }),
  });

  assert.equal(jsonResult.exitCode, 0);
  const payload = JSON.parse(jsonResult.stdout) as QuotasPayload;
  assert.deepEqual(payload, {
    buckets: [
      {
        key: "subscription",
        label: "Subscription",
        limit: 135,
        requestsUsed: 12,
        remaining: 123,
        renewsAt: "2025-09-21T14:36:14.288Z",
      },
    ],
  });
});

test("invalid quota shape surfaces a clear error and non-zero exit", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ whatever: true }), { status: 200 });

  const result = await runCliCapture(["quotas", "--json"], { configDir, env: {}, fetchImpl });

  assert.equal(result.exitCode, 1);
  const errorPayload = JSON.parse(result.stderr) as { error: string };
  assert.match(errorPayload.error, /valid limit, requests used, and remaining/);
});
