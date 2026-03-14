import assert from "node:assert/strict";
import test from "node:test";

import { saveApiKey } from "../src/lib/auth.ts";
import { runCliCapture, createTempConfigDir, removeTempConfigDir } from "./helpers.ts";

test("quotas renders readable values and --json returns structured data", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("config-key", { configDir });

  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        limit: 100,
        requests_used: 40,
        remaining: 60,
        renews_at: "2026-04-01T00:00:00.000Z",
      }),
      { status: 200 },
    );

  const textResult = await runCliCapture(["quotas"], {
    configDir,
    env: {},
    fetchImpl,
  });

  assert.equal(textResult.exitCode, 0);
  assert.match(textResult.stdout, /Limit: 100/);
  assert.match(textResult.stdout, /Requests used: 40/);
  assert.match(textResult.stdout, /Remaining: 60/);
  assert.match(textResult.stdout, /Renews at: 2026-04-01T00:00:00.000Z/);

  const jsonResult = await runCliCapture(["quotas", "--json"], {
    configDir,
    env: {},
    fetchImpl,
  });

  assert.equal(jsonResult.exitCode, 0);
  const payload = JSON.parse(jsonResult.stdout) as {
    limit: number;
    requestsUsed: number;
    remaining: number;
    renewsAt: string | null;
  };

  assert.deepEqual(payload, {
    limit: 100,
    requestsUsed: 40,
    remaining: 60,
    renewsAt: "2026-04-01T00:00:00.000Z",
  });
});

test("invalid quota shape surfaces a clear error and non-zero exit", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("config-key", { configDir });

  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        whatever: true,
      }),
      { status: 200 },
    );

  const result = await runCliCapture(["quotas", "--json"], {
    configDir,
    env: {},
    fetchImpl,
  });

  assert.equal(result.exitCode, 1);
  const errorPayload = JSON.parse(result.stderr) as { error: string };
  assert.match(errorPayload.error, /valid limit, requests used, and remaining/);
});
