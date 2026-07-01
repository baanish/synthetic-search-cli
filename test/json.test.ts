import assert from "node:assert/strict";
import test from "node:test";

import { SyntheticCliError } from "../src/lib/errors.ts";
import {
  parseSyntheticJson,
  sanitizeJsonResponse,
  truncateText,
  tryParseSyntheticJson,
} from "../src/lib/json.ts";

test("truncateText returns the value unchanged when within the limit", () => {
  assert.equal(truncateText("hello", 5), "hello");
  assert.equal(truncateText("hi", 10), "hi");
});

test("truncateText appends an ellipsis and never exceeds the limit", () => {
  assert.equal(truncateText("abcdefg", 5), "ab...");
  assert.equal(truncateText("abcdefg", 5).length, 5);
});

test("truncateText never returns output longer than maxLength for small limits", () => {
  for (const maxLength of [0, 1, 2, 3]) {
    const out = truncateText("abcdefg", maxLength);
    assert.ok(
      out.length <= maxLength,
      `maxLength=${maxLength} produced ${JSON.stringify(out)} (length ${out.length})`,
    );
  }
});

test("sanitizeJsonResponse escapes raw control characters inside strings so JSON.parse succeeds", () => {
  const backspace = String.fromCharCode(0x08);
  const malformed = `{"text":"hello${backspace}world"}`;

  // The raw body is not valid JSON (control char inside a string).
  assert.throws(() => JSON.parse(malformed));

  const sanitized = sanitizeJsonResponse(malformed);
  const parsed = JSON.parse(sanitized) as { text: string };
  assert.match(parsed.text, /hello/);
  assert.match(parsed.text, /world/);
});

test("sanitizeJsonResponse leaves already-valid JSON parseable", () => {
  const valid = JSON.stringify({ a: 1, b: "two", c: [true, null] });
  assert.deepEqual(JSON.parse(sanitizeJsonResponse(valid)), { a: 1, b: "two", c: [true, null] });
});

test("parseSyntheticJson throws a SyntheticCliError on unparseable input", () => {
  assert.throws(
    () => parseSyntheticJson("{not json"),
    (error: unknown) => {
      assert.ok(error instanceof SyntheticCliError);
      assert.match((error as Error).message, /malformed JSON/);
      return true;
    },
  );
});

test("tryParseSyntheticJson returns null on unparseable input and a value on success", () => {
  assert.equal(tryParseSyntheticJson("{not json"), null);
  assert.deepEqual(tryParseSyntheticJson('{"ok":true}'), { ok: true });
});
