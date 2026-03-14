export class SyntheticCliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "SyntheticCliError";
    this.exitCode = exitCode;
  }
}

export class SyntheticUsageError extends SyntheticCliError {
  constructor(message: string) {
    super(message, 1);
    this.name = "SyntheticUsageError";
  }
}

export class SyntheticApiError extends SyntheticCliError {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message, 1);
    this.name = "SyntheticApiError";
    this.status = status;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
