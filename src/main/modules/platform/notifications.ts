import { validPlanKey } from './activation';
import { APP_NAME } from './registration';

export interface NotificationEvent {
  kind: string;
  project?: string;
  repo: string;
  plan: string;
  text: string;
  extra?: string;
}
export interface NotificationPort {
  supported(): boolean;
  show(
    options: { title: string; body: string; icon: string },
    onClick: () => void,
    onFailure: () => void,
  ): void;
}
const labels: Readonly<Record<string, string>> = {
  waiting: 'Cần bạn xử lý',
  blocked: 'Bị chặn',
  question: 'Câu hỏi mới',
  'run-blocked': 'Agent bị chặn',
};
export function notificationText(text: string): string {
  return Array.from(text)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        (code >= 32 || code === 9 || code === 10 || code === 13) &&
        code !== 0xfffe &&
        code !== 0xffff &&
        code !== 0xfffd &&
        !(code >= 0xd800 && code <= 0xdfff)
      );
    })
    .slice(0, 1000)
    .join('');
}
export function createNotifier(options: {
  port: NotificationPort;
  enabled(): boolean;
  managed: boolean;
  icon: string;
  openPlan(key: string): void;
  onError?: () => void;
  now?: () => number;
}) {
  let runWindow = Number.NEGATIVE_INFINITY;
  const runPlans = new Set<string>();
  return {
    notify(events: readonly NotificationEvent[]): number {
      if (!options.managed || !options.enabled() || !options.port.supported())
        return 0;
      let shown = 0;
      for (const event of events) {
        const label = Object.hasOwn(labels, event.kind)
          ? labels[event.kind]
          : undefined;
        if (
          !label ||
          (event.kind === 'question' &&
            event.extra &&
            !event.extra.toLowerCase().startsWith('open'))
        )
          continue;
        const key = [event.project, event.repo, event.plan]
          .filter((v) => v !== undefined && v !== '')
          .join('/');
        if (!validPlanKey(key)) continue;
        if (event.kind === 'run-blocked') {
          const now = options.now?.() ?? Date.now();
          if (now - runWindow >= 60_000) {
            runWindow = now;
            runPlans.clear();
          }
          // Keep every activity entry, but limit run toasts across watcher batches.
          if (runPlans.has(key) || runPlans.size >= 3) continue;
          runPlans.add(key);
        }
        try {
          options.port.show(
            {
              title: APP_NAME,
              body: notificationText(
                `${label} · ${event.plan}\n${event.kind === 'waiting' ? (event.extra ?? '') : event.text}${event.kind === 'run-blocked' && event.extra ? `\n${event.extra}` : ''}`,
              ),
              icon: options.icon,
            },
            () => options.openPlan(key),
            () => options.onError?.(),
          );
          shown++;
        } catch {
          options.onError?.();
        }
      }
      return shown;
    },
  };
}
