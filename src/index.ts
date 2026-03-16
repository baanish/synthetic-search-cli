#!/usr/bin/env node

import { confirm as promptConfirm, password as promptPassword } from "@inquirer/prompts";
import { Command, CommanderError } from "commander";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  deleteSavedApiKey,
  hasSavedApiKey,
  maskApiKey,
  resolveCredentials,
  saveApiKey,
} from "./lib/auth.js";
import { getQuotas, search, type FetchLike } from "./lib/client.js";
import { SyntheticCliError, SyntheticUsageError, getErrorMessage } from "./lib/errors.js";
import { renderQuotasText, renderSearchResultsText, writeJson, writeJsonError } from "./lib/output.js";

type ReadableLike = AsyncIterable<Uint8Array | string> & {
  isTTY?: boolean;
};

type WritableLike = {
  write: (chunk: string) => unknown;
  isTTY?: boolean;
  columns?: number;
};

export type CliIO = {
  stdin: ReadableLike;
  stdout: WritableLike;
  stderr: WritableLike;
};

type PromptApi = {
  password: (options: { message: string; mask?: string }) => Promise<string>;
  confirm: (options: { message: string; default?: boolean }) => Promise<boolean>;
};

export type RunCliOptions = {
  io?: CliIO;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  configDir?: string;
  prompts?: Partial<PromptApi>;
};

type SearchCommandOptions = {
  json?: boolean;
  limit?: string;
};

type QuotasCommandOptions = {
  json?: boolean;
};

type AuthLoginCommandOptions = {
  validate: boolean;
};

type AuthLogoutCommandOptions = {
  force?: boolean;
};

type CommandContext = {
  io: CliIO;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  configDir?: string;
  prompts: PromptApi;
};

const DEFAULT_PROMPTS: PromptApi = {
  password: (options) => promptPassword(options),
  confirm: (options) => promptConfirm(options),
};

function routeRootToSearch(argv: string[]): string[] {
  const firstArg = argv[0];

  if (firstArg === undefined) {
    return ["search"];
  }

  if (["search", "quotas", "auth", "help"].includes(firstArg)) {
    return argv;
  }

  if (["--help", "-h", "--version", "-V"].includes(firstArg)) {
    return argv;
  }

  if (firstArg.startsWith("-")) {
    return ["search", ...argv];
  }

  return ["search", ...argv];
}

function wantsJsonOutput(argv: string[]): boolean {
  return argv.includes("--json");
}

function toOutputWidth(stdout: WritableLike): number {
  const columns = stdout.columns;

  if (typeof columns === "number" && Number.isFinite(columns) && columns > 20) {
    return columns;
  }

  return 80;
}

function isInteractive(io: CliIO): boolean {
  return Boolean(io.stdin.isTTY && io.stdout.isTTY);
}

function parseLimit(limitValue: string | undefined): number | undefined {
  if (limitValue === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(limitValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SyntheticUsageError("--limit must be a positive integer.");
  }

  return parsed;
}

async function readQueryFromInput(queryParts: string[], stdin: ReadableLike): Promise<string | null> {
  if (queryParts.length > 0) {
    const joinedQuery = queryParts.join(" ").trim();
    return joinedQuery || null;
  }

  if (stdin.isTTY) {
    return null;
  }

  let body = "";

  for await (const chunk of stdin) {
    body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }

  const trimmed = body.trim();

  return trimmed || null;
}

function resolveApiKey(context: CommandContext): string {
  const resolved = resolveCredentials({
    env: context.env,
    configDir: context.configDir,
  });

  if (!resolved.apiKey) {
    throw new SyntheticCliError(
      "No Synthetic API key configured. Set SYNTHETIC_API_KEY or run `synthetic-search auth login`.",
    );
  }

  return resolved.apiKey;
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) {
    return items;
  }

  return items.slice(0, limit);
}

async function runSearchCommand(
  queryParts: string[],
  options: SearchCommandOptions,
  command: Command,
  context: CommandContext,
): Promise<void> {
  const query = await readQueryFromInput(queryParts, context.io.stdin);

  if (!query) {
    throw new SyntheticUsageError(`Query is required.\n\n${command.helpInformation()}`);
  }

  const limit = parseLimit(options.limit);
  const apiKey = resolveApiKey(context);
  const results = applyLimit(await search(query, apiKey, context.fetchImpl), limit);

  if (options.json) {
    writeJson(context.io.stdout, { results });
    return;
  }

  context.io.stdout.write(`${renderSearchResultsText(results, toOutputWidth(context.io.stdout))}\n`);
}

async function runQuotasCommand(options: QuotasCommandOptions, context: CommandContext): Promise<void> {
  const apiKey = resolveApiKey(context);
  const quotas = await getQuotas(apiKey, context.fetchImpl);

  if (options.json) {
    writeJson(context.io.stdout, quotas);
    return;
  }

  context.io.stdout.write(`${renderQuotasText(quotas)}\n`);
}

async function runAuthLoginCommand(
  options: AuthLoginCommandOptions,
  context: CommandContext,
): Promise<void> {
  if (!isInteractive(context.io)) {
    throw new SyntheticUsageError("auth login requires an interactive terminal.");
  }

  const apiKey = (
    await context.prompts.password({
      message: "Enter your Synthetic API key",
      mask: "*",
    })
  ).trim();

  if (!apiKey) {
    throw new SyntheticUsageError("API key cannot be empty.");
  }

  if (options.validate) {
    try {
      await getQuotas(apiKey, context.fetchImpl);
    } catch (error) {
      throw new SyntheticCliError(`API key validation failed: ${getErrorMessage(error)}`);
    }
  }

  saveApiKey(apiKey, { configDir: context.configDir });

  context.io.stdout.write(
    options.validate ? "API key saved after validation.\n" : "API key saved without validation.\n",
  );
}

async function runAuthLogoutCommand(
  options: AuthLogoutCommandOptions,
  context: CommandContext,
): Promise<void> {
  if (!hasSavedApiKey({ configDir: context.configDir })) {
    context.io.stdout.write("No saved API key found.\n");
    return;
  }

  if (!options.force) {
    if (!isInteractive(context.io)) {
      throw new SyntheticUsageError("Use --force to logout in non-interactive mode.");
    }

    const confirmed = await context.prompts.confirm({
      message: "Remove the saved Synthetic API key?",
      default: false,
    });

    if (!confirmed) {
      context.io.stdout.write("Logout cancelled.\n");
      return;
    }
  }

  deleteSavedApiKey({ configDir: context.configDir });
  context.io.stdout.write("Saved API key removed.\n");
}

async function runAuthStatusCommand(context: CommandContext): Promise<void> {
  const credentials = resolveCredentials({
    env: context.env,
    configDir: context.configDir,
  });

  if (credentials.source === "none" || !credentials.apiKey) {
    context.io.stdout.write("Credential source: not configured\n");
    return;
  }

  context.io.stdout.write(`Credential source: ${credentials.source}\n`);
  context.io.stdout.write(`API key: ${maskApiKey(credentials.apiKey)}\n`);

  try {
    const quotas = await getQuotas(credentials.apiKey, context.fetchImpl);

    context.io.stdout.write("Validation: ok\n");
    context.io.stdout.write(`${renderQuotasText(quotas)}\n`);
  } catch (error) {
    context.io.stdout.write("Validation: failed\n");
    throw new SyntheticCliError(`Credential validation failed: ${getErrorMessage(error)}`);
  }
}

function registerSearchCommand(command: Command, context: CommandContext): void {
  command
    .argument("[query...]", "Search query")
    .option("--json", "Output results as JSON")
    .option("--limit <n>", "Limit number of results")
    .action(async (queryParts: string[] | undefined, options: SearchCommandOptions, cmd: Command) => {
      await runSearchCommand(Array.isArray(queryParts) ? queryParts : [], options, cmd, context);
    });
}

export function createProgram(context: CommandContext): Command {
  const program = new Command();

  program
    .name("synthetic-search")
    .description("Search the public web with Synthetic and inspect account quotas.");

  registerSearchCommand(
    program.command("search").description("Search the public web with Synthetic."),
    context,
  );

  program
    .command("quotas")
    .description("Show current Synthetic quota usage.")
    .option("--json", "Output quotas as JSON")
    .action(async (options: QuotasCommandOptions) => {
      await runQuotasCommand(options, context);
    });

  const authCommand = program.command("auth").description("Manage Synthetic API credentials.");

  authCommand
    .command("login")
    .description("Save an API key after optional validation.")
    .option("--no-validate", "Skip live validation against /v2/quotas")
    .action(async (options: AuthLoginCommandOptions) => {
      await runAuthLoginCommand(options, context);
    });

  authCommand
    .command("logout")
    .description("Remove the saved API key.")
    .option("--force", "Skip confirmation prompt")
    .action(async (options: AuthLogoutCommandOptions) => {
      await runAuthLogoutCommand(options, context);
    });

  authCommand
    .command("status")
    .description("Show credential source and validation status.")
    .action(async () => {
      await runAuthStatusCommand(context);
    });

  program.showHelpAfterError();

  return program;
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<number> {
  const io: CliIO =
    options.io ??
    ({
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    } as CliIO);

  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const jsonMode = wantsJsonOutput(argv);

  const context: CommandContext = {
    io,
    env,
    fetchImpl,
    configDir: options.configDir,
    prompts: {
      ...DEFAULT_PROMPTS,
      ...options.prompts,
    },
  };

  const program = createProgram(context);

  program.configureOutput({
    writeOut: (text) => {
      io.stdout.write(text);
    },
    writeErr: (text) => {
      if (!jsonMode) {
        io.stderr.write(text);
      }
    },
  });

  program.exitOverride();

  try {
    const routedArgv = routeRootToSearch(argv);
    await program.parseAsync(routedArgv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0 && jsonMode) {
        writeJsonError(io.stderr, error.message);
      }

      return error.exitCode;
    }

    const message = getErrorMessage(error);

    if (jsonMode) {
      writeJsonError(io.stderr, message);
    } else {
      io.stderr.write(`${message}\n`);
    }

    if (error instanceof SyntheticCliError) {
      return error.exitCode;
    }

    return 1;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];

  if (!entry) {
    return false;
  }

  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

if (isDirectExecution()) {
  runCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`${getErrorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
