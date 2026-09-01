import { Marked } from 'marked';
import { escapeHtml } from './util.js';

/** Strip a leading YAML-ish frontmatter block and pull out flat `key: value` pairs. */
export function splitFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: src.slice(m[0].length) };
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME = /^(https?|mailto):/i;
const MD_EXT = /\.(md|markdown)$/i;

/**
 * Rewrite a link found in markdown so it resolves under the site's mount point.
 *
 * Document URLs drop the `.md` extension, so a doc at `docs/guide.md` is served
 * at `/<slug>/docs/guide`. Relative links then resolve correctly with no work:
 * `./api.md` -> `api` -> `/<slug>/docs/api`. Two cases do need work:
 *   - root-relative links (`/img/a.png`) would escape the site, so they get the
 *     site root prefixed;
 *   - `index.md` / `README.md` map to their directory, not a bare name.
 *
 * @param {string} href     raw href from the markdown source
 * @param {string} siteRoot mount point, e.g. "/handbook" (no trailing slash)
 * @param {boolean} stripMd whether `.md` should be dropped (true for links, false for images)
 */
export function rewriteHref(href, siteRoot, stripMd) {
  if (!href) return '#';
  const raw = href.trim();
  if (raw.startsWith('#')) return raw;
  if (raw.startsWith('//')) return '#';
  if (HAS_SCHEME.test(raw)) return SAFE_SCHEME.test(raw) ? raw : '#';

  const m = /^([^?#]*)([?#][\s\S]*)?$/.exec(raw);
  let path = m[1];
  const tail = m[2] || '';
  if (path.startsWith('/')) path = siteRoot + path;
  if (stripMd && MD_EXT.test(path)) {
    path = path.replace(MD_EXT, '').replace(/(^|\/)(index|readme)$/i, '$1');
    if (path === '') path = './';
  }
  return (path + tail) || './';
}

export const slugifyHeading = (text) =>
  text.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

/**
 * Render markdown to HTML for a document mounted at `siteRoot`.
 * Raw HTML in the source is escaped rather than passed through: this is the
 * XSS boundary, and v0 buys safety at the cost of embedded HTML.
 *
 * @returns {{html: string, title: string|null, headings: Array<{depth:number,id:string,text:string}>}}
 */
export function renderMarkdown(source, siteRoot) {
  const { meta, body } = splitFrontmatter(source);
  const headings = [];
  const seenIds = new Map();
  let firstH1 = null;

  const marked = new Marked({ gfm: true, breaks: false, async: false });

  marked.use({
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      link({ href, title, tokens }) {
        const url = rewriteHref(href, siteRoot, true);
        const text = this.parser.parseInline(tokens);
        const external = SAFE_SCHEME.test(url);
        const attrs = [
          `href="${escapeHtml(url)}"`,
          title ? `title="${escapeHtml(title)}"` : '',
          external ? 'target="_blank" rel="noopener noreferrer nofollow"' : '',
        ].filter(Boolean).join(' ');
        return `<a ${attrs}>${text}</a>`;
      },
      image({ href, title, text }) {
        const url = rewriteHref(href, siteRoot, false);
        const attrs = [
          `src="${escapeHtml(url)}"`,
          `alt="${escapeHtml(text || '')}"`,
          title ? `title="${escapeHtml(title)}"` : '',
          'loading="lazy"',
        ].filter(Boolean).join(' ');
        return `<img ${attrs}>`;
      },
      heading({ tokens, depth }) {
        const inline = this.parser.parseInline(tokens);
        const plain = this.parser.parseInline(tokens, this.parser.textRenderer);
        let id = slugifyHeading(plain);
        const n = seenIds.get(id) || 0;
        seenIds.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        headings.push({ depth, id, text: plain });
        if (depth === 1 && firstH1 === null) firstH1 = plain;
        return `<h${depth} id="${escapeHtml(id)}"><a class="anchor" href="#${escapeHtml(id)}" aria-hidden="true">#</a>${inline}</h${depth}>`;
      },
      code({ text, lang }) {
        const cls = lang ? ` class="language-${escapeHtml(lang.split(/\s+/)[0])}"` : '';
        return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`;
      },
    },
  });

  const html = marked.parse(body);
  return { html, title: meta.title || firstH1 || null, headings };
}
