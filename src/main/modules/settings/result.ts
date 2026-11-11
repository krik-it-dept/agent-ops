// Plain, serialisable results shared by the settings, workspaces, tasks and
// activity modules, in the shape of docs/electron/ipc-contract.md: a failure
// carries a stable code for the caller and a sentence for the owner.

export type ErrorCode =
  /** The request or a value is invalid (HTTP 400 in the baseline). */
  | 'INVALID_REQUEST'
  /** The plan, workspace or file is not there (404). */
  | 'NOT_FOUND'
  /** The action conflicts with the current state: overlap, a name clash, a locked or redirected file (409). */
  | 'CONFLICT'
  /** Settings cannot be saved until the settings file is fixed (409). */
  | 'READ_ONLY'
  /** Another move is running (409). */
  | 'BUSY'
  /** A Tasks folder inside a workspace; the owner may confirm and resubmit with allowInsideWorkspace (409). */
  | 'INSIDE_WORKSPACE'
  /** A Tasks folder that holds a workspace; the owner should pick a folder beside it, such as a new subfolder (400). */
  | 'CONTAINS_WORKSPACE'
  /** The plan file's bytes or identity changed since the owner reviewed it (409). */
  | 'REVISION_CHANGED'
  /** Saving or another file operation failed (500). */
  | 'IO_ERROR';

export interface AppError {
  code: ErrorCode;
  /** A plain sentence for the owner. */
  message: string;
  /** Whether the same request may succeed later without a change (a held file, a running move). */
  retryable: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['BUSY', 'IO_ERROR']);

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ErrorCode, message: string): Result<T> {
  return {
    ok: false,
    error: { code, message, retryable: RETRYABLE.has(code) },
  };
}

/** OwnerError is thrown inside a module and turned into a failed Result at its API. */
export class OwnerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OwnerError';
  }
}

/** settle runs work and turns an OwnerError into a failed Result; any other error becomes IO_ERROR. */
export async function settle<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await work());
  } catch (err) {
    if (err instanceof OwnerError) return fail(err.code, err.message);
    return fail('IO_ERROR', err instanceof Error ? err.message : String(err));
  }
}
