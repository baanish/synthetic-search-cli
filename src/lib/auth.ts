import Conf from "conf";
import { chmodSync, existsSync, statSync } from "node:fs";

import type { ResolvedCredentials } from "../types.js";
import { SyntheticUsageError } from "./errors.js";
import { sanitizeForTerminal } from "./output.js";

// POSIX single-quote a string so it is safe to paste into a shell command.
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

let credentialPermissionWarned = false;

// If the credential file is still group/world-accessible after the chmod attempt
// (e.g. on a filesystem that rejected it), warn the user once with a concrete
// remediation rather than silently using an exposed key. We warn instead of
// failing closed so the CLI keeps working on platforms without POSIX permissions
// (Windows) or quirky filesystems; the message goes straight to process.stderr
// because it is a security advisory that must surface regardless of --json mode.
function warnIfCredentialFileExposed(path: string): void {
  if (credentialPermissionWarned || process.platform === "win32") {
    return;
  }

  try {
    if (!existsSync(path)) {
      return;
    }

    if ((statSync(path).mode & 0o077) !== 0) {
      credentialPermissionWarned = true;
      // The path may contain spaces/shell metacharacters/control bytes: shell-quote
      // the chmod argument and neutralize terminal escapes in the whole message.
      const message =
        `Warning: saved API key file ${path} is accessible to other users and could not be restricted. ` +
        `Run: chmod 600 ${shellQuote(path)}`;
      process.stderr.write(`${sanitizeForTerminal(message)}\n`);
    }
  } catch {
    // Ignore — the warning is best-effort.
  }
}

type AuthConfig = {
  apiKey?: string;
};

export type AuthOptions = {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
};

function createStore(configDir?: string): Conf<AuthConfig> {
  const store = new Conf<AuthConfig>({
    projectName: "synthetic-search",
    cwd: configDir,
    // The store holds a plaintext API key; restrict it to the owner so it is not
    // group/world-readable on shared machines. conf defaults to 0o666.
    configFileMode: 0o600,
  });

  // configFileMode only applies when conf creates the file. Tighten a file left
  // behind by an older version (created group/world-readable) on open as well,
  // so upgrades don't keep a loosely-permissioned key around. Best-effort:
  // chmod is a no-op / may throw on platforms without POSIX permissions.
  try {
    if (existsSync(store.path)) {
      chmodSync(store.path, 0o600);
    }
  } catch {
    // Ignore — restrictive permissions are a hardening step, not a hard requirement.
  }

  warnIfCredentialFileExposed(store.path);

  return store;
}

function normalizeKey(value: string): string {
  return value.trim();
}

export function resolveCredentials(options: AuthOptions = {}): ResolvedCredentials {
  const savedApiKey = getSavedApiKey(options);

  if (savedApiKey) {
    return {
      source: "config",
      apiKey: savedApiKey,
    };
  }

  const env = options.env ?? process.env;
  const envApiKey = env.SYNTHETIC_API_KEY?.trim();

  if (envApiKey) {
    return {
      source: "env",
      apiKey: envApiKey,
    };
  }

  return {
    source: "none",
    apiKey: null,
  };
}

export function getSavedApiKey(options: AuthOptions = {}): string | null {
  const store = createStore(options.configDir);
  const value = store.get("apiKey");

  if (typeof value !== "string") {
    return null;
  }

  const normalized = normalizeKey(value);

  return normalized || null;
}

export function saveApiKey(apiKey: string, options: AuthOptions = {}): void {
  const normalized = normalizeKey(apiKey);

  if (!normalized) {
    throw new SyntheticUsageError("API key cannot be empty.");
  }

  const store = createStore(options.configDir);
  store.set("apiKey", normalized);
}

export function deleteSavedApiKey(options: AuthOptions = {}): boolean {
  const store = createStore(options.configDir);

  if (!store.has("apiKey")) {
    return false;
  }

  store.delete("apiKey");
  return true;
}

export function hasSavedApiKey(options: AuthOptions = {}): boolean {
  const store = createStore(options.configDir);

  return store.has("apiKey");
}

export function maskApiKey(apiKey: string): string {
  const normalized = normalizeKey(apiKey);

  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= 8) {
    const first = normalized[0] ?? "";
    const last = normalized.at(-1) ?? "";

    return `${first}***${last}`;
  }

  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}
