import { escapeHtml } from './util.js';

/**
 * The only script on any page: it applies the saved theme before first paint
 * and handles the toggle. It is pinned by hash in the CSP, so this exact source
 * is the only script that can ever execute — an injected `<script>` has a
 * different hash and is still blocked, which keeps almost all of the value of
 * `script-src 'none'` while allowing a real toggle.
 *
 * THEME_SCRIPT_SHA256 must match this string; a unit test enforces that.
 */
export const THEME_SCRIPT = `(function(){var K='jmp2-theme',R=document.documentElement;try{var t=localStorage.getItem(K);if(t)R.setAttribute('data-theme',t)}catch(e){}document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('[data-theme-toggle]');if(!b)return;var c=R.getAttribute('data-theme')||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var n=c==='dark'?'light':'dark';R.setAttribute('data-theme',n);try{localStorage.setItem(K,n)}catch(e){}})})();`;

export const THEME_SCRIPT_SHA256 = 'sha256-RMn5pnuVZG6C5CKNeEI5SXgnNlcogKou6yzzDULoiNA=';

/**
 * No external anything. Scripts are limited to the one hash above, so a page of
 * user-supplied markdown still cannot run code even if escaping ever failed.
 * Remote images are allowed because docs commonly hotlink badges and diagrams.
 */
export const CSP = [
  "default-src 'none'",
  "img-src 'self' data: https:",
  "media-src 'self'",
  "font-src 'self'",
  "style-src 'unsafe-inline'",
  `script-src '${THEME_SCRIPT_SHA256}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Pages with a form need `form-action`, which the document CSP forbids on
 * purpose. Kept separate so relaxing it can never leak onto rendered user
 * content, which is where the risk actually lives.
 */
export const CSP_FORM = CSP.replace("form-action 'none'", "form-action 'self'");

/**
 * Monochrome throughout. With no hue to carry meaning, links are underlined
 * rather than coloured — in a grey palette colour alone could not distinguish
 * them, and dropping the underline would leave nothing at all.
 *
 * Light is defined on bare `:root` so it is the fallback everywhere. Dark is
 * declared twice: once for the system preference (skipped when the reader has
 * explicitly chosen light) and once for an explicit choice, so the toggle wins
 * in both directions.
 */
const TOKENS = `
:root{
  --bg:#ffffff; --fg:#16181a; --muted:#6b7076; --faint:#8b9096;
  --line:#e3e5e8; --line-strong:#c8ccd0;
  --surface:#f6f7f8; --surface-2:#eceef0;
  --accent:#16181a; --on-accent:#ffffff;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#0d0e10; --fg:#e8eaec; --muted:#9aa0a6; --faint:#787e84;
    --line:#26292d; --line-strong:#3a3e43;
    --surface:#16181b; --surface-2:#1e2124;
    --accent:#e8eaec; --on-accent:#0d0e10;
  }
}
:root[data-theme="dark"]{
  --bg:#0d0e10; --fg:#e8eaec; --muted:#9aa0a6; --faint:#787e84;
  --line:#26292d; --line-strong:#3a3e43;
  --surface:#16181b; --surface-2:#1e2124;
  --accent:#e8eaec; --on-accent:#0d0e10;
}
`;

const CSS = `${TOKENS}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
a{color:var(--fg);text-decoration:underline;text-underline-offset:.18em;
  text-decoration-color:var(--line-strong)}
a:hover{text-decoration-color:var(--fg)}

.theme-toggle{position:fixed;top:.9rem;right:.9rem;z-index:10;
  width:2rem;height:2rem;padding:0;border:1px solid var(--line);border-radius:50%;
  background:var(--bg);color:var(--muted);font-size:.8rem;line-height:1;margin:0;
  cursor:pointer;display:flex;align-items:center;justify-content:center}
.theme-toggle:hover{color:var(--fg);border-color:var(--line-strong);opacity:1}
.theme-toggle .in-dark{display:none}
:root[data-theme="dark"] .theme-toggle .in-dark{display:inline}
:root[data-theme="dark"] .theme-toggle .in-light{display:none}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]) .theme-toggle .in-dark{display:inline}
  :root:not([data-theme="light"]) .theme-toggle .in-light{display:none}
}

/* Article layout: one centred column, with a rail of navigation floated into
   the margin. The rail is decoration on a wide screen and noise on a narrow
   one, so below 1280px it collapses into a plain block above the article
   rather than competing with the text. */
.page{display:flex;justify-content:center;padding:3rem 1.25rem 6rem}
.col{width:100%;max-width:44rem;min-width:0}

.rail{position:fixed;transform:translateX(-16rem);width:14rem;
  max-height:calc(100vh - 8rem);overflow-y:auto;font-size:.85rem}
.rail .up{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);
  text-decoration:none;display:inline-block;margin-bottom:1.5rem}
.rail .up:hover{color:var(--fg)}
.rail nav{margin-bottom:1.75rem}
.rail .label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;
  color:var(--faint);margin-bottom:.5rem}
.rail ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.4rem}
.rail a{color:var(--muted);text-decoration:none;display:block;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail a:hover{color:var(--fg)}
.rail a.current{color:var(--fg)}
.rail .d2{padding-left:.85rem}
.rail .d3{padding-left:1.7rem}
.up-inline{display:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--muted);text-decoration:none}

.doc-title{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:1.6rem;line-height:1.3;font-weight:600;margin:0;letter-spacing:-.01em}
.doc-meta{color:var(--muted);font-size:.85rem;margin:.5rem 0 2.5rem;
  display:flex;gap:.75rem;flex-wrap:wrap}

main{min-width:0}
main>*:first-child{margin-top:0}
h1,h2,h3,h4{line-height:1.3;margin:2.25rem 0 .75rem;font-weight:650;letter-spacing:-.01em}
h1{font-size:1.9rem;margin-top:0}
h2{font-size:1.35rem;padding-bottom:.35rem;border-bottom:1px solid var(--line)}
h3{font-size:1.1rem}
h1 .anchor,h2 .anchor,h3 .anchor,h4 .anchor{
  float:left;margin-left:-1em;width:1em;color:var(--faint);opacity:0;
  font-weight:400;text-decoration:none}
h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{opacity:1}
p,ul,ol,blockquote,table,pre{margin:0 0 1rem}
li{margin:.2rem 0}
img{max-width:100%;height:auto;border-radius:6px}
blockquote{border-left:2px solid var(--line-strong);padding:.1rem 0 .1rem 1rem;
  color:var(--muted);margin-left:0}
code{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:.875em}
:not(pre)>code{background:var(--surface-2);padding:.15em .4em;border-radius:4px}
pre{background:var(--surface);border:1px solid var(--line);border-radius:8px;
  padding:1rem;overflow-x:auto;line-height:1.55}
pre code{background:none;padding:0}
table{border-collapse:collapse;display:block;overflow-x:auto;width:100%;font-size:.95rem}
th,td{border:1px solid var(--line);padding:.45rem .7rem;text-align:left;vertical-align:top}
th{background:var(--surface);font-weight:600}
hr{border:0;border-top:1px solid var(--line);margin:2.5rem 0}
mark{background:var(--surface-2);color:inherit}
.footer{margin-top:4rem;padding-top:1rem;border-top:1px solid var(--line);
  color:var(--muted);font-size:.8rem;display:flex;gap:1rem;flex-wrap:wrap}

.center{max-width:42rem;margin:0 auto;padding:4rem 1.5rem}
.center.wide{max-width:52rem}
.center h1{font-size:2.1rem}
.lede{color:var(--muted);font-size:1.05rem}
.sub{color:var(--muted);font-size:.85rem}
.fine{color:var(--faint);font-size:.85rem}

form{margin:1.5rem 0}
label{display:inline-flex;align-items:center;gap:.25rem;border:1px solid var(--line-strong);
  border-radius:8px;padding:.15rem .6rem .15rem .15rem;background:var(--bg)}
label input{border:0;outline:0;background:none;color:var(--fg);font:inherit;
  padding:.55rem .6rem;min-width:12rem}
.suffix{color:var(--muted)}
button,.button,.cta{display:inline-block;padding:.6rem 1.1rem;border:1px solid var(--fg);
  border-radius:8px;background:var(--accent);color:var(--on-accent);
  font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button{margin-left:.5rem}
button:hover,.button:hover,.cta:hover{opacity:.85;text-decoration:none}
.cta.ghost{background:none;color:var(--fg);border-color:var(--line-strong)}
.inline{display:inline-block;margin:.5rem .5rem .5rem 0}
.inline button{margin-left:0}
button.danger{background:none;color:var(--muted);border-color:var(--line);
  padding:.3rem .7rem;font-size:.85rem;font-weight:500}
button.danger:hover{color:var(--fg);border-color:var(--fg);opacity:1}
.error{font-weight:600;border-left:3px solid var(--fg);padding-left:.75rem}
.meter{height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden;margin:1.5rem 0 .35rem}
.meter-fill{height:100%;background:var(--fg)}
.callout{border:1px solid var(--line-strong);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0}
.callout pre{margin:.75rem 0 0}
.hero{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center;margin:2.5rem 0}
.hero.top{margin:1.25rem 0 2.5rem}
textarea{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:.875rem;line-height:1.6;padding:1rem;border:1px solid var(--line-strong);
  border-radius:8px;background:var(--surface);color:var(--fg);resize:vertical;
  tab-size:2}
textarea:focus{outline:2px solid var(--fg);outline-offset:-1px}
.filetabs{display:flex;gap:.5rem;flex-wrap:wrap;margin:1.25rem 0 .75rem}
.filetabs a{font-size:.82rem;font-family:ui-monospace,Menlo,monospace;
  padding:.25rem .6rem;border:1px solid var(--line);border-radius:6px;
  color:var(--muted);text-decoration:none}
.filetabs a:hover{color:var(--fg);border-color:var(--line-strong)}
.filetabs a.current{color:var(--fg);border-color:var(--fg)}
details{margin:0}
summary{cursor:pointer}
form.access{margin:.75rem 0 .25rem;display:flex;flex-direction:column;gap:.5rem;
  align-items:flex-start}
form.access .fields{display:flex;gap:.5rem;flex-wrap:wrap}
form.access input[type=text],form.access input[name=auth_user],form.access input[type=password]{
  font:inherit;font-size:.85rem;padding:.35rem .55rem;border:1px solid var(--line-strong);
  border-radius:6px;background:var(--bg);color:var(--fg)}
label.radio{display:inline-flex;align-items:center;gap:.35rem;border:0;padding:0;
  font-size:.85rem;color:var(--muted)}
form.access button{margin-left:0;padding:.35rem .8rem;font-size:.85rem}
.tag{display:inline-block;padding:.1rem .45rem;border:1px solid var(--line-strong);
  border-radius:4px;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;
  color:var(--muted);white-space:nowrap}
.tag.on{border-color:var(--fg);color:var(--fg)}
ul.sites{list-style:none;padding:0;margin:2rem 0}
ul.sites li{margin:.6rem 0}

@media (max-width:1279px){
  .rail{position:static;transform:none;width:auto;max-height:none;
    margin:0 0 2.5rem;padding-bottom:1.5rem;border-bottom:1px solid var(--line)}
  .rail .up{display:none}
  .up-inline{display:inline-block;margin-bottom:1.5rem}
}
@media (max-width:820px){
  .page{padding:2rem 1.1rem 4rem}
  .center{padding:3rem 1.25rem}
  .doc-title{font-size:1.35rem}
}
`;

/**
 * A fingerprint of everything the shell contributes to a rendered page.
 *
 * Rendered pages are cached at the edge under a key qualified by the site's
 * content version — which does not change when the code does. Without this,
 * a deploy that alters the CSS, the CSP or the shell would keep serving the
 * previous markup until the cache expired. Mixing this in means a redeploy
 * invalidates rendered HTML automatically, with no purge and no manual bump.
 */
export const RENDER_VERSION = (() => {
  let h = 0x811c9dc5;
  for (const s of [CSS, CSP, CSP_FORM, THEME_SCRIPT]) {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(36);
})();

const TOGGLE = `<button class="theme-toggle" data-theme-toggle type="button" aria-label="Toggle light and dark theme" title="Toggle theme"><span class="in-light">●</span><span class="in-dark">○</span></button>`;

function shell({ title, bodyHtml, canonical }) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:type" content="article">
<style>${CSS}</style>
<script>${THEME_SCRIPT}</script>
${TOGGLE}
${bodyHtml}
</html>`;
}

/**
 * The other documents in this site, for the rail. Omitted for a one-page site,
 * where a list of one link is only clutter.
 */
function pagesNav(paths, siteRoot, current) {
  if (paths.length <= 1) return '';
  const items = paths.sort(byIndexFirst).map((p) => {
    const href = `${siteRoot}/${p.replace(/\.(md|markdown)$/i, '')}`
      .replace(/\/(index|readme)$/i, '/');
    const label = p.replace(/\.(md|markdown)$/i, '');
    return `<li><a href="${escapeHtml(href)}"${p === current ? ' class="current"' : ''}>${escapeHtml(label)}</a></li>`;
  }).join('');
  return `<nav><div class="label">Pages</div><ul>${items}</ul></nav>`;
}

/**
 * This document's own outline. h1 is the title, already shown above the article,
 * and anything past h3 is too fine-grained to help navigate.
 */
function outlineNav(headings) {
  const shown = headings.filter((h) => h.depth >= 2 && h.depth <= 3);
  if (shown.length < 2) return '';
  const items = shown.map((h) =>
    `<li class="d${h.depth}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`).join('');
  return `<nav><div class="label">Contents</div><ul>${items}</ul></nav>`;
}

const byIndexFirst = (a, b) => {
  const rank = (p) => (/(^|\/)(index|readme)\.(md|markdown)$/i.test(p) ? 0 : 1);
  return rank(a) - rank(b) || a.localeCompare(b);
};

const isoDate = (seconds) =>
  seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : '';

export function docPage({
  title, contentHtml, siteRoot, siteLabel, docPaths, currentPath, rawHref,
  canonical, rootDomain, headings = [], updatedAt,
}) {
  const rail = `${pagesNav(docPaths, siteRoot, currentPath)}${outlineNav(headings)}`;
  const updated = isoDate(updatedAt);

  const body = `<div class="page">
<div class="col">
<aside class="rail">
  <a class="up" href="${escapeHtml(siteRoot)}/">../</a>
  ${rail}
</aside>
<a class="up-inline" href="${escapeHtml(siteRoot)}/">../</a>
<main>
<div class="doc-title">${escapeHtml(siteLabel)}</div>
<div class="doc-meta">
  ${updated ? `<time datetime="${escapeHtml(updated)}">${escapeHtml(updated)}</time>` : ''}
  <a href="${escapeHtml(rawHref)}">source</a>
  <span>on <a href="https://${escapeHtml(rootDomain)}/">${escapeHtml(rootDomain)}</a></span>
</div>
${contentHtml}
</main>
</div>
</div>`;
  return shell({ title, bodyHtml: body, canonical });
}

/** Shell for the signup and dashboard pages: same look, plus a form CSP. */
export function authPage({ status = 200, title, heading, bodyHtml, headers = {}, wide = false, rootDomain = '' }) {
  const body = `<div class="center${wide ? ' wide' : ''}">
<h1>${escapeHtml(heading)}</h1>
${bodyHtml}
<div class="footer"><a href="/">${escapeHtml(rootDomain || 'home')}</a></div>
</div>`;
  return new Response(shell({ title, bodyHtml: body }), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP_FORM, ...headers },
  });
}

/** A centered page with the strict content CSP: no forms, one pinned script. */
export function plainPage({ status = 200, title, heading, bodyHtml, headers = {} }) {
  const body = `<div class="center">
<h1>${escapeHtml(heading)}</h1>
${bodyHtml}
</div>`;
  return new Response(shell({ title, bodyHtml: body }), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, ...headers },
  });
}

export function messagePage({ status, heading, message, links = [] }) {
  const body = `<div class="center">
<h1>${escapeHtml(heading)}</h1>
<p class="lede">${escapeHtml(message)}</p>
${links.length ? `<p>${links.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.text)}</a>`).join(' · ')}</p>` : ''}
</div>`;
  return new Response(shell({ title: `${status} ${heading}`, bodyHtml: body }), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP },
  });
}

/**
 * The landing page is the skill document rendered through the same markdown
 * pipeline that serves every user site — so it documents the product and
 * demonstrates it at the same time.
 */
export function landingPage(rootDomain, contentHtml) {
  const hero = `<div class="hero top">
  <a class="cta" href="/signup">Get a subdomain</a>
  <a class="cta ghost" href="/skill.md">Raw skill</a>
  <a class="cta ghost" href="/openapi.json">OpenAPI</a>
  <a class="cta ghost" href="/cli">CLI</a>
</div>`;

  // The calls to action belong directly under the title, above the reference
  // material: the first thing a visitor needs is a way in. The document is
  // rendered markdown, so the insertion point is its opening heading.
  const closing = contentHtml.indexOf('</h1>');
  const withHero = closing === -1
    ? hero + contentHtml
    : contentHtml.slice(0, closing + 5) + hero + contentHtml.slice(closing + 5);

  const body = `<div class="center wide">
${withHero}
<div class="footer">
  <span>One subdomain per GitHub account.</span>
  <a href="/account">Dashboard</a>
  <a href="/llms.txt">llms.txt</a>
</div>
</div>`;
  return new Response(shell({ title: rootDomain, bodyHtml: body }), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP },
  });
}
