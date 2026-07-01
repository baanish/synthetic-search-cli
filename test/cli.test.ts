import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { saveApiKey } from "../src/lib/auth.ts";
import { runCliCapture, createTempConfigDir, removeTempConfigDir } from "./helpers.ts";

const packageVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version as string;

const ESC = String.fromCharCode(0x1b);
const C1_CSI = String.fromCharCode(0x9b);

test("--version prints the package version and exits 0", async () => {
  const result = await runCliCapture(["--version"], { env: {} });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), packageVersion);
});

test("-V prints the package version and exits 0", async () => {
  const result = await runCliCapture(["-V"], { env: {} });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), packageVersion);
});

test("unknown subcommand option exits non-zero without killing the process", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  const result = await runCliCapture(["search", "hello", "--bogus"], {
    configDir,
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not run for a usage error");
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /unknown option/);
});

test("unknown subcommand option in --json mode emits a JSON error to stderr", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  const result = await runCliCapture(["search", "hello", "--json", "--bogus"], {
    configDir,
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not run for a usage error");
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  const payload = JSON.parse(result.stderr) as { error: string };
  assert.match(payload.error, /unknown option/);
});

test("subcommand usage errors write to the injected stderr, not the real process stderr", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  const result = await runCliCapture(["quotas", "--bogus"], {
    configDir,
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not run for a usage error");
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /unknown option/);
});

test("commander usage errors sanitize terminal escapes from the option name (text mode)", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  const result = await runCliCapture(["search", "hi", `--${ESC}[2Jbogus`], {
    configDir,
    env: {},
    stdoutIsTTY: true,
    stderrIsTTY: true,
    fetchImpl: async () => {
      throw new Error("fetch should not run for a usage error");
    },
  });

  assert.equal(result.exitCode, 1);
  assert.ok(!result.stderr.includes(ESC), "ESC byte must not reach stderr");
  assert.match(result.stderr, /unknown option/);
  // Help/usage layout (newlines) is preserved by the layout-aware sanitizer.
  assert.ok(result.stderr.includes("\n"));
});

test("--limit rejects exponent notation instead of silently parsing 1e9 as 1", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  let fetched = false;
  const result = await runCliCapture(["search", "hello", "--limit", "1e9", "--json"], {
    configDir,
    env: {},
    fetchImpl: async () => {
      fetched = true;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(fetched, false);
  const payload = JSON.parse(result.stderr) as { error: string };
  assert.match(payload.error, /positive integer/);
});

test("--limit rejects trailing-garbage and fractional values", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  for (const value of ["3abc", "3.7", "0x10", " 5 ", "1e21"]) {
    const result = await runCliCapture(["search", "hello", "--limit", value, "--json"], {
      configDir,
      env: {},
      fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    });

    assert.equal(result.exitCode, 1, `expected rejection for --limit ${JSON.stringify(value)}`);
    const payload = JSON.parse(result.stderr) as { error: string };
    assert.match(payload.error, /positive integer/);
  }
});

test("--limit still accepts a clean positive integer", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  const result = await runCliCapture(["search", "hello", "--limit", "2", "--json"], {
    configDir,
    env: {},
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          results: [
            { url: "https://one.com", title: "One", text: "first" },
            { url: "https://two.com", title: "Two", text: "second" },
            { url: "https://three.com", title: "Three", text: "third" },
          ],
        }),
        { status: 200 },
      ),
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as { results: unknown[] };
  assert.equal(payload.results.length, 2);
});

test("search --json output escapes raw C1 control bytes so JSON is terminal-safe", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  // JSON.stringify does not escape C1 bytes (0x80-0x9f); the API body carries a
  // raw 0x9b (8-bit CSI) inside a result title.
  const body = JSON.stringify({
    results: [{ url: "https://e.com", title: `evil${C1_CSI}2Jtitle`, text: "body" }],
  });

  const result = await runCliCapture(["search", "hello", "--json"], {
    configDir,
    env: {},
    fetchImpl: async () => new Response(body, { status: 200 }),
  });

  assert.equal(result.exitCode, 0);
  assert.ok(!result.stdout.includes(C1_CSI), "raw C1 byte must not reach stdout");
  // Still valid, round-trippable JSON: the byte survives as a \u escape.
  const payload = JSON.parse(result.stdout) as { results: Array<{ title: string }> };
  assert.ok(payload.results[0]?.title.includes(C1_CSI));
});

test("text-mode API error output sanitizes terminal escapes from the upstream body", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  const body = JSON.stringify({ error: `denied${ESC}[2Jhijacked` });

  const result = await runCliCapture(["search", "hello"], {
    configDir,
    env: {},
    stdoutIsTTY: true,
    stderrIsTTY: true,
    fetchImpl: async () => new Response(body, { status: 400 }),
  });

  assert.equal(result.exitCode, 1);
  assert.ok(!result.stderr.includes(ESC), "ESC byte must not reach stderr");
  assert.match(result.stderr, /denied/);
  assert.match(result.stderr, /hijacked/);
  assert.match(result.stderr, /400/);
});

test("empty-query usage error stays concise and does not embed full help text", async (t) => {
  const configDir = await createTempConfigDir();
  t.after(() => removeTempConfigDir(configDir));
  saveApiKey("config-key", { configDir });

  const result = await runCliCapture(["search", "--json"], {
    configDir,
    env: {},
    stdinText: "   ",
    stdinIsTTY: false,
    fetchImpl: async () => {
      throw new Error("fetch should not run when query is empty");
    },
  });

  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stderr) as { error: string };
  assert.match(payload.error, /[Qq]uery is required/);
  assert.doesNotMatch(payload.error, /Usage:/);
});
