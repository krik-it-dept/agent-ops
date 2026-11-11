import { dirname, resolve } from 'node:path';
import {
  PlatformError,
  type RegistrationPolicy,
  type RegistrationPort,
  type StartupPort,
} from './types';

export const APP_ID = 'KrikIT.AgentOps';
export const APP_NAME = 'Agent Ops';
export const PROTOCOL = 'agent-ops';
export function registrationAllowed(policy: RegistrationPolicy): boolean {
  if (policy.platform !== 'win32') return false;
  if (policy.env.AGENT_OPS_REGISTER === '1') return true;
  return (
    !policy.development &&
    !!policy.installedRoot &&
    resolve(dirname(policy.executable)).toLowerCase() ===
      resolve(policy.installedRoot).toLowerCase()
  );
}

const comparable = (value: string) =>
  resolve(value.trim().replace(/^"(.*)"$/, '$1')).toLowerCase();

export class StartupService {
  readonly managed: boolean;
  constructor(
    private readonly port: StartupPort,
    private readonly policy: RegistrationPolicy,
    private readonly launchArgs: readonly string[] = [],
  ) {
    this.managed = registrationAllowed(policy);
  }
  private options(): { path: string; args: string[] } {
    return {
      path: this.policy.executable,
      args: [...this.launchArgs, '--background'],
    };
  }
  get(): { enabled: boolean; managed: boolean } {
    return {
      enabled: this.managed && this.registered(),
      managed: this.managed,
    };
  }
  /**
   * The Run value is written under APP_NAME, so it is read under the same name;
   * otherwise Electron looks for its default value name and reports off. An
   * enabled launch item of ours also counts, whichever way the OS reports it.
   */
  private registered(): boolean {
    const { path, args } = this.options();
    const result = this.port.read({ path, args, name: APP_NAME });
    if (result.openAtLogin) return true;
    const executable = comparable(path);
    return (result.launchItems ?? []).some(
      (item) =>
        item.name.toLowerCase() === APP_NAME.toLowerCase() &&
        item.enabled &&
        comparable(item.path) === executable,
    );
  }
  set(enabled: boolean): { enabled: boolean; managed: boolean } {
    if (!this.managed)
      throw new PlatformError(
        'CONFLICT',
        'Start with Windows is managed by the installed app.',
      );
    this.port.write({
      ...this.options(),
      name: APP_NAME,
      openAtLogin: enabled,
    });
    return this.get();
  }
}

/** Only OS protocol registration is gated; parsing never has side effects. */
export class ProtocolRegistration {
  constructor(
    private readonly port: RegistrationPort,
    private readonly policy: RegistrationPolicy,
    private readonly launchArgs: readonly string[] = [],
  ) {}
  register(): boolean {
    return (
      registrationAllowed(this.policy) &&
      this.port.setProtocol(PROTOCOL, this.policy.executable, [
        ...this.launchArgs,
      ])
    );
  }
  remove(): boolean {
    return (
      registrationAllowed(this.policy) &&
      this.port.removeProtocol(PROTOCOL, this.policy.executable, [
        ...this.launchArgs,
      ])
    );
  }
}
