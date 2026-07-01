// Sandboxed fuzz harness: drives runCli with a temp config dir, empty env, and a
// deterministic mock fetch. Never touches real config or consumes live quota.
// Goal: surface crashes (unhandled rejections / non-graceful exits) and
// silently-wrong input handling. Run: npx tsx scripts/fuzz.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCliCapture } from "../test/helpers.ts";

function makeFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

const OK_SEARCH = JSON.stringify({
  results: [{ url: "https://e.com", title: "T", text: "body text" }],
});
const OK_QUOTAS = JSON.stringify({ limit: 10, requests_used: 1, remaining: 9, renews_at: null });

type Case = {
  argv: string[];
  body?: string;
  status?: number;
  stdinText?: string;
  stdinIsTTY?: boolean;
};

// Reuses the test harness (runCliCapture) so the fuzzer drives the CLI exactly
// like the test suite does, just with a temp config dir per case and a wrapper
// that records uncaught throws.
async function runCase(c: Case): Promise<{ exitCode: number; threw: boolean; err?: string }> {
  const configDir = mkdtempSync(join(tmpdir(), "ss-fuzz-"));
  try {
    const { exitCode } = await runCliCapture(c.argv, {
      env: {},
      configDir,
      fetchImpl: makeFetch(c.body ?? OK_SEARCH, c.status ?? 200),
      prompts: { password: async () => "fuzz-key", confirm: async () => true },
      stdinText: c.stdinText,
      stdinIsTTY: c.stdinIsTTY ?? false,
      stdoutIsTTY: false,
    });
    return { exitCode, threw: false };
  } catch (error) {
    return { exitCode: -1, threw: true, err: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

// Deterministic pseudo-random generator so runs are reproducible.
let seed = 1337;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)] as T;
}

const TOKENS = [
  "search", "quotas", "auth", "login", "logout", "status", "help",
  "--json", "--limit", "--force", "--no-validate", "-h", "--help", "-V",
  "0", "-1", "3abc", "1e9", "3.7", "999999999999999999999", "NaN", "Infinity",
  "", " ", "--", "-x", "хелло", "💥", "a\nb", "\t", "--limit=2", "query words",
  "<script>", "'; DROP", "\\u0000", "../../etc/passwd", "-",
];
const NESTED_QUOTAS = JSON.stringify({
  subscription: { limit: 750, requests: 5, renewsAt: "2026-06-26T00:00:00.000Z" },
  search: { hourly: { limit: 250, requests: 10, renewsAt: "2026-06-25T21:00:00.000Z" } },
  weeklyTokenLimit: { percentRemaining: 80 },
  rollingFiveHourLimit: { remaining: 750, max: 750 },
});
const BODIES = [
  OK_SEARCH, OK_QUOTAS, NESTED_QUOTAS, "{", "", "null", "[]", "not json at all",
  '{"subscription":{"limit":1},"requests":9}', '{"search":{"hourly":null}}',
  '{"results":null}', '{"results":[null,{}]}', '{"results":"x"}',
  '{"results":[{"url":"u","title":"t","text":"xy"}]}',
  JSON.stringify({ results: Array.from({ length: 50 }, (_, i) => ({ url: `u${i}`, title: `t${i}`, text: "x" })) }),
];
const STATUSES = [200, 400, 401, 403, 429, 500, 502];

function report(line: string): void {
  process.stderr.write(`${line}\n`);
}

process.on("unhandledRejection", (reason) => {
  report(`UNHANDLED-REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}`);
  process.exit(3);
});
process.on("uncaughtException", (error) => {
  report(`UNCAUGHT-EXCEPTION: ${error.stack ?? error.message}`);
  process.exit(4);
});

async function main(): Promise<void> {
  report("FUZZ-START");
  const crashes: Array<{ case: Case; result: Awaited<ReturnType<typeof runCase>> }> = [];
  const ITERATIONS = Number.parseInt(process.env.FUZZ_ITERATIONS ?? "", 10) || 4000;

  // 1) Targeted seed cases first.
  const seeds: Case[] = [
    { argv: ["search", "hello", "--limit", "3abc"] },
    { argv: ["search", "hello", "--limit", "1e9"] },
    { argv: ["search", "hello", "--limit", "3.7"] },
    { argv: ["search"], stdinText: "", stdinIsTTY: false },
    { argv: ["quotas", "--json"], body: "{", status: 200 },
    { argv: ["search", "x", "--json"], body: '{"results":"x"}' },
    { argv: ["search", "x"], body: "", status: 500 },
    { argv: ["--json", "--bogus"] },
    { argv: ["auth"] },
    { argv: ["auth", "login"], stdinIsTTY: true },
  ];

  for (const c of seeds) {
    if (process.env.FUZZ_TRACE) report(`SEED ${JSON.stringify(c.argv)}`);
    const result = await runCase(c);
    if (result.threw) crashes.push({ case: c, result });
  }

  // 2) Random argv + body + status fuzzing.
  for (let i = 0; i < ITERATIONS; i += 1) {
    const argvLen = Math.floor(rand() * 5);
    const argv = Array.from({ length: argvLen }, () => pick(TOKENS));
    const c: Case = {
      argv,
      body: pick(BODIES),
      status: pick(STATUSES),
      stdinText: rand() < 0.3 ? pick(TOKENS) : undefined,
      stdinIsTTY: rand() < 0.5,
    };
    if (process.env.FUZZ_TRACE) report(`ITER ${i} ${JSON.stringify(c.argv)} stdin=${JSON.stringify(c.stdinText)}`);
    const result = await runCase(c);
    // A crash is an uncaught throw, or an exit code outside runCli's contract:
    // 0 (success / help / version) or 1 (any CommanderError or SyntheticCliError).
    if (result.threw || ![0, 1].includes(result.exitCode)) {
      crashes.push({ case: c, result });
    }
  }

  if (crashes.length === 0) {
    report(`OK: ${ITERATIONS} random + ${seeds.length} seed cases, no crashes / unexpected exits.`);
    return;
  }

  report(`FOUND ${crashes.length} problem case(s):`);
  for (const { case: c, result } of crashes.slice(0, 40)) {
    report(JSON.stringify({ argv: c.argv, status: c.status, body: c.body?.slice(0, 30), result }));
  }
  process.exitCode = 1;
}

main().catch((error) => {
  report(`FUZZ HARNESS ITSELF THREW: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 2;
});
