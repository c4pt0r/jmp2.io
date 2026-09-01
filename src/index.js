import { handleApi } from './api.js';
import { handleAuth } from './oauth.js';
import { handleAccount } from './account.js';
import { serveTenant } from './serve.js';
import { landingPage, messagePage } from './theme.js';
import { renderMarkdown } from './render.js';
import { llmsTxt, skillBody, skillMarkdown, openApi } from './skill.js';
import { CLI_SOURCE, DEFAULT_API_HOST } from './cli.js';
import { RESERVED_SUBDOMAINS, err, isValidTenantId } from './util.js';

/**
 * Split a request host into (apex | tenant | unknown).
 *
 * `<tenant>.localhost` is treated like a tenant of the real domain so the whole
 * routing shape can be exercised under `wrangler dev` with a Host header.
 */
export function classifyHost(hostname, rootDomain) {
  const host = hostname.toLowerCase().split(':')[0];
  for (const root of [rootDomain, 'localhost', '127.0.0.1']) {
    if (host === root || host === `www.${root}`) return { kind: 'apex' };
    if (host.endsWith(`.${root}`)) {
      const label = host.slice(0, -(root.length + 1));
      if (label.includes('.')) return { kind: 'unknown' }; // deeper than the wildcard cert covers
      if (RESERVED_SUBDOMAINS.has(label)) return { kind: 'unknown' };
      if (!isValidTenantId(label)) return { kind: 'unknown' };
      return { kind: 'tenant', tenant: label };
    }
  }
  return { kind: 'unknown' };
}

const TEXT_CACHE = 'public, max-age=300';

/**
 * The landing page and its machine-readable siblings, all from one document.
 * `/skill.md` is served verbatim so it can be curled straight into
 * `~/.claude/skills/jmp2/SKILL.md`.
 */
function docsRoute(request, env, pathname) {
  if (pathname === '/') {
    // Rendered by the same pipeline that serves user sites: the front page is
    // also the clearest demo of what the renderer does.
    const { html } = renderMarkdown(skillBody(env.ROOT_DOMAIN), '');
    return landingPage(env.ROOT_DOMAIN, html);
  }
  if (pathname === '/skill.md' || pathname === '/SKILL.md') {
    return new Response(skillMarkdown(env.ROOT_DOMAIN), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': TEXT_CACHE,
        'x-content-type-options': 'nosniff',
      },
    });
  }
  if (pathname === '/cli' || pathname === '/jmp2') {
    // Served for download rather than piping into a shell: `curl … -o` then
    // `chmod +x` lets people read what they are about to run.
    // Rewrite the compiled-in default so a client installed from this
    // deployment talks to this deployment, not to wherever it was built.
    return new Response(CLI_SOURCE.replaceAll(DEFAULT_API_HOST, env.ROOT_DOMAIN), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': TEXT_CACHE,
        'x-content-type-options': 'nosniff',
      },
    });
  }
  if (pathname === '/llms.txt') {
    return new Response(llmsTxt(env.ROOT_DOMAIN), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': TEXT_CACHE,
        'x-content-type-options': 'nosniff',
      },
    });
  }
  if (pathname === '/openapi.json') {
    return new Response(JSON.stringify(openApi(env.ROOT_DOMAIN), null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': TEXT_CACHE,
        'access-control-allow-origin': '*',
      },
    });
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApi = url.pathname === '/_api' || url.pathname.startsWith('/_api/');

    try {
      const host = classifyHost(url.hostname, env.ROOT_DOMAIN);

      if (host.kind === 'apex') {
        if (isApi) return await handleApi(request, env, ctx, url.pathname);
        const auth = await handleAuth(request, env, url.pathname);
        if (auth) return auth;
        const account = await handleAccount(request, env, url.pathname);
        if (account) return account;
        const doc = docsRoute(request, env, url.pathname);
        if (doc) return doc;
        return messagePage({
          status: 404, heading: 'Not found',
          message: 'Sites live on tenant subdomains, not on the apex.',
          links: [{ href: '/', text: env.ROOT_DOMAIN }],
        });
      }

      if (host.kind === 'tenant') {
        if (isApi) {
          return err(400, `use https://${env.ROOT_DOMAIN}/_api/ for writes`);
        }
        if (!['GET', 'HEAD'].includes(request.method)) {
          return err(405, 'tenant subdomains are read-only');
        }
        return await serveTenant(request, env, ctx, host.tenant);
      }

      return messagePage({
        status: 404, heading: 'Not found',
        message: 'This hostname is not served by jmp2.',
        links: [{ href: `https://${env.ROOT_DOMAIN}/`, text: env.ROOT_DOMAIN }],
      });
    } catch (e) {
      console.error('unhandled', url.pathname, e?.stack || e);
      return isApi
        ? err(500, 'internal error')
        : messagePage({ status: 500, heading: 'Something broke', message: 'Try again shortly.' });
    }
  },
};
