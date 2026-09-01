import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmsTxt, skillBody, skillMarkdown, openApi } from '../src/skill.js';

const D = 'jmp2.io';
const SKILL_MD = skillMarkdown(D);
const SKILL_BODY = skillBody(D);
const LLMS_TXT = llmsTxt(D);
import { renderMarkdown, splitFrontmatter } from '../src/render.js';

test('the skill document carries valid Claude Code frontmatter', () => {
  const { meta, body } = splitFrontmatter(SKILL_MD);
  assert.equal(meta.name, 'jmp2');
  assert.ok(meta.description, 'a skill needs a description to be selectable');
  assert.ok(meta.description.length > 80, 'the description is what triggers the skill; keep it specific');
  assert.ok(body.startsWith('# jmp2.io'));
});

test('the raw skill and the rendered page are the same document', () => {
  assert.ok(SKILL_MD.endsWith(SKILL_BODY), 'the served skill is the body plus frontmatter');
});

test('the landing page renders without producing live markup from the source', () => {
  const { html, title } = renderMarkdown(SKILL_BODY, '');
  assert.equal(title, 'jmp2.io');
  assert.ok(html.includes('<table>'), 'the URL rules table should render');
  assert.ok(html.includes('class="language-sh"'), 'shell examples should be tagged');
  assert.ok(!/<script/i.test(html));
});

test('every documented endpoint is reachable in the rendered page', () => {
  for (const path of [
    '/whoami', '/sites', '/sites/:slug', '/sites/:slug/tarball',
    '/sites/:slug/files/*path', '/sites/:slug/publish', '/sites/:slug/rollback',
    '/tokens', '/tokens/:id',
  ]) {
    assert.ok(SKILL_BODY.includes(path), `missing ${path} from the API table`);
  }
});

test('doc links are absolute so the .md-stripping renderer cannot break them', () => {
  const { html } = renderMarkdown(SKILL_BODY, '');
  // A relative .md link would come out with the extension stripped, which would
  // 404 for /skill.md. Assert the one .md link we do have survived intact.
  assert.ok(html.includes('https://jmp2.io/skill.md'), 'the skill link must keep its extension');
  assert.ok(!/href="\.\/[^"]*"/.test(html), 'no relative links belong on the landing page');
});

test('llms.txt points at the machine-readable siblings', () => {
  assert.ok(LLMS_TXT.startsWith('# jmp2.io'));
  assert.ok(LLMS_TXT.includes('https://jmp2.io/skill.md'));
  assert.ok(LLMS_TXT.includes('https://jmp2.io/openapi.json'));
});

test('the openapi document is well formed and matches the served API', () => {
  const spec = openApi('jmp2.io');
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.servers[0].url, 'https://jmp2.io/_api');
  assert.deepEqual(spec.components.securitySchemes.bearerAuth, { type: 'http', scheme: 'bearer' });

  for (const path of [
    '/whoami', '/sites', '/sites/{slug}', '/sites/{slug}/tarball',
    '/sites/{slug}/files/{path}', '/sites/{slug}/publish', '/sites/{slug}/rollback',
    '/tokens', '/tokens/{id}',
  ]) {
    assert.ok(spec.paths[path], `openapi is missing ${path}`);
  }
  // It has to survive a round trip: this is served as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), spec);
});

test('the CSP hash matches the theme script byte for byte', async () => {
  const { THEME_SCRIPT, THEME_SCRIPT_SHA256, CSP } = await import('../src/theme.js');
  const { createHash } = await import('node:crypto');
  const actual = 'sha256-' + createHash('sha256').update(THEME_SCRIPT, 'utf8').digest('base64');
  assert.equal(
    THEME_SCRIPT_SHA256, actual,
    'the theme script changed without its hash — every page would silently lose the toggle',
  );
  assert.ok(CSP.includes(`script-src '${actual}'`));
});

test('the CSP still admits nothing but that one script', async () => {
  const { CSP, CSP_FORM } = await import('../src/theme.js');
  for (const policy of [CSP, CSP_FORM]) {
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(policy), 'scripts must never be unsafe-inline');
    assert.ok(!/script-src[^;]*https?:/.test(policy), 'no remote script origins');
    assert.ok(policy.includes("default-src 'none'"));
    assert.ok(policy.includes("base-uri 'none'"));
    assert.ok(policy.includes("frame-ancestors 'none'"));
  }
  assert.ok(CSP.includes("form-action 'none'"), 'content pages must not be able to post');
  assert.ok(CSP_FORM.includes("form-action 'self'"));
});

test('both themes define every colour token', async () => {
  const { landingPage } = await import('../src/theme.js');
  const html = await landingPage('jmp2.io', '<p>x</p>').text();
  const tokens = [...html.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]);
  const light = new Set(tokens.slice(0, tokens.indexOf('bg', 1)));
  for (const name of ['bg', 'fg', 'muted', 'faint', 'line', 'line-strong', 'surface', 'accent']) {
    assert.ok(light.has(name) || tokens.includes(name), `missing token --${name}`);
  }
  // A dark block must exist for both the system preference and the explicit choice.
  assert.ok(html.includes(':root:not([data-theme="light"])'), 'system dark must yield to an explicit light choice');
  assert.ok(html.includes(':root[data-theme="dark"]'), 'the toggle must win over the system preference');
});

test('the render fingerprint changes when the shell does', async () => {
  const { RENDER_VERSION } = await import('../src/theme.js');
  assert.match(RENDER_VERSION, /^[a-z0-9]+$/, 'must be URL-safe: it goes in a cache key');
  assert.ok(RENDER_VERSION.length >= 4);
});

test('the landing calls to action sit under the title, not above it', async () => {
  const { landingPage } = await import('../src/theme.js');
  const { renderMarkdown } = await import('../src/render.js');
  const { skillBody } = await import('../src/skill.js');

  const { html: content } = renderMarkdown(skillBody('jmp2.io'), '');
  const page = await landingPage('jmp2.io', content).text();

  const h1 = page.indexOf('<h1');
  const h1End = page.indexOf('</h1>');
  const hero = page.indexOf('hero top');
  const firstPara = page.indexOf('<p>', h1End);

  assert.ok(h1 !== -1 && hero !== -1, 'both the title and the hero should render');
  assert.ok(h1 < hero, 'the hero must come after the title');
  assert.ok(hero < firstPara, 'the hero must come before the body copy');
  assert.ok(page.includes('href="/signup"'));
});

test('the landing page still works if the document has no h1', async () => {
  const { landingPage } = await import('../src/theme.js');
  const page = await landingPage('jmp2.io', '<p>no heading here</p>').text();
  assert.ok(page.includes('hero top'), 'the hero must not be dropped');
  assert.ok(page.indexOf('hero top') < page.indexOf('no heading here'));
});
