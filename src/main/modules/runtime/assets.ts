import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

export const APP_ORIGIN = 'app://agent-ops';
export const APP_DOCUMENT = APP_ORIGIN + '/index.html';
export const PRODUCTION_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'";
const mime: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
};

/** Freeze an explicit asset map. URLs never become filesystem paths. Symlinks are not bundled assets. */
export async function assetHandler(
  root: string,
): Promise<(request: Request) => Promise<Response>> {
  const canonicalRoot = await realpath(root);
  const files = new Map<string, string>();
  async function scan(dir: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = join(dir, entry.name);
      const key = prefix + '/' + entry.name;
      if (entry.isDirectory()) await scan(file, key);
      else if (entry.isFile()) files.set(key, file);
    }
  }
  await scan(canonicalRoot);
  return async (request) => {
    const headers = {
      'Content-Security-Policy': PRODUCTION_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    };
    const fail = (status: number) => new Response(null, { status, headers });
    try {
      const url = new URL(request.url);
      if (
        url.protocol !== 'app:' ||
        url.host !== 'agent-ops' ||
        url.username ||
        url.password ||
        url.search ||
        !['GET', 'HEAD'].includes(request.method)
      )
        return fail(403);
      const name = decodeURIComponent(url.pathname);
      const file = files.get(name === '/' ? '/index.html' : name);
      if (!file) return fail(404);
      const actual = await realpath(file);
      const rel = relative(canonicalRoot, actual);
      if (rel.startsWith('..') || isAbsolute(rel) || actual !== file)
        return fail(403);
      const extension = name.split('.').at(-1) ?? '';
      const bytes =
        request.method === 'HEAD' ? null : new Uint8Array(await readFile(file));
      return new Response(bytes, {
        headers: {
          ...headers,
          'Content-Type': mime[extension] ?? 'application/octet-stream',
        },
      });
    } catch {
      return fail(404);
    }
  };
}
