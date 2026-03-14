import { SyntheticCliError } from "./errors.js";

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function escapeJsonControlCharacter(charCode: number): string {
  switch (charCode) {
    case 0x08:
      return "\\b";
    case 0x09:
      return "\\t";
    case 0x0a:
      return "\\n";
    case 0x0c:
      return "\\f";
    case 0x0d:
      return "\\r";
    default:
      return `\\u${charCode.toString(16).padStart(4, "0")}`;
  }
}

export function sanitizeJsonResponse(rawText: string): string {
  let sanitized = "";
  let inString = false;
  let isEscaping = false;

  for (const char of rawText) {
    const charCode = char.charCodeAt(0);

    if (!inString) {
      if (char === '"') {
        inString = true;
      }

      sanitized += char;
      continue;
    }

    if (isEscaping) {
      sanitized += char;
      isEscaping = false;
      continue;
    }

    if (char === "\\") {
      sanitized += char;
      isEscaping = true;
      continue;
    }

    if (char === '"') {
      sanitized += char;
      inString = false;
      continue;
    }

    if (charCode <= 0x1f) {
      sanitized += escapeJsonControlCharacter(charCode);
      continue;
    }

    sanitized += char;
  }

  return sanitized;
}

export function parseSyntheticJson<T>(rawText: string): T {
  try {
    return JSON.parse(sanitizeJsonResponse(rawText)) as T;
  } catch (error) {
    throw new SyntheticCliError(
      `Synthetic API returned malformed JSON that could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function tryParseSyntheticJson<T>(rawText: string): T | null {
  try {
    return JSON.parse(sanitizeJsonResponse(rawText)) as T;
  } catch {
    return null;
  }
}
