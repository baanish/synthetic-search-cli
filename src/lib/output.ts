import type { SyntheticQuotas, SyntheticSearchResult } from "../types.js";
import { truncateText } from "./json.js";

export type WritableLike = {
  write: (chunk: string) => unknown;
};

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
    const lines: string[] = [`${index + 1}. ${result.title}`, result.url];

    if (result.published) {
      lines.push(`Published: ${result.published}`);
    }

    const snippet = truncateText(result.text.replace(/\s+/g, " ").trim(), 320);

    if (snippet) {
      lines.push(wrapText(snippet, width));
    }

    return lines.join("\n");
  });

  return blocks.join("\n\n");
}

export function renderQuotasText(quotas: SyntheticQuotas): string {
  return [
    `Limit: ${quotas.limit}`,
    `Requests used: ${quotas.requestsUsed}`,
    `Remaining: ${quotas.remaining}`,
    `Renews at: ${quotas.renewsAt ?? "unknown"}`,
  ].join("\n");
}

export function writeJson(stdout: WritableLike, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonError(stderr: WritableLike, message: string): void {
  stderr.write(`${JSON.stringify({ error: message })}\n`);
}
