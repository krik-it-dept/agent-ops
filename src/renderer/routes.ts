import { protocolPlanLink } from './model';
import { planRoute } from './components/ui';
export function normalizeLegacyHash(hash: string): string {
  if (hash === '#settings') return '#/settings/general';
  if (hash.startsWith('#plan=')) {
    try {
      return (
        '#' + planRoute(decodeURIComponent(hash.slice(6).replace(/\+/g, ' ')))
      );
    } catch {
      return '#/plan/unavailable/summary';
    }
  }
  if (hash.startsWith('#agent-ops:')) {
    const key = protocolPlanLink(hash.slice(1));
    return key ? '#' + planRoute(key) : '#/plan/unavailable/summary';
  }
  return hash;
}
export function routePlan(pathname: string): string | null {
  if (!pathname.startsWith('/plan/')) return null;
  try {
    return decodeURIComponent(pathname.split('/')[2] || '');
  } catch {
    return pathname.split('/')[2] || '';
  }
}
export function openingHash(
  current: string,
  saved: { route?: unknown; view?: unknown; layout?: unknown },
): string {
  if (current && current !== '#') return normalizeLegacyHash(current);
  let route = typeof saved.route === 'string' ? saved.route.split('?')[0]! : '';
  if (
    !route &&
    typeof saved.view === 'string' &&
    saved.view.startsWith('plan:')
  )
    route = planRoute(saved.view.slice(5));
  if (!route && saved.layout === 'list') route = '/list';
  if (
    !/^\/(?:list|board|timeline|attention|archive|plan\/[^/]+\/(?:summary|checklist|decisions|questions|activity))?$/.test(
      route,
    )
  )
    route = '/';
  return '#' + route;
}
