import type { SyntheticQuotas, SyntheticSearchResponse, SyntheticSearchResult } from "../types.js";
import { SyntheticApiError, SyntheticCliError, getErrorMessage } from "./errors.js";
import { parseSyntheticJson, truncateText, tryParseSyntheticJson } from "./json.js";

const SYNTHETIC_SEARCH_URL = "https://api.synthetic.new/v2/search";
const SYNTHETIC_QUOTAS_URL = "https://api.synthetic.new/v2/quotas";
const MAX_TEXT_LENGTH = 2000;

export type FetchLike = typeof fetch;

function normalizeResult(rawResult: unknown): SyntheticSearchResult | null {
  if (typeof rawResult !== "object" || rawResult === null) {
    return null;
  }

  const result = rawResult as Record<string, unknown>;
  const url = typeof result.url === "string" ? result.url : null;
  const title = typeof result.title === "string" ? result.title : null;
  const text = typeof result.text === "string" ? result.text : null;
  const published = typeof result.published === "string" ? result.published : null;

  if (!url || !title || !text) {
    return null;
  }

  return {
    url,
    title,
    text: truncateText(text, MAX_TEXT_LENGTH),
    published,
  };
}

function formatApiError(status: number, bodyText: string): string {
  const body = bodyText.trim();

  if (!body) {
    return `Synthetic API request failed with status ${status}.`;
  }

  const parsed = tryParseSyntheticJson<Record<string, unknown>>(body);

  if (parsed) {
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : null;

    if (message) {
      return `Synthetic API request failed with status ${status}: ${message}`;
    }
  }

  return `Synthetic API request failed with status ${status}: ${truncateText(body, 400)}`;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function coerceString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  return null;
}

function getNestedRecords(raw: Record<string, unknown>): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [raw];

  for (const key of ["quota", "quotas", "subscription", "plan", "data"]) {
    const candidate = raw[key];

    if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
      records.push(candidate as Record<string, unknown>);
    }
  }

  return records;
}

function pickNumber(records: Record<string, unknown>[], keys: string[]): number | null {
  for (const record of records) {
    for (const key of keys) {
      const value = coerceNumber(record[key]);

      if (value !== null) {
        return value;
      }
    }
  }

  return null;
}

function pickString(records: Record<string, unknown>[], keys: string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = coerceString(record[key]);

      if (value !== null) {
        return value;
      }
    }
  }

  return null;
}

function normalizeQuotas(rawValue: unknown): SyntheticQuotas {
  if (typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue)) {
    throw new SyntheticCliError("Synthetic API quotas response did not include a valid JSON object.");
  }

  const raw = rawValue as Record<string, unknown>;
  const records = getNestedRecords(raw);

  const limit = pickNumber(records, ["limit", "request_limit", "requests_limit", "quota_limit"]);
  const requestsUsed = pickNumber(records, [
    "requests_used",
    "requestsUsed",
    "used",
    "usage",
    "request_count",
  ]);
  const remaining = pickNumber(records, ["remaining", "requests_remaining", "requestsRemaining"]);
  const renewsAt =
    pickString(records, ["renews_at", "renewsAt", "reset_at", "resetAt", "resets_at"]) ?? null;

  if (limit === null || requestsUsed === null || remaining === null) {
    throw new SyntheticCliError(
      "Synthetic API quotas response did not include valid limit, requests used, and remaining values.",
    );
  }

  return {
    limit,
    requestsUsed,
    remaining,
    renewsAt,
  };
}

async function syntheticFetch(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<{ response: Response; rawText: string }> {
  let response: Response;

  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new SyntheticApiError(`Synthetic API request failed: ${getErrorMessage(error)}`);
  }

  const rawText = await response.text();

  return { response, rawText };
}

export async function search(
  query: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<SyntheticSearchResult[]> {
  const { response, rawText } = await syntheticFetch(
    SYNTHETIC_SEARCH_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query }),
    },
    fetchImpl,
  );

  if (!response.ok) {
    throw new SyntheticApiError(formatApiError(response.status, rawText), response.status);
  }

  const parsed = parseSyntheticJson<SyntheticSearchResponse>(rawText);

  if (!Array.isArray(parsed.results)) {
    throw new SyntheticCliError("Synthetic API response did not include a valid results array.");
  }

  return parsed.results
    .map((result) => normalizeResult(result))
    .filter((result): result is SyntheticSearchResult => result !== null);
}

export async function getQuotas(apiKey: string, fetchImpl: FetchLike = fetch): Promise<SyntheticQuotas> {
  const { response, rawText } = await syntheticFetch(
    SYNTHETIC_QUOTAS_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
    fetchImpl,
  );

  if (!response.ok) {
    throw new SyntheticApiError(formatApiError(response.status, rawText), response.status);
  }

  const parsed = parseSyntheticJson<unknown>(rawText);

  return normalizeQuotas(parsed);
}
