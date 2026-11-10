// Errors of the updater: typed refusals of an API call (UpdaterError) and the
// plain sentence shown for a failed check or download (classifyUpdateError).
// Raw error text, response bodies and paths are never shown to the owner.

import type { UpdateErrorKind } from './types';

export type UpdaterErrorCode = 'BUSY' | 'CONFLICT' | 'UNAVAILABLE' | 'IO_ERROR';

export class UpdaterError extends Error {
  readonly code: UpdaterErrorCode;
  readonly retryable: boolean;

  constructor(code: UpdaterErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'UpdaterError';
    this.code = code;
    this.retryable = retryable;
  }

  toJSON(): { code: UpdaterErrorCode; message: string; retryable: boolean } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export const UPDATE_MESSAGES: Record<UpdateErrorKind, string> = {
  offline:
    'Agent Ops could not reach GitHub to check for updates. Check the internet connection; Agent Ops tries again later.',
  'rate-limited':
    'GitHub is limiting update checks for now. Agent Ops tries again later.',
  'no-release': 'No published release of Agent Ops was found.',
  checksum:
    'The downloaded update did not match its checksum and was discarded. Agent Ops keeps running; try again later.',
  metadata:
    'The release is missing its update information. Agent Ops keeps running; try again later.',
  install:
    'The update was downloaded, but its installer could not be started. Agent Ops keeps running; try again.',
  failed:
    'The update could not be completed. Agent Ops keeps running; try again later.',
};

const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
]);

function field(err: unknown, name: string): unknown {
  return typeof err === 'object' && err !== null
    ? (err as Record<string, unknown>)[name]
    : undefined;
}

export function classifyUpdateError(err: unknown): {
  kind: UpdateErrorKind;
  message: string;
} {
  const code = String(field(err, 'code') ?? '');
  const status = Number(field(err, 'statusCode') ?? field(err, 'status') ?? 0);
  const text = err instanceof Error ? err.message : String(err ?? '');
  let kind: UpdateErrorKind = 'failed';
  // electron-updater's GitHub provider wraps the HTTP error of the latest-release
  // request (ERR_UPDATER_LATEST_VERSION_NOT_FOUND inside
  // ERR_UPDATER_INVALID_RELEASE_FEED); the status and the rate-limit evidence
  // survive only in its message, so they are recognised there, narrowly.
  const wrappedRateLimit =
    /\b(403|429)\b/.test(text) &&
    /rate limit|x-ratelimit-remaining"?:\s*"?0\b/i.test(text);
  const wrappedOffline =
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/.test(
      text,
    );
  if (code === 'ERR_UPDATER_INSTALL') {
    kind = 'install';
  } else if (
    OFFLINE_CODES.has(code) ||
    wrappedOffline ||
    /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|CONNECTION_\w+|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED)/.test(
      text,
    )
  ) {
    kind = 'offline';
  } else if (
    status === 429 ||
    (status === 403 && /rate limit/i.test(text)) ||
    wrappedRateLimit
  ) {
    kind = 'rate-limited';
  } else if (
    /sha512 checksum mismatch|checksum mismatch/i.test(text) ||
    code === 'ERR_CHECKSUM_MISMATCH'
  ) {
    kind = 'checksum';
  } else if (
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    status === 404
  ) {
    kind = 'no-release';
  } else if (
    code === 'ERR_UPDATER_INVALID_UPDATE_INFO' ||
    code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
    code === 'ERR_UPDATER_ASSET_NOT_FOUND' ||
    /latest\.yml|update info/i.test(text)
  ) {
    kind = 'metadata';
  }
  return { kind, message: UPDATE_MESSAGES[kind] };
}
