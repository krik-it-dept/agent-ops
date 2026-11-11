// Agents find the report command through two pointers, like the Tasks folder:
// the user environment variable AGENT_OPS_REPORT (installed instance only,
// through the injected writer) and <dataDir>\report-command.txt. Both hold the
// full path of the app's executable. The installed skill never holds the path.

import path from 'node:path';
import { errorText } from '../../lib/safe-io/paths';
import {
  readFileRetry,
  writeFileAtomic,
  type SafeIoOptions,
} from '../../lib/safe-io/safe-io';
import type { UserEnvironment } from '../tasks';

export const REPORT_ENV_NAME = 'AGENT_OPS_REPORT';
export const REPORT_POINTER_NAME = 'report-command.txt';

export interface ReportPointerOptions {
  dataDir: string;
  /** Only the installed instance passes the writer; dev, test and smoke never set the variable. */
  env?: UserEnvironment | undefined;
  io?: SafeIoOptions | undefined;
}

/**
 * syncReportPointers makes report-command.txt (one line, UTF-8, LF) and, with
 * env, AGENT_OPS_REPORT name executable. Unchanged pointers are not rewritten.
 * Failures are collected; the rest still runs.
 */
export async function syncReportPointers(
  executable: string,
  opts: ReportPointerOptions,
): Promise<string[]> {
  const problems: string[] = [];
  const file = path.join(opts.dataDir, REPORT_POINTER_NAME);
  try {
    let current = '';
    try {
      current = (await readFileRetry(file, opts.io)).toString('utf8');
    } catch {
      current = '';
    }
    if (current !== executable + '\n')
      await writeFileAtomic(file, executable + '\n', opts.io);
  } catch (err) {
    problems.push(`${REPORT_POINTER_NAME}: ${errorText(err)}`);
  }
  if (opts.env) {
    try {
      if ((await opts.env.get(REPORT_ENV_NAME)) !== executable) {
        await opts.env.set(REPORT_ENV_NAME, executable);
        opts.env.broadcast();
      }
    } catch (err) {
      problems.push(`${REPORT_ENV_NAME}: ${errorText(err)}`);
    }
  }
  return problems;
}
