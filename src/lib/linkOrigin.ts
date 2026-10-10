/**
 * The base every outbound link is built on — approval links in denials,
 * list_accounts' delegation links, reconnect and dashboard pointers.
 *
 * Those links were built on DASHBOARD_URL (NEXT_PUBLIC_APP_URL, else Vercel's
 * production URL), which on a preview resolves to production: an agent
 * talking to a preview was handed fgac.ai approval links for requests that
 * exist only in the preview's database (hosted-MCP QA regression 2026-10-09).
 *
 * Production keeps the configured URL byte for byte. Everywhere else the link
 * names the host serving the request (set once per request by the route via
 * runWithLinkOrigin), else the deployment's own origin (deploymentOrigin).
 * On Vercel the forwarded host is set by the platform and can only be a host
 * routed to this deployment, so emailed links built on it stay on it too.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { deploymentOrigin } from '@/lib/temporaryApiKeys';

const originStorage = new AsyncLocalStorage<string>();

/** Run `fn` with `origin` as the link base for everything it builds. */
export function runWithLinkOrigin<T>(origin: string, fn: () => T): T {
  return originStorage.run(origin, fn);
}

/** Link base: `configured` in production, the serving host otherwise. */
export function linkBase(
  configured: string,
  env: Record<string, string | undefined> = process.env,
  origin: string | undefined = originStorage.getStore(),
): string {
  if (env.VERCEL_ENV === 'production') return configured;
  return (origin ?? deploymentOrigin(env)).trim().replace(/\/+$/, '');
}
