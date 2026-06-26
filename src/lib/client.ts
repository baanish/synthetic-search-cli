import type {
  SyntheticQuotaBucket,
  SyntheticQuotas,
  SyntheticSearchResponse,
  SyntheticSearchResult,
} from "../types.js";
import { SyntheticApiError, SyntheticCliError, getErrorMessage } from "./errors.js";
import { parseSyntheticJson, truncateText, tryParseSyntheticJson } from "./json.js";

const SYNTHETIC_SEARCH_URL = "https://api.synthetic.new/v2/search";
const SYNTHETIC_QUOTAS_URL = "https://api.synthetic.new/v2/quotas";
// `text` is a body preview, so it is capped here (it has always been). The
// identifying fields (url, title, published) are kept in FULL so `--json`
// consumers get faithful, fetchable values; terminal-injection safety does not
// depend on length (the renderer's sanitizer is linear), so there is no need to
// truncate them in the normalized data.
const MAX_TEXT_LENGTH = 2000;
// Upper bound on a response body we will buffer. The real API responses are
// kilobytes; this only guards against a hostile/compromised upstream (or proxy)
// streaming an unbounded body to exhaust memory.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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

// Upstream error bodies are echoed into user-facing errors (and thus into the
// terminal / CI logs). A hostile or misconfigured upstream/proxy could reflect
// the bearer credential back; strip the active key and bearer-token-like
// material before it is ever displayed or logged.
function redactSecrets(text: string, apiKey: string): string {
  let redacted = apiKey ? text.split(apiKey).join("[redacted]") : text;

  redacted = redacted
    .replace(/Bearer\s+[\w.\-~+/]+=*/gi, "Bearer [redacted]")
    .replace(/\bsyn_[\w.\-]+/g, "[redacted]");

  return redacted;
}

function formatApiError(status: number, bodyText: string, apiKey: string): string {
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
      return redactSecrets(`Synthetic API request failed with status ${status}: ${message}`, apiKey);
    }
  }

  return redactSecrets(
    `Synthetic API request failed with status ${status}: ${truncateText(body, 400)}`,
    apiKey,
  );
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

// Build one coherent quota bucket from a SINGLE object, reading every field from
// THAT object only — so a bucket's numbers can never be stitched together from
// different records. Returns null unless the object yields a usable limit plus a
// usage figure (taken directly, or derived from limit - remaining).
//
// Reporting policy (deliberate, owned):
//   - `requestsUsed` is reported faithfully and is NOT clamped: an over-quota
//     bucket shows used > limit rather than hiding how far over it is.
//   - `remaining` is taken from the API when present, else derived as
//     limit - used, and is always floored at 0 (never a negative figure).
//   - A server-reported `remaining` is trusted verbatim (beyond the 0 floor); it
//     is the authoritative figure even if it disagrees with limit - used.
function buildBucket(value: unknown, key: string, label: string): SyntheticQuotaBucket | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const records = [value as Record<string, unknown>];
  const limit = pickNumber(records, ["limit", "request_limit", "requests_limit", "quota_limit"]);

  if (limit === null) {
    return null;
  }

  const reportedRemaining = pickNumber(records, ["remaining", "requests_remaining", "requestsRemaining"]);
  let requestsUsed = pickNumber(records, [
    "requests",
    "requests_used",
    "requestsUsed",
    "used",
    "usage",
    "request_count",
  ]);

  // Derive usage from a reported remaining when the usage key itself is absent.
  if (requestsUsed === null && reportedRemaining !== null) {
    requestsUsed = Math.max(0, limit - reportedRemaining);
  }

  if (requestsUsed === null) {
    return null;
  }

  const remaining = reportedRemaining ?? limit - requestsUsed;
  const renewsAt = pickString(records, ["renewsAt", "renews_at", "reset_at", "resetAt", "resets_at"]) ?? null;

  return { key, label, limit, requestsUsed, remaining: Math.max(0, remaining), renewsAt };
}

function normalizeQuotas(rawValue: unknown): SyntheticQuotas {
  if (typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue)) {
    throw new SyntheticCliError("Synthetic API quotas response did not include a valid JSON object.");
  }

  const raw = rawValue as Record<string, unknown>;
  const buckets: SyntheticQuotaBucket[] = [];

  // Reporting policy: this is a search CLI, so the search hourly bucket — the
  // quota that actually constrains searches — is reported FIRST, followed by the
  // documented account-level subscription bucket. (The /v2/quotas response also
  // carries weeklyTokenLimit/rollingFiveHourLimit buckets; those are intentionally
  // not surfaced.) Each bucket is read coherently from its own object.
  const searchHourly = (raw.search as Record<string, unknown> | undefined)?.hourly;
  const searchBucket = buildBucket(searchHourly, "search", "Search (hourly)");
  if (searchBucket) {
    buckets.push(searchBucket);
  }

  const subscriptionBucket = buildBucket(raw.subscription, "subscription", "Subscription");
  if (subscriptionBucket) {
    buckets.push(subscriptionBucket);
  }

  // Fallback for an unrecognized/reshaped response: try the raw object and its
  // common nested wrappers, using the FIRST one that yields a coherent bucket on
  // its own. Each candidate is read from a single object, so the fallback can
  // never stitch a bucket together from fields in different records.
  if (buckets.length === 0) {
    for (const record of getNestedRecords(raw)) {
      const fallback = buildBucket(record, "subscription", "Subscription");
      if (fallback) {
        buckets.push(fallback);
        break;
      }
    }
  }

  if (buckets.length === 0) {
    throw new SyntheticCliError(
      "Synthetic API quotas response did not include valid limit, requests used, and remaining values.",
    );
  }

  return { buckets };
}

// Read a response body with an upper byte bound so a hostile upstream cannot
// exhaust memory with an unbounded stream. Streams when possible (aborting once
// the cap is crossed); falls back to a buffered read with a post-check for
// Response objects without a readable body.
async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new SyntheticApiError(`Synthetic API response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`);
  }

  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new SyntheticApiError(`Synthetic API response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SyntheticApiError(`Synthetic API response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`);
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function syntheticFetch(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  apiKey: string,
): Promise<{ response: Response; rawText: string }> {
  let response: Response;

  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new SyntheticApiError(
      redactSecrets(`Synthetic API request failed: ${getErrorMessage(error)}`, apiKey),
    );
  }

  const rawText = await readBoundedText(response);

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
    apiKey,
  );

  if (!response.ok) {
    throw new SyntheticApiError(formatApiError(response.status, rawText, apiKey), response.status);
  }

  const parsed = parseSyntheticJson<unknown>(rawText);

  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as SyntheticSearchResponse).results)) {
    throw new SyntheticCliError("Synthetic API response did not include a valid results array.");
  }

  return (parsed as { results: unknown[] }).results
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
    apiKey,
  );

  if (!response.ok) {
    throw new SyntheticApiError(formatApiError(response.status, rawText, apiKey), response.status);
  }

  const parsed = parseSyntheticJson<unknown>(rawText);

  return normalizeQuotas(parsed);
}
