import Conf from "conf";

import type { ResolvedCredentials } from "../types.js";
import { SyntheticUsageError } from "./errors.js";

type AuthConfig = {
  apiKey?: string;
};

export type AuthOptions = {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
};

function createStore(configDir?: string): Conf<AuthConfig> {
  return new Conf<AuthConfig>({
    projectName: "synthetic-search",
    cwd: configDir,
  });
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
