import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, rewriteHref, splitFrontmatter } from '../src/render.js';

const R = '/handbook';

test('rewriteHref leaves anchors and safe external links alone', () => {
  assert.equal(rewriteHref('#intro', R, true), '#intro');
  assert.equal(rewriteHref('https://example.com/x', R, true), 'https://example.com/x');
  assert.equal(rewriteHref('mailto:a@b.c', R, true), 'mailto:a@b.c');
});

test('rewriteHref blocks dangerous schemes', () => {
  for (const bad of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>',
    'vbscript:x', '//evil.com/x',
  ]) {
    assert.equal(rewriteHref(bad, R, true), '#', `should block ${bad}`);
  }
});

test('rewriteHref drops .md so relative resolution works', () => {
  assert.equal(rewriteHref('./api.md', R, true), './api');
  assert.equal(rewriteHref('api.md', R, true), 'api');
  assert.equal(rewriteHref('../other/x.md', R, true), '../other/x');
  assert.equal(rewriteHref('api.md#auth', R, true), 'api#auth');
});

test('rewriteHref maps index/README to their directory', () => {
  assert.equal(rewriteHref('README.md', R, true), './');
  assert.equal(rewriteHref('./index.md', R, true), './');
  assert.equal(rewriteHref('docs/index.md', R, true), 'docs/');
});

test('rewriteHref prefixes the site root onto root-relative links', () => {
  assert.equal(rewriteHref('/img/a.png', R, false), '/handbook/img/a.png');
  assert.equal(rewriteHref('/docs/api.md', R, true), '/handbook/docs/api');
});

test('rewriteHref keeps image extensions', () => {
  assert.equal(rewriteHref('./img/a.png', R, false), './img/a.png');
});

test('raw HTML in markdown is escaped, not passed through', () => {
  const { html } = renderMarkdown('<img src=x onerror=alert(1)>\n\nhi <b>x</b>\n', R);
  // The payload text may survive as inert escaped text; what must not survive
  // is a real tag, so assert on the markup rather than on the substring.
  assert.ok(!/<img[^>]*onerror/i.test(html), 'must not emit a live img tag');
  assert.ok(!/<b>/i.test(html), 'must not emit a live inline tag');
  assert.ok(html.includes('&lt;img'), 'raw block HTML should be escaped');
  assert.ok(html.includes('&lt;b&gt;'), 'raw inline HTML should be escaped');
});

test('javascript: links in markdown are neutralized', () => {
  const { html } = renderMarkdown('[click](javascript:alert(1))', R);
  assert.ok(!/href="javascript/i.test(html));
  assert.ok(html.includes('href="#"'));
});

test('headings get stable unique ids and feed the outline', () => {
  const { html, headings } = renderMarkdown('# Intro\n\n## Setup\n\n## Setup\n', R);
  assert.deepEqual(headings.map((h) => h.id), ['intro', 'setup', 'setup-1']);
  assert.ok(html.includes('id="intro"'));
});

test('title comes from frontmatter, else first h1', () => {
  assert.equal(renderMarkdown('---\ntitle: Custom\n---\n# Other\n', R).title, 'Custom');
  assert.equal(renderMarkdown('# Other\n', R).title, 'Other');
  assert.equal(renderMarkdown('just text\n', R).title, null);
});

test('frontmatter is stripped from the body', () => {
  const { body, meta } = splitFrontmatter('---\ntitle: X\nfoo: bar\n---\n# H\n');
  assert.equal(body, '# H\n');
  assert.deepEqual(meta, { title: 'X', foo: 'bar' });
  const { html } = renderMarkdown('---\ntitle: X\n---\n# H\n', R);
  assert.ok(!html.includes('title: X'));
});

test('code blocks escape their contents', () => {
  const { html } = renderMarkdown('```js\nconst x = "<script>";\n```\n', R);
  assert.ok(html.includes('class="language-js"'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('gfm tables render', () => {
  const { html } = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n', R);
  assert.ok(html.includes('<table>'));
});
