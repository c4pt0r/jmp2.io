import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { looksLikeZip, parseZip } from '../src/zip.js';

/** Build a real archive with the system zip, so we parse what we will receive. */
function fixture(extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'jmp2-zip-'));
  mkdirSync(join(dir, 'site', 'img'), { recursive: true });
  writeFileSync(join(dir, 'site', 'index.md'), '# Home\n'.repeat(40)); // compressible
  writeFileSync(join(dir, 'site', 'img', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(join(dir, 'site', '.DS_Store'), 'junk');
  const out = join(dir, 'site.zip');
  execFileSync('zip', ['-q', '-r', ...extraArgs, out, 'site'], { cwd: dir });
  const bytes = new Uint8Array(readFileSync(out));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

test('detects a zip by its signature', () => {
  assert.ok(looksLikeZip(fixture()));
  assert.ok(!looksLikeZip(new Uint8Array([0x1f, 0x8b, 8, 0])), 'gzip is not a zip');
  assert.ok(!looksLikeZip(new Uint8Array([1, 2, 3])));
});

test('reads a deflated archive produced by the system zip', async () => {
  const files = await parseZip(fixture());
  const names = files.map((f) => f.name).sort();
  assert.ok(names.includes('site/index.md'), names.join(', '));
  assert.ok(names.includes('site/img/a.png'));
  assert.ok(!names.some((n) => n.endsWith('.DS_Store')), '.DS_Store must be dropped');
  assert.ok(!names.some((n) => n.startsWith('__MACOSX')));
});

test('contents round-trip through deflate byte for byte', async () => {
  const files = await parseZip(fixture());
  const index = files.find((f) => f.name === 'site/index.md');
  assert.equal(new TextDecoder().decode(index.data), '# Home\n'.repeat(40));
  const png = files.find((f) => f.name === 'site/img/a.png');
  assert.deepEqual([...png.data], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
});

test('stored entries are read too', async () => {
  // -0 disables compression, so every entry uses method 0.
  const files = await parseZip(fixture(['-0']));
  const index = files.find((f) => f.name === 'site/index.md');
  assert.equal(new TextDecoder().decode(index.data), '# Home\n'.repeat(40));
});

test('directories are not emitted as files', async () => {
  const files = await parseZip(fixture());
  assert.ok(files.every((f) => !f.name.endsWith('/')));
  assert.ok(files.every((f) => f.size === f.data.length));
});

test('a corrupt archive is rejected rather than half-read', async () => {
  await assert.rejects(() => parseZip(new Uint8Array([1, 2, 3, 4])), /not a zip/);
  const truncated = fixture().slice(0, 40);
  await assert.rejects(() => parseZip(truncated), /not a zip|corrupt|truncated/);
});
