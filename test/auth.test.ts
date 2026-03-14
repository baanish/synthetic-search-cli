import assert from "node:assert/strict";
import test from "node:test";

import { getSavedApiKey, resolveCredentials, saveApiKey } from "../src/lib/auth.ts";
import { runCliCapture, createTempConfigDir, removeTempConfigDir } from "./helpers.ts";

const QUOTAS_URL = "https://api.synthetic.new/v2/quotas";

test("auth login saves a valid key after successful validation", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), QUOTAS_URL);

    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer valid-key");

    return new Response(
      JSON.stringify({
        limit: 10,
        requests_used: 1,
        remaining: 9,
        renews_at: "2026-04-01T00:00:00.000Z",
      }),
      { status: 200 },
    );
  };

  const result = await runCliCapture(["auth", "login"], {
    configDir,
    env: {},
    fetchImpl,
    prompts: {
      password: async () => "valid-key",
    },
    stdinIsTTY: true,
    stdoutIsTTY: true,
  });

  assert.equal(result.exitCode, 0);

  const resolved = resolveCredentials({ env: {}, configDir });
  assert.equal(resolved.source, "config");
  assert.equal(resolved.apiKey, "valid-key");
});

test("auth login refuses to save on 401 and 403 validation failures", async (t) => {
  for (const status of [401, 403]) {
    const configDir = await createTempConfigDir();
    t.after(() => removeTempConfigDir(configDir));

    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: "invalid key",
        }),
        { status },
      );

    const result = await runCliCapture(["auth", "login"], {
      configDir,
      env: {},
      fetchImpl,
      prompts: {
        password: async () => "bad-key",
      },
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /API key validation failed/);
    assert.equal(getSavedApiKey({ configDir }), null);
  }
});

test("auth login --no-validate saves without hitting the network", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  let fetchCalls = 0;

  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not be called");
  };

  const result = await runCliCapture(["auth", "login", "--no-validate"], {
    configDir,
    env: {},
    fetchImpl,
    prompts: {
      password: async () => "saved-no-validate",
    },
    stdinIsTTY: true,
    stdoutIsTTY: true,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(getSavedApiKey({ configDir }), "saved-no-validate");
});

test("auth logout --force removes the saved key", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("to-be-removed", { configDir });

  const result = await runCliCapture(["auth", "logout", "--force"], {
    configDir,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(getSavedApiKey({ configDir }), null);
});

test("auth status shows config source when env and config both exist", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("config-key", { configDir });

  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer config-key");

    return new Response(
      JSON.stringify({
        limit: 100,
        requests_used: 20,
        remaining: 80,
        renews_at: "2026-04-02T00:00:00.000Z",
      }),
      { status: 200 },
    );
  };

  const result = await runCliCapture(["auth", "status"], {
    configDir,
    env: { SYNTHETIC_API_KEY: "env-key" },
    fetchImpl,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Credential source: config/);
  assert.match(result.stdout, /Validation: ok/);
  assert.match(result.stdout, /Limit: 100/);
});

test("auth status shows config source and not configured states correctly", async (t) => {
  const configuredDir = await createTempConfigDir();
  const emptyDir = await createTempConfigDir();

  t.after(() => Promise.all([removeTempConfigDir(configuredDir), removeTempConfigDir(emptyDir)]));

  saveApiKey("config-key", { configDir: configuredDir });

  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer config-key");

    return new Response(
      JSON.stringify({
        limit: 30,
        requests_used: 5,
        remaining: 25,
        renews_at: "2026-04-03T00:00:00.000Z",
      }),
      { status: 200 },
    );
  };

  const configured = await runCliCapture(["auth", "status"], {
    configDir: configuredDir,
    env: {},
    fetchImpl,
  });

  assert.equal(configured.exitCode, 0);
  assert.match(configured.stdout, /Credential source: config/);

  const notConfigured = await runCliCapture(["auth", "status"], {
    configDir: emptyDir,
    env: {},
    fetchImpl,
  });

  assert.equal(notConfigured.exitCode, 0);
  assert.match(notConfigured.stdout, /Credential source: not configured/);
});
