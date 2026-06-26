import assert from "node:assert/strict";
import test from "node:test";

import type { SyntheticQuotas, SyntheticSearchResult } from "../src/types.ts";
import { renderQuotasText, renderSearchResultsText, sanitizeForTerminal } from "../src/lib/output.ts";

// Matches every C0/C1 control character and DEL except the newline (0x0a) that
// the renderer itself uses to separate lines. Built from an escaped string so
// this source file stays pure ASCII (no literal control bytes).
const FORBIDDEN_CONTROL = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f]");
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CR = String.fromCharCode(0x0d);

function result(overrides: Partial<SyntheticSearchResult> = {}): SyntheticSearchResult {
  return { url: "https://example.com", title: "Example", text: "hello world", published: null, ...overrides };
}

test("renderSearchResultsText reports an empty result set", () => {
  assert.equal(renderSearchResultsText([]), "No results found.");
});

test("renderSearchResultsText numbers results and includes url, title, and snippet", () => {
  const rendered = renderSearchResultsText([
    result({ title: "First", url: "https://one.com", text: "alpha" }),
    result({ title: "Second", url: "https://two.com", text: "beta" }),
  ]);

  assert.match(rendered, /1\. First/);
  assert.match(rendered, /https:\/\/one\.com/);
  assert.match(rendered, /2\. Second/);
});

test("renderSearchResultsText shows the published date only when present", () => {
  const withDate = renderSearchResultsText([result({ published: "2026-01-01" })]);
  const withoutDate = renderSearchResultsText([result({ published: null })]);

  assert.match(withDate, /Published: 2026-01-01/);
  assert.doesNotMatch(withoutDate, /Published:/);
});

test("renderSearchResultsText strips ANSI escape sequences from a malicious title", () => {
  const rendered = renderSearchResultsText([
    result({ title: `Safe${ESC}[2J${ESC}[1;1HHIJACKED` }),
  ]);

  assert.doesNotMatch(rendered, FORBIDDEN_CONTROL);
  assert.ok(!rendered.includes(ESC));
  assert.match(rendered, /Safe/);
  assert.match(rendered, /HIJACKED/);
});

test("renderSearchResultsText neutralizes control bytes in url and text fields", () => {
  const rendered = renderSearchResultsText([
    result({
      url: `https://evil.example${CR}https://spoofed.example`,
      text: `snippet ${ESC}]52;c;ZXZpbA==${BEL} with OSC payload`,
    }),
  ]);

  assert.doesNotMatch(rendered, FORBIDDEN_CONTROL);
  assert.ok(!rendered.includes(ESC));
});

test("renderSearchResultsText strips colon-form CSI parameters (truecolor SGR)", () => {
  const rendered = renderSearchResultsText([result({ title: `${ESC}[38:2:255:0:0mRED` })]);

  assert.doesNotMatch(rendered, FORBIDDEN_CONTROL);
  assert.ok(!rendered.includes(ESC));
  assert.match(rendered, /RED/);
});

test("renderSearchResultsText neutralizes the 8-bit C1 CSI introducer (0x9b)", () => {
  const c1Csi = String.fromCharCode(0x9b);
  const rendered = renderSearchResultsText([result({ title: `before${c1Csi}2Jafter` })]);

  assert.doesNotMatch(rendered, FORBIDDEN_CONTROL);
  assert.ok(!rendered.includes(c1Csi));
});

test("sanitizeForTerminal stays linear on a large unterminated OSC payload (no catastrophic backtracking)", () => {
  // On the old lazy `[\s\S]*?`-to-terminator regex this input took seconds and
  // scaled quadratically; the negated-class rewrite handles it in milliseconds.
  // The benign marker precedes the payload (a trailing unterminated OSC body is
  // itself consumed).
  const hostile = "keep" + `${ESC}]`.repeat(100_000);

  const out = sanitizeForTerminal(hostile);

  assert.ok(!out.includes(ESC));
  assert.match(out, /keep/);
});

test("renderQuotasText strips control characters from an API-supplied renewsAt", () => {
  const quotas: SyntheticQuotas = {
    buckets: [
      {
        key: "subscription",
        label: "Subscription",
        limit: 10,
        requestsUsed: 1,
        remaining: 9,
        renewsAt: `2026-01-01${ESC}[31mINJECTED`,
      },
    ],
  };

  const rendered = renderQuotasText(quotas);

  assert.doesNotMatch(rendered, FORBIDDEN_CONTROL);
  assert.ok(!rendered.includes(ESC));
  assert.match(rendered, /Limit: 10/);
});

test("renderQuotasText sanitizes terminal escapes in a bucket label", () => {
  const quotas: SyntheticQuotas = {
    buckets: [
      { key: "x", label: `Lab${ESC}[2Jel`, limit: 1, requestsUsed: 0, remaining: 1, renewsAt: null },
    ],
  };

  const rendered = renderQuotasText(quotas);

  assert.doesNotMatch(rendered, FORBIDDEN_CONTROL);
  assert.ok(!rendered.includes(ESC));
});

test("renderQuotasText renders multiple buckets with labels", () => {
  const quotas: SyntheticQuotas = {
    buckets: [
      { key: "search", label: "Search (hourly)", limit: 250, requestsUsed: 26, remaining: 224, renewsAt: null },
      { key: "subscription", label: "Subscription", limit: 750, requestsUsed: 0, remaining: 750, renewsAt: null },
    ],
  };

  const rendered = renderQuotasText(quotas);

  assert.match(rendered, /Search \(hourly\):/);
  assert.match(rendered, /Subscription:/);
  assert.match(rendered, /Remaining: 224/);
  assert.match(rendered, /Renews at: unknown/);
});
