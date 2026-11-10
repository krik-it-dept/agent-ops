// Typed errors of the Skills module. Every message is a sentence for the owner,
// in plain words (Skills, AI tools, folders); callers show it as it is.

export type SkillsErrorCode =
  | 'invalid-input' // the owner's input cannot be used (HTTP 400)
  | 'not-found' // the folder is no longer in the list, or an unknown action (HTTP 404)
  | 'conflict' // the files or settings are not in a state that allows the action (HTTP 409)
  | 'unavailable' // the app cannot change settings right now (HTTP 503)
  | 'failed'; // settings could not be saved (HTTP 500)

export class SkillsError extends Error {
  readonly code: SkillsErrorCode;

  constructor(code: SkillsErrorCode, message: string) {
    super(message);
    this.name = 'SkillsError';
    this.code = code;
  }

  /** A plain serialisable form, for IPC or HTTP responses. */
  toJSON(): { error: string; code: SkillsErrorCode } {
    return { error: this.message, code: this.code };
  }
}

export const invalidInput = (message: string): SkillsError =>
  new SkillsError('invalid-input', message);
export const conflict = (message: string): SkillsError =>
  new SkillsError('conflict', message);
export const notFound = (message: string): SkillsError =>
  new SkillsError('not-found', message);

/** The file changed between the read the action was based on and its write. */
export class FileChangedError extends Error {
  constructor() {
    super(
      'the file changed while Agent Ops was editing it; nothing was written',
    );
    this.name = 'FileChangedError';
  }
}

/** The file itself is a symbolic link or junction; Agent Ops never edits those. */
export class FileLinkedError extends Error {
  constructor() {
    super('the file is a link; Agent Ops does not edit linked files');
    this.name = 'FileLinkedError';
  }
}

export const MODIFIED_TEXT =
  'This file was changed outside Agent Ops. Use View diff, then Keep mine or Replace.';
export const NOT_LISTED_TEXT =
  'This folder is no longer in the list. Reload Settings.';

/** The message of any thrown value, for wrapping into an owner-facing sentence. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
