import assert from "node:assert/strict";
import test from "node:test";

import { getQuotas, search } from "../src/lib/client.ts";
import { SyntheticApiError, SyntheticCliError } from "../src/lib/errors.ts";

function jsonFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

// --- search response robustness -------------------------------------------------

test("search throws a clear SyntheticCliError when the response is not a JSON object", async () => {
  for (const body of ["null", '"a string"', "42", "true"]) {
    await assert.rejects(
      () => search("q", "key", jsonFetch(body)),
      (error: unknown) => {
        assert.ok(error instanceof SyntheticCliError, `expected SyntheticCliError for body ${body}`);
        assert.match((error as Error).message, /valid results array/);
        return true;
      },
    );
  }
});

test("search surfaces a formatted API error on a 4xx response with a JSON error body", async () => {
  await assert.rejects(
    () => search("q", "key", jsonFetch(JSON.stringify({ error: "bad request" }), 400)),
    (error: unknown) => {
      assert.ok(error instanceof SyntheticApiError);
      assert.equal((error as SyntheticApiError).status, 400);
      assert.match((error as Error).message, /status 400: bad request/);
      return true;
    },
  );
});

test("search wraps a network/transport failure in a SyntheticApiError", async () => {
  const failingFetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => search("q", "key", failingFetch),
    (error: unknown) => {
      assert.ok(error instanceof SyntheticApiError);
      assert.match((error as Error).message, /request failed: ECONNREFUSED/);
      return true;
    },
  );
});

// --- quotas normalization -------------------------------------------------------

test("getQuotas surfaces a formatted API error on a 5xx response", async () => {
  await assert.rejects(
    () => getQuotas("key", jsonFetch("", 503)),
    (error: unknown) => {
      assert.ok(error instanceof SyntheticApiError);
      assert.equal((error as SyntheticApiError).status, 503);
      assert.match((error as Error).message, /status 503/);
      return true;
    },
  );
});

test("getQuotas clamps a derived remaining to zero when usage exceeds the limit", async () => {
  const quotas = await getQuotas("key", jsonFetch(JSON.stringify({ limit: 100, requests_used: 250 })));

  assert.equal(quotas.buckets.length, 1);
  assert.equal(quotas.buckets[0]?.limit, 100);
  assert.equal(quotas.buckets[0]?.requestsUsed, 250);
  assert.equal(quotas.buckets[0]?.remaining, 0);
});

test("getQuotas clamps a directly-reported negative remaining to zero", async () => {
  const quotas = await getQuotas(
    "key",
    jsonFetch(JSON.stringify({ limit: 100, requests_used: 50, remaining: -5 })),
  );

  assert.equal(quotas.buckets[0]?.remaining, 0);
});

// Characterization test: pin the exact normalized output for the REAL nested
// /v2/quotas response shape, with NON-ZERO usage so the limit-minus-used
// derivation is actually defended. The CLI reports the search hourly bucket
// first (the quota that constrains searches), then the subscription bucket; each
// bucket reads all three fields from its own object. If this assertion fails
// after a refactor, that is intentional — update these values AND the documented
// policy in src/lib/client.ts together.
test("getQuotas pins the normalized output for the real nested quotas shape", async () => {
  const realShape = JSON.stringify({
    subscription: { limit: 750, requests: 100, renewsAt: "2026-06-26T00:55:20.529Z" },
    search: { hourly: { limit: 250, requests: 26, renewsAt: "2026-06-25T20:00:01.530Z" } },
    freeToolCalls: { limit: 0, requests: 0, renewsAt: "2026-06-26T19:55:20.663Z" },
    weeklyTokenLimit: { percentRemaining: 77.04, maxCredits: "$36.00", remainingCredits: "$27.73" },
    rollingFiveHourLimit: { remaining: 750, max: 750, limited: false },
  });

  const quotas = await getQuotas("key", jsonFetch(realShape));

  assert.deepEqual(quotas, {
    buckets: [
      {
        key: "search",
        label: "Search (hourly)",
        limit: 250,
        requestsUsed: 26,
        remaining: 224,
        renewsAt: "2026-06-25T20:00:01.530Z",
      },
      {
        key: "subscription",
        label: "Subscription",
        limit: 750,
        requestsUsed: 100,
        remaining: 650,
        renewsAt: "2026-06-26T00:55:20.529Z",
      },
    ],
  });
});

test("getQuotas derives requestsUsed from remaining when the usage key is absent", async () => {
  const quotas = await getQuotas(
    "key",
    jsonFetch(JSON.stringify({ subscription: { limit: 100, remaining: 30, renewsAt: null } })),
  );

  const subscription = quotas.buckets.find((bucket) => bucket.key === "subscription");
  assert.equal(subscription?.limit, 100);
  assert.equal(subscription?.requestsUsed, 70);
  assert.equal(subscription?.remaining, 30);
});

test("getQuotas reports an over-quota bucket faithfully (used > limit, remaining floored to 0)", async () => {
  const quotas = await getQuotas(
    "key",
    jsonFetch(JSON.stringify({ subscription: { limit: 100, requests: 120 } })),
  );

  const subscription = quotas.buckets.find((bucket) => bucket.key === "subscription");
  assert.equal(subscription?.limit, 100);
  assert.equal(subscription?.requestsUsed, 120);
  assert.equal(subscription?.remaining, 0);
});

test("getQuotas never fabricates a bucket from fields spread across different objects", async () => {
  // limit lives in subscription, the usage counter is a top-level field — there
  // is no single coherent bucket, so this must error rather than stitch them.
  await assert.rejects(
    () => getQuotas("key", jsonFetch(JSON.stringify({ requests: 5, subscription: { limit: 9999 } }))),
    (error: unknown) => {
      assert.ok(error instanceof SyntheticCliError);
      assert.match((error as Error).message, /valid limit, requests used, and remaining/);
      return true;
    },
  );
});

test("getQuotas does not let an unrelated top-level counter cross-contaminate a bucket", async () => {
  // A stray top-level `requests` must not be read as the subscription bucket's
  // usage — each documented bucket reads all of its fields from its own object.
  const quotas = await getQuotas(
    "key",
    jsonFetch(JSON.stringify({ requests: 900, subscription: { limit: 750, requests: 100 } })),
  );

  const subscription = quotas.buckets.find((bucket) => bucket.key === "subscription");
  assert.equal(subscription?.limit, 750);
  assert.equal(subscription?.requestsUsed, 100);
  assert.equal(subscription?.remaining, 650);
});

test("getQuotas rejects a response that lacks usable quota fields", async () => {
  await assert.rejects(
    () => getQuotas("key", jsonFetch(JSON.stringify({ unrelated: true }))),
    (error: unknown) => {
      assert.ok(error instanceof SyntheticCliError);
      assert.match((error as Error).message, /valid limit, requests used, and remaining/);
      return true;
    },
  );
});
