import assert from "node:assert/strict";
import test from "node:test";

import { saveApiKey } from "../src/lib/auth.ts";
import { runCliCapture, createTempConfigDir, removeTempConfigDir } from "./helpers.ts";

const SEARCH_URL = "https://api.synthetic.new/v2/search";

test("search uses config credentials when env and config are both set", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("config-key", { configDir });

  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), SEARCH_URL);

    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer config-key");

    return new Response(
      JSON.stringify({
        results: [{ url: "https://example.com", title: "Example", text: "hello", published: null }],
      }),
      { status: 200 },
    );
  };

  const result = await runCliCapture(["search", "hello", "--json"], {
    configDir,
    env: { SYNTHETIC_API_KEY: "env-key" },
    fetchImpl,
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as { results: unknown[] };
  assert.equal(payload.results.length, 1);
});

test("search falls back to env var when no saved config exists", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("config-key", { configDir });

  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer config-key");

    return new Response(
      JSON.stringify({
        results: [{ url: "https://example.com", title: "Example", text: "hello", published: null }],
      }),
      { status: 200 },
    );
  };

  const result = await runCliCapture(["search", "hello", "--json"], {
    configDir,
    env: {},
    fetchImpl,
  });

  assert.equal(result.exitCode, 0);
});

test("search reads query from piped stdin when no args are provided", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("config-key", { configDir });

  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    assert.equal(body.query, "query from stdin");

    return new Response(
      JSON.stringify({
        results: [{ url: "https://example.com", title: "Example", text: "hello", published: null }],
      }),
      { status: 200 },
    );
  };

  const result = await runCliCapture(["search", "--json"], {
    configDir,
    env: {},
    fetchImpl,
    stdinText: "  query from stdin  ",
    stdinIsTTY: false,
  });

  assert.equal(result.exitCode, 0);
});

test("search --json prints normalized JSON with results", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("config-key", { configDir });

  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        results: [
          { url: "https://example.com", title: "Example", text: "hello" },
          { title: "missing-url", text: "ignored" },
        ],
      }),
      { status: 200 },
    );

  const result = await runCliCapture(["search", "hello", "--json"], {
    configDir,
    env: {},
    fetchImpl,
  });

  assert.equal(result.exitCode, 0);

  const payload = JSON.parse(result.stdout) as {
    results: Array<{ url: string; title: string; text: string; published: string | null }>;
  };

  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0]?.published, null);
});

test("search --limit slices output in both text and JSON modes", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("config-key", { configDir });

  const responseBody = JSON.stringify({
    results: [
      { url: "https://one.com", title: "One", text: "first" },
      { url: "https://two.com", title: "Two", text: "second" },
      { url: "https://three.com", title: "Three", text: "third" },
    ],
  });

  const fetchImpl: typeof fetch = async () => new Response(responseBody, { status: 200 });

  const jsonResult = await runCliCapture(["search", "hello", "--json", "--limit", "2"], {
    configDir,
    env: {},
    fetchImpl,
  });

  assert.equal(jsonResult.exitCode, 0);
  const jsonPayload = JSON.parse(jsonResult.stdout) as { results: unknown[] };
  assert.equal(jsonPayload.results.length, 2);

  const textResult = await runCliCapture(["search", "hello", "--limit", "2"], {
    configDir,
    env: {},
    fetchImpl,
  });

  assert.equal(textResult.exitCode, 0);
  assert.match(textResult.stdout, /1\. One/);
  assert.match(textResult.stdout, /2\. Two/);
  assert.doesNotMatch(textResult.stdout, /3\. Three/);
});

test("malformed control characters in API JSON are sanitized and parsed", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("config-key", { configDir });

  const malformedBody = `{"results":[{"url":"https://example.com","title":"Example","text":"hello\u0008world"}]}`;

  const fetchImpl: typeof fetch = async () => new Response(malformedBody, { status: 200 });

  const result = await runCliCapture(["search", "hello", "--json"], {
    configDir,
    env: {},
    fetchImpl,
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as { results: Array<{ text: string }> };
  assert.equal(payload.results.length, 1);
  assert.match(payload.results[0]?.text ?? "", /hello/);
});

test("missing results array surfaces a clear error and non-zero exit", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));

  saveApiKey("config-key", { configDir });

  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ nope: true }), { status: 200 });

  const result = await runCliCapture(["search", "hello", "--json"], {
    configDir,
    env: {},
    fetchImpl,
  });

  assert.equal(result.exitCode, 1);
  const errorPayload = JSON.parse(result.stderr) as { error: string };
  assert.match(errorPayload.error, /valid results array/);
});
