import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { llmsTxt, openApi, skillBody, skillMarkdown, skillName } from '../src/skill.js';
import { tokenPrefix } from '../src/tokens.js';
import { classifyHost } from '../src/index.js';
import { splitFrontmatter } from '../src/render.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('a fork on its own domain gets no leftover jmp2.io', () => {
  const d = 'notes.example.org';
  for (const [label, text] of [
    ['skill', skillMarkdown(d)],
    ['llms.txt', llmsTxt(d)],
    ['openapi', JSON.stringify(openApi(d))],
  ]) {
    assert.ok(!text.includes('jmp2.io/'), `${label} still points at jmp2.io`);
    assert.ok(text.includes(d), `${label} never mentions ${d}`);
  }
});

test('names derive from the domain', () => {
  assert.equal(skillName('jmp2.io'), 'jmp2');
  assert.equal(skillName('notes.example.org'), 'notes');
  assert.equal(tokenPrefix('notes.example.org'), 'notes_live_');
  assert.equal(tokenPrefix('jmp2.io'), 'jmp2_live_');
  // Never produce an empty or punctuated prefix, whatever the input.
  assert.match(tokenPrefix(''), /^[a-z0-9]+_live_$/);
  assert.match(tokenPrefix('a_b.c'), /^[a-z0-9]+_live_$/);
});

test('the docs a fork serves use its own CLI and env var names', () => {
  const body = skillBody('notes.example.org');
  assert.ok(body.includes('NOTES_TOKEN'), 'the env var should follow the name');
  assert.ok(body.includes('~/.notes/token'));
  assert.ok(body.includes('curl -fsSL https://notes.example.org/cli'));
  assert.ok(!body.includes('JMP2_TOKEN'));
});

test('host routing follows the configured domain', () => {
  const d = 'notes.example.org';
  assert.equal(classifyHost(d, d).kind, 'apex');
  assert.deepEqual(classifyHost(`alice.${d}`, d), { kind: 'tenant', tenant: 'alice' });
  assert.equal(classifyHost('jmp2.io', d).kind, 'unknown', 'the old domain must not be special');
});

test("a fork's skill file still parses as a skill", () => {
  const { meta } = splitFrontmatter(skillMarkdown('notes.example.org'));
  assert.equal(meta.name, 'notes');
  assert.ok(meta.description.includes('notes.example.org'));
});

test('the example config carries placeholders, not a real deployment', () => {
  const example = read('wrangler.example.toml');
  assert.ok(example.includes('YOUR_ACCOUNT_ID'));
  assert.ok(example.includes('YOUR_DATABASE_ID'));
  assert.ok(example.includes('ROOT_DOMAIN = "example.com"'));
  assert.ok(!/account_id = "[0-9a-f]{32}"/.test(example), 'no real account id in the example');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(example), 'no real database uuid in the example');
  assert.ok(example.includes('routes = []'), 'the dev environment must drop routes');
});

test('deployment-specific and secret files are gitignored', () => {
  const ignored = read('.gitignore');
  for (const path of ['wrangler.toml', '.dev.vars', 'node_modules/', '.wrangler/']) {
    assert.ok(ignored.includes(path), `.gitignore is missing ${path}`);
  }
});

test('the dev vars example lists every secret the worker reads', () => {
  const example = read('.dev.vars.example');
  for (const name of ['ADMIN_TOKEN', 'SESSION_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']) {
    assert.ok(example.includes(`${name}=`), `.dev.vars.example is missing ${name}`);
  }
});

test('no source file hardcodes the domain any more', () => {
  for (const file of [
    'src/index.js', 'src/serve.js', 'src/api.js', 'src/oauth.js',
    'src/account.js', 'src/theme.js', 'src/tokens.js', 'src/util.js',
  ]) {
    const text = read(file)
      .replace(/^\s*\*.*$/gm, '')      // block comment bodies
      .replace(/\/\/.*$/gm, '');       // line comments
    assert.ok(
      !text.includes('jmp2.io'),
      `${file} hardcodes jmp2.io outside a comment; it should read env.ROOT_DOMAIN`,
    );
  }
});
