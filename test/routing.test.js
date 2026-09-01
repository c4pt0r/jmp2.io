import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHost } from '../src/index.js';
import { resolve } from '../src/serve.js';

const ROOT = 'jmp2.io';

test('apex and www route to the control plane', () => {
  assert.equal(classifyHost('jmp2.io', ROOT).kind, 'apex');
  assert.equal(classifyHost('www.jmp2.io', ROOT).kind, 'apex');
  assert.equal(classifyHost('JMP2.IO', ROOT).kind, 'apex');
});

test('a tenant label routes to that tenant', () => {
  assert.deepEqual(classifyHost('dongxu.jmp2.io', ROOT), { kind: 'tenant', tenant: 'dongxu' });
  assert.deepEqual(classifyHost('my-team.jmp2.io', ROOT), { kind: 'tenant', tenant: 'my-team' });
});

test('reserved, deep, and foreign hosts are refused', () => {
  assert.equal(classifyHost('admin.jmp2.io', ROOT).kind, 'unknown');
  assert.equal(classifyHost('login.jmp2.io', ROOT).kind, 'unknown');
  assert.equal(classifyHost('a.b.jmp2.io', ROOT).kind, 'unknown', 'beyond the wildcard cert');
  assert.equal(classifyHost('evil.com', ROOT).kind, 'unknown');
  assert.equal(classifyHost('jmp2.io.evil.com', ROOT).kind, 'unknown');
  assert.equal(classifyHost('x.jmp2.io', ROOT).kind, 'unknown', 'single-char label');
});

test('localhost mirrors production routing for dev', () => {
  assert.equal(classifyHost('localhost', ROOT).kind, 'apex');
  assert.deepEqual(classifyHost('dongxu.localhost', ROOT), { kind: 'tenant', tenant: 'dongxu' });
});

const paths = new Set([
  'index.md',
  'api.md',
  'docs/index.md',
  'docs/guide.md',
  'docs/img/a.png',
  'notes/README.md',
  'raw.txt',
]);

test('site root serves the index document', () => {
  assert.deepEqual(resolve(paths, ''), { kind: 'render', path: 'index.md' });
  assert.deepEqual(resolve(paths, 'docs/'), { kind: 'render', path: 'docs/index.md' });
  assert.deepEqual(resolve(paths, 'notes/'), { kind: 'render', path: 'notes/README.md' });
});

test('extensionless paths render the matching markdown', () => {
  assert.deepEqual(resolve(paths, 'api'), { kind: 'render', path: 'api.md' });
  assert.deepEqual(resolve(paths, 'docs/guide'), { kind: 'render', path: 'docs/guide.md' });
});

test('an explicit .md path serves the source', () => {
  assert.deepEqual(resolve(paths, 'api.md'), { kind: 'raw', path: 'api.md' });
  assert.deepEqual(resolve(paths, 'docs/guide.md'), { kind: 'raw', path: 'docs/guide.md' });
});

test('assets are served as themselves', () => {
  assert.deepEqual(resolve(paths, 'docs/img/a.png'), { kind: 'asset', path: 'docs/img/a.png' });
  assert.deepEqual(resolve(paths, 'raw.txt'), { kind: 'asset', path: 'raw.txt' });
});

test('a directory without a trailing slash redirects so relative links resolve', () => {
  assert.deepEqual(resolve(paths, 'docs'), { kind: 'redirect', to: 'docs/' });
  assert.deepEqual(resolve(paths, 'notes'), { kind: 'redirect', to: 'notes/' });
});

test('index is not also reachable as its own name', () => {
  assert.deepEqual(resolve(paths, 'docs/index'), { kind: 'redirect', to: 'docs/' });
  assert.deepEqual(resolve(paths, 'notes/readme'), { kind: 'redirect', to: 'notes/' });
});

test('unknown paths report missing', () => {
  assert.equal(resolve(paths, 'nope').kind, 'missing');
  assert.equal(resolve(paths, 'docs/nope/').kind, 'missing');
  assert.equal(resolve(new Set(['api.md']), '').kind, 'missing');
});
