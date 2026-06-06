export const workspaceNamespace = "@droid-webscr" as const;

export type Result<TValue, TError = Error> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

export interface Logger {
  readonly debug: (message: string, context?: Record<string, unknown>) => void;
  readonly error: (message: string, context?: Record<string, unknown>) => void;
  readonly info: (message: string, context?: Record<string, unknown>) => void;
  readonly warn: (message: string, context?: Record<string, unknown>) => void;
}

export type CleanupCallback = () => Promise<void> | void;

export class AppError<TCode extends string = string> extends Error {
  public readonly code: TCode;

  public constructor(code: TCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export function ok<TValue>(value: TValue): Result<TValue, never> {
  return { ok: true, value };
}

export function err<TError>(error: TError): Result<never, TError> {
  return { error, ok: false };
}

export function isOk<TValue, TError>(
  result: Result<TValue, TError>,
): result is { readonly ok: true; readonly value: TValue } {
  return result.ok;
}

export function isErr<TValue, TError>(
  result: Result<TValue, TError>,
): result is { readonly ok: false; readonly error: TError } {
  return !result.ok;
}

export async function cleanupAll(callbacks: readonly CleanupCallback[]): Promise<void> {
  let firstError: unknown;
  let hasError = false;

  await callbacks.toReversed().reduce(async (previous, callback) => {
    await previous;
    try {
      await callback();
    } catch (error) {
      hasError = true;
      firstError ??= error;
    }
  }, Promise.resolve());

  if (hasError) {
    throw firstError;
  }
}

export function packageLabel(name: string): string {
  if (name.length === 0) {
    throw new Error("Package name must not be empty.");
  }

  return `${workspaceNamespace}/${name}`;
}
