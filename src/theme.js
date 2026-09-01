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

.wrap{display:grid;grid-template-columns:15rem minmax(0,1fr);min-height:100vh}
.sidebar{background:var(--surface);border-right:1px solid var(--line);padding:1.5rem 1rem;overflow-y:auto}
.sidebar .site{font-weight:600;font-size:.95rem;display:block;margin-bottom:1rem;
  color:var(--fg);word-break:break-word;text-decoration:none}
.sidebar ul{list-style:none;margin:0;padding:0}
.sidebar li{margin:.15rem 0}
.sidebar ul ul{margin-left:.75rem;border-left:1px solid var(--line);padding-left:.6rem}
.sidebar a{display:block;padding:.2rem .35rem;border-radius:4px;font-size:.9rem;color:var(--muted);
  text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sidebar a:hover{background:var(--surface-2);color:var(--fg)}
.sidebar a.current{color:var(--fg);font-weight:600;background:var(--surface-2)}
.sidebar .dir{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);
  margin:.9rem 0 .25rem;font-weight:600}

main{min-width:0;padding:2.5rem 3rem 6rem;max-width:52rem}
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

/* ---- controls -------------------------------------------------------------
   One button system, one height, laid out by flex gap. A global
   button rule setting margin-left pushed every button half a space to the
   right wherever it appeared, which is what made the dashboard look
   misaligned; spacing belongs to the container now. */
.btn,button,.cta,.button{
  display:inline-flex;align-items:center;justify-content:center;gap:.4rem;
  height:2.1rem;padding:0 .85rem;margin:0;
  border:1px solid var(--fg);border-radius:7px;
  background:var(--accent);color:var(--on-accent);
  font:inherit;font-size:.875rem;font-weight:600;line-height:1;
  white-space:nowrap;cursor:pointer;text-decoration:none}
.btn:hover,button:hover,.cta:hover,.button:hover{opacity:.85;text-decoration:none}
.btn-quiet,.cta.ghost,button.danger{
  background:none;color:var(--fg);border-color:var(--line-strong);font-weight:500}
.btn-quiet:hover,button.danger:hover{border-color:var(--fg);opacity:1}
.btn-sm{height:1.85rem;padding:0 .65rem;font-size:.8rem}
:focus-visible{outline:2px solid var(--fg);outline-offset:2px;border-radius:4px}

.actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
form.inline{display:inline-flex;margin:0}

/* ---- fields --------------------------------------------------------------- */
.field{display:flex;flex-direction:column;gap:.3rem;min-width:0}
.field > span{font-size:.75rem;color:var(--muted)}
input[type=text],input[type=password],input:not([type]){
  font:inherit;font-size:.875rem;height:2.1rem;padding:0 .6rem;
  border:1px solid var(--line-strong);border-radius:7px;
  background:var(--bg);color:var(--fg);min-width:0;width:100%}
input:focus{outline:2px solid var(--fg);outline-offset:-1px;border-color:var(--fg)}
label.opt{display:inline-flex;align-items:center;gap:.4rem;
  font-size:.85rem;color:var(--muted);cursor:pointer}
label.opt input{width:auto;height:auto}

textarea{width:100%;display:block;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:.875rem;line-height:1.65;padding:1rem;
  border:1px solid var(--line-strong);border-radius:9px;
  background:var(--surface);color:var(--fg);resize:vertical;tab-size:2}
textarea:focus{outline:2px solid var(--fg);outline-offset:-1px}

/* ---- dashboard ------------------------------------------------------------
   Cards rather than one wide table: each site carries a name, a state, a few
   numbers and its own controls, and a table row cannot hold controls without
   the columns fighting each other. */
.summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem 1.25rem;
  padding-bottom:1.25rem;border-bottom:1px solid var(--line);margin-bottom:2rem}
.summary .host{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:1.05rem;color:var(--fg);text-decoration:none}
.summary .host:hover{text-decoration:underline}
.summary .stat{font-size:.85rem;color:var(--muted);font-variant-numeric:tabular-nums}

.meter{height:4px;background:var(--surface-2);border-radius:2px;overflow:hidden;
  width:100%;max-width:14rem}
.meter-fill{height:100%;background:var(--fg)}

.section{margin:2.5rem 0 0}
.section-head{display:flex;align-items:center;justify-content:space-between;
  gap:1rem;margin-bottom:.9rem}
.section-head h2{margin:0;padding:0;border:0;font-size:1.05rem}

.cards{display:flex;flex-direction:column;gap:.6rem}
.card{border:1px solid var(--line);border-radius:10px;padding:.9rem 1rem;
  background:var(--bg)}
.card-top{display:flex;align-items:flex-start;justify-content:space-between;
  gap:1rem;flex-wrap:wrap}
.card-id{display:flex;flex-direction:column;gap:.25rem;min-width:0}
.card-id .name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:.95rem;font-weight:600;color:var(--fg);text-decoration:none}
.card-id .name:hover{text-decoration:underline}
.card-facts{display:flex;gap:.9rem;flex-wrap:wrap;font-size:.8rem;
  color:var(--muted);font-variant-numeric:tabular-nums}

/* State reads as shape, not hue: the palette is monochrome, so a filled pill
   means listed, an outline means unlisted, and a dot marks a password. */
.pill{display:inline-flex;align-items:center;gap:.35rem;
  padding:.15rem .5rem;border-radius:999px;border:1px solid var(--line-strong);
  font-size:.72rem;letter-spacing:.03em;text-transform:uppercase;
  color:var(--muted);white-space:nowrap}
.pill.listed{background:var(--fg);border-color:var(--fg);color:var(--on-accent)}
.pill .dot{width:5px;height:5px;border-radius:50%;background:currentColor}

.disclose{margin-top:.85rem;border-top:1px solid var(--line);padding-top:.85rem}
.disclose[open]{margin-bottom:.15rem}
.disclose summary{font-size:.82rem;color:var(--muted);cursor:pointer;
  list-style:none;display:inline-flex;align-items:center;gap:.35rem}
.disclose summary::-webkit-details-marker{display:none}
.disclose summary::before{content:"+";font-family:ui-monospace,monospace}
.disclose[open] summary::before{content:"−"}
.disclose summary:hover{color:var(--fg)}
.access{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));
  gap:.75rem;margin:.9rem 0 0;align-items:end}
.access .full{grid-column:1/-1;display:flex;gap:.75rem;flex-wrap:wrap;align-items:center}
.choices{display:flex;gap:1rem;flex-wrap:wrap}

.rows{display:flex;flex-direction:column;gap:0;
  border:1px solid var(--line);border-radius:10px;overflow:hidden}
.row{display:flex;align-items:center;justify-content:space-between;gap:1rem;
  padding:.7rem 1rem;flex-wrap:wrap}
.row + .row{border-top:1px solid var(--line)}
.row .id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}
.row .meta{font-size:.78rem;color:var(--muted);font-variant-numeric:tabular-nums}
.row.gone .id,.row.gone .meta{color:var(--faint);text-decoration:line-through}

.callout{border:1px solid var(--fg);border-radius:10px;padding:1rem 1.15rem;margin:1.5rem 0}
.callout pre{margin:.75rem 0 0}
.empty{border:1px dashed var(--line-strong);border-radius:10px;
  padding:1.5rem;color:var(--muted);font-size:.9rem}
.empty pre{margin:.85rem 0 0}

.filetabs{display:flex;gap:.4rem;flex-wrap:wrap;margin:1.25rem 0 .75rem}
.filetabs a{font-size:.8rem;font-family:ui-monospace,Menlo,monospace;
  padding:.3rem .6rem;border:1px solid var(--line);border-radius:6px;
  color:var(--muted);text-decoration:none}
.filetabs a:hover{color:var(--fg);border-color:var(--line-strong)}
.filetabs a.current{color:var(--fg);border-color:var(--fg)}

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
ul.sites{list-style:none;padding:0;margin:2rem 0}
ul.sites li{margin:.6rem 0}

@media (max-width:820px){
  .wrap{grid-template-columns:1fr}
  .sidebar{border-right:0;border-bottom:1px solid var(--line);max-height:14rem;padding:1rem}
  main{padding:1.5rem 1.25rem 4rem}
  .center{padding:3rem 1.25rem}
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
 * Render the sidebar from the site's markdown files, grouped by directory.
 * @param {string[]} paths   markdown paths relative to the site root
 * @param {string} siteRoot  e.g. "/handbook"
 * @param {string} current   the path currently being viewed
 */
function navHtml(paths, siteRoot, current) {
  if (paths.length <= 1) return '';
  const groups = new Map();
  for (const p of paths) {
    const slash = p.lastIndexOf('/');
    const dir = slash === -1 ? '' : p.slice(0, slash);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(p);
  }
  const dirs = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));

  let out = '';
  for (const dir of dirs) {
    if (dir !== '') out += `<div class="dir">${escapeHtml(dir)}</div>`;
    out += '<ul>';
    for (const p of groups.get(dir).sort(byIndexFirst)) {
      const href = `${siteRoot}/${p.replace(/\.(md|markdown)$/i, '')}`.replace(/\/(index|readme)$/i, '/');
      const label = p.slice(dir === '' ? 0 : dir.length + 1).replace(/\.(md|markdown)$/i, '');
      const cls = p === current ? ' class="current"' : '';
      out += `<li><a href="${escapeHtml(href)}"${cls}>${escapeHtml(label)}</a></li>`;
    }
    out += '</ul>';
  }
  return out;
}

const byIndexFirst = (a, b) => {
  const rank = (p) => (/(^|\/)(index|readme)\.(md|markdown)$/i.test(p) ? 0 : 1);
  return rank(a) - rank(b) || a.localeCompare(b);
};

export function docPage({ title, contentHtml, siteRoot, siteLabel, docPaths, currentPath, rawHref, canonical, rootDomain }) {
  const nav = navHtml(docPaths, siteRoot, currentPath);
  const body = `<div class="wrap">
<aside class="sidebar">
  <a class="site" href="${escapeHtml(siteRoot)}/">${escapeHtml(siteLabel)}</a>
  ${nav}
</aside>
<main>
${contentHtml}
<div class="footer">
  <a href="${escapeHtml(rawHref)}">view source</a>
  <span>served by <a href="https://${escapeHtml(rootDomain)}/">${escapeHtml(rootDomain)}</a></span>
</div>
</main>
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
