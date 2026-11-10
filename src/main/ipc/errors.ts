import { randomUUID } from 'node:crypto';
import { SkillsError } from '../modules/skills';
import { UpdaterError } from '../modules/updater/errors';
import { PlatformError } from '../modules/platform/types';
import type { ErrorCode, AppError } from '../../shared/contracts';
export type { ErrorCode, AppError, Result } from '../../shared/contracts';

const codes = new Set<ErrorCode>([
  'INVALID_REQUEST',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'READ_ONLY',
  'BUSY',
  'INSIDE_WORKSPACE',
  'REVISION_CHANGED',
  'UNAVAILABLE',
  'TIMEOUT',
  'IO_ERROR',
  'REFRESH_FAILED',
  'INTERNAL',
]);
export class ServiceFault extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
export function mapError(
  error: unknown,
  log?: (id: string, error: unknown) => void,
): AppError {
  if (error instanceof ServiceFault)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  if (error instanceof UpdaterError || error instanceof PlatformError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  if (error instanceof SkillsError) {
    const mapping = {
      'invalid-input': 'INVALID_REQUEST',
      'not-found': 'NOT_FOUND',
      conflict: 'CONFLICT',
      unavailable: 'UNAVAILABLE',
      failed: 'IO_ERROR',
    } as const;
    return {
      code: mapping[error.code],
      message: error.message,
      retryable: error.code === 'unavailable',
    };
  }
  // The settings/activity owner exports OwnerError with these safe, typed fields.
  if (
    error instanceof Error &&
    error.name === 'OwnerError' &&
    'code' in error &&
    codes.has(error.code as ErrorCode)
  ) {
    return {
      code: error.code as ErrorCode,
      message: error.message,
      retryable: 'retryable' in error && error.retryable === true,
    };
  }
  const correlationId = randomUUID();
  log?.(correlationId, error);
  return {
    code: 'INTERNAL',
    message: 'The action could not be completed. Open the logs for details.',
    retryable: false,
    correlationId,
  };
}
