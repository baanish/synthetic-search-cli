import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { runCli, type CliIO, type RunCliOptions } from "../src/index.ts";

class MemoryWritable {
  buffer = "";
  isTTY = true;
  columns = 80;

  write(chunk: string): boolean {
    this.buffer += chunk;
    return true;
  }
}

type RunCliCaptureOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: RunCliOptions["fetchImpl"];
  configDir?: string;
  prompts?: RunCliOptions["prompts"];
  stdinText?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
};

export async function createTempConfigDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "synthetic-search-cli-test-"));
}

export async function removeTempConfigDir(configDir: string): Promise<void> {
  await rm(configDir, { recursive: true, force: true });
}

export async function runCliCapture(
  argv: string[],
  options: RunCliCaptureOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();

  stdout.isTTY = options.stdoutIsTTY ?? true;
  stderr.isTTY = options.stdoutIsTTY ?? true;

  const stdin = Readable.from(options.stdinText ? [options.stdinText] : []);
  (stdin as Readable & { isTTY?: boolean }).isTTY = options.stdinIsTTY ?? true;

  const io: CliIO = {
    stdin: stdin as CliIO["stdin"],
    stdout: stdout as unknown as CliIO["stdout"],
    stderr: stderr as unknown as CliIO["stderr"],
  };

  const exitCode = await runCli(argv, {
    io,
    env: options.env,
    fetchImpl: options.fetchImpl,
    configDir: options.configDir,
    prompts: options.prompts,
  });

  return {
    exitCode,
    stdout: stdout.buffer,
    stderr: stderr.buffer,
  };
}
