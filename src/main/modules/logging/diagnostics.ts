export interface DiagnosticCounts {
  projects: number;
  enabledProjects: number;
  folderProjects: number;
  plans: number;
  diagnostics: number;
  crashes: number;
}
export interface DiagnosticSettings {
  notifications: boolean;
  startup: boolean;
  tasksConfigured: boolean;
  setupComplete: boolean;
  registrationManaged: boolean;
  readOnly: boolean;
  updateChecks: boolean;
  shortcuts: boolean;
}
export interface DiagnosticVersions {
  app: string;
  electron: string;
  chromium: string;
  node: string;
  os: string;
}
export interface DiagnosticsInput {
  versions: DiagnosticVersions;
  counts: DiagnosticCounts;
  settings: DiagnosticSettings;
}
export interface Diagnostics {
  versions: DiagnosticVersions;
  counts: DiagnosticCounts;
  settings: DiagnosticSettings;
}
const version = (value: string): string =>
  /^v?\d+(?:\.\d+){0,3}(?:[-+][0-9a-z.-]+)?$/i.test(value) &&
  value.length <= 100
    ? value
    : 'unknown';
const count = (value: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** Project only fixed fields; never spread caller state, errors, paths or plan DTOs. */
export function collectDiagnostics(input: DiagnosticsInput): Diagnostics {
  const v = input.versions,
    c = input.counts,
    s = input.settings;
  return {
    versions: {
      app: version(v.app),
      electron: version(v.electron),
      chromium: version(v.chromium),
      node: version(v.node),
      os: version(v.os),
    },
    counts: {
      projects: count(c.projects),
      enabledProjects: count(c.enabledProjects),
      folderProjects: count(c.folderProjects),
      plans: count(c.plans),
      diagnostics: count(c.diagnostics),
      crashes: count(c.crashes),
    },
    settings: {
      notifications: s.notifications === true,
      startup: s.startup === true,
      tasksConfigured: s.tasksConfigured === true,
      setupComplete: s.setupComplete === true,
      registrationManaged: s.registrationManaged === true,
      readOnly: s.readOnly === true,
      updateChecks: s.updateChecks === true,
      shortcuts: s.shortcuts === true,
    },
  };
}
export function diagnosticsText(input: DiagnosticsInput): string {
  const value = collectDiagnostics(input);
  const lines = ['Agent Ops diagnostics'];
  for (const [key, item] of Object.entries(value.versions))
    lines.push(`${key}: ${item}`);
  for (const [key, item] of Object.entries(value.counts))
    lines.push(`${key}: ${item}`);
  for (const [key, item] of Object.entries(value.settings))
    lines.push(`${key}: ${item ? 'on' : 'off'}`);
  return `${lines.join('\n')}\n`;
}
export function createDiagnosticsService(
  input: () => DiagnosticsInput,
  clipboard: { writeText(text: string): void },
) {
  return {
    collectDiagnostics: (): Diagnostics => collectDiagnostics(input()),
    get: (): { text: string } => ({ text: diagnosticsText(input()) }),
    copy(): { copied: true } {
      clipboard.writeText(diagnosticsText(input()));
      return { copied: true };
    },
  };
}
