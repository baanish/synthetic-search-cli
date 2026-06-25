import type { SyntheticQuotas, SyntheticSearchResult } from "../types.js";
import { truncateText } from "./json.js";

export type WritableLike = {
  write: (chunk: string) => unknown;
};

// Search results and quota fields are attacker-influenceable strings that we
// print straight to a terminal. Without neutralizing them, a result could emit
// ANSI/OSC escape sequences to clear the screen, reposition the cursor (spoofing
// other lines), beep, or write the system clipboard. Strip recognized escape
// sequences for clean output, then replace EVERY remaining control byte — stray
// ESC (0x1b), the 8-bit C1 CSI introducer (0x9b), CR, BEL, DEL, … — with a
// space. The second pass is the real safety net: with no escape introducer left,
// any leftover bytes are inert text. Patterns are built from escaped strings so
// this file stays pure ASCII, and use only simple/negated character classes
// (no lazy `.*?` scan-to-terminator) so they stay linear on hostile input and
// cannot trigger catastrophic backtracking.
const TERMINAL_ESCAPE_SEQUENCES = new RegExp(
  // CSI: ESC [ params(0x30-0x3f, incl. colon-form SGR) intermediates(0x20-0x2f) final(0x40-0x7e)
  "\\u001b\\[[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]" +
    // OSC: ESC ] body (anything but BEL/ESC) optional BEL/ST terminator
    "|\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?" +
    // Other two-byte Fe escapes: ESC followed by 0x40-0x5f
    "|\\u001b[\\x40-\\x5f]",
  "g",
);
const TERMINAL_CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

export function sanitizeForTerminal(value: string): string {
  return value.replace(TERMINAL_ESCAPE_SEQUENCES, "").replace(TERMINAL_CONTROL_CHARS, " ");
}

function wrapText(text: string, width: number): string {
  const safeWidth = Math.max(width, 20);
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return "";
  }

  const lines: string[] = [];
  let line = words[0] ?? "";

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] as string;

    if (`${line} ${word}`.length > safeWidth) {
      lines.push(line);
      line = word;
      continue;
    }

    line = `${line} ${word}`;
  }

  lines.push(line);

  return lines.join("\n");
}

export function renderSearchResultsText(results: SyntheticSearchResult[], width = 80): string {
  if (results.length === 0) {
    return "No results found.";
  }

  const blocks = results.map((result, index) => {
    const lines: string[] = [
      `${index + 1}. ${sanitizeForTerminal(result.title)}`,
      sanitizeForTerminal(result.url),
    ];

    if (result.published) {
      lines.push(`Published: ${sanitizeForTerminal(result.published)}`);
    }

    const snippet = truncateText(sanitizeForTerminal(result.text).replace(/\s+/g, " ").trim(), 320);

    if (snippet) {
      lines.push(wrapText(snippet, width));
    }

    return lines.join("\n");
  });

  return blocks.join("\n\n");
}

export function renderQuotasText(quotas: SyntheticQuotas): string {
  return quotas.buckets
    .map((bucket) =>
      [
        `${bucket.label}:`,
        `  Limit: ${bucket.limit}`,
        `  Requests used: ${bucket.requestsUsed}`,
        `  Remaining: ${bucket.remaining}`,
        `  Renews at: ${bucket.renewsAt ? sanitizeForTerminal(bucket.renewsAt) : "unknown"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

const JSON_RAW_CONTROL_CHARS = new RegExp("[\\u007f-\\u009f]", "g");

// JSON.stringify escapes C0 control characters (0x00-0x1f) but leaves DEL (0x7f)
// and the C1 range (0x80-0x9f) — which includes the 8-bit CSI introducer 0x9b —
// as raw bytes. Escape them so JSON printed to a terminal can't carry an active
// escape sequence, while remaining valid, round-trippable JSON.
function toTerminalSafeJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(
    JSON_RAW_CONTROL_CHARS,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function writeJson(stdout: WritableLike, value: unknown): void {
  stdout.write(`${toTerminalSafeJson(value, 2)}\n`);
}

export function writeJsonError(stderr: WritableLike, message: string): void {
  stderr.write(`${toTerminalSafeJson({ error: message })}\n`);
}
