import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTar, maybeGunzip, stripCommonPrefix } from '../src/tar.js';

/** Build a real tarball with the system tar so we test the formats we'll actually receive. */
function fixture(extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'jmp2-tar-'));
  const site = join(dir, 'docs');
  mkdirSync(join(site, 'img'), { recursive: true });
  writeFileSync(join(site, 'index.md'), '# Home\n');
  writeFileSync(join(site, 'api.md'), '# API\n');
  writeFileSync(join(site, 'img', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(join(site, '.DS_Store'), 'junk');
  // A name long enough to force a pax/GNU long-name header.
  const longName = 'deeply/' + 'nested/'.repeat(20) + 'leaf.md';
  mkdirSync(join(site, longName, '..'), { recursive: true });
  writeFileSync(join(site, longName), '# Leaf\n');

  const out = join(dir, 'site.tar.gz');
  execFileSync('tar', ['czf', out, '-C', dir, ...extraArgs, 'docs']);
  const bytes = new Uint8Array(readFileSync(out));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

test('parses a gzipped tarball produced by the system tar', async () => {
  const raw = await maybeGunzip(fixture());
  const files = parseTar(raw);
  const names = files.map((f) => f.name).sort();

  assert.ok(names.includes('docs/index.md'), `got ${names.join(', ')}`);
  assert.ok(names.includes('docs/img/a.png'));
  assert.ok(names.some((n) => n.endsWith('leaf.md')), 'long paths must survive');
  assert.ok(!names.some((n) => n.endsWith('.DS_Store')), '.DS_Store must be dropped');
  assert.ok(!names.some((n) => n.includes('PaxHeader')));
});

test('file contents round-trip byte for byte', async () => {
  const files = parseTar(await maybeGunzip(fixture()));
  const index = files.find((f) => f.name === 'docs/index.md');
  assert.equal(new TextDecoder().decode(index.data), '# Home\n');
  const png = files.find((f) => f.name === 'docs/img/a.png');
  assert.deepEqual([...png.data], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
});

test('directories are not emitted as files', async () => {
  const files = parseTar(await maybeGunzip(fixture()));
  assert.ok(files.every((f) => !f.name.endsWith('/')));
});

test('stripCommonPrefix removes the wrapping directory', async () => {
  const files = stripCommonPrefix(parseTar(await maybeGunzip(fixture())));
  const names = files.map((f) => f.name);
  assert.ok(names.includes('index.md'), `got ${names.join(', ')}`);
  assert.ok(names.includes('img/a.png'));
});

test('stripCommonPrefix leaves a flat archive alone', () => {
  const files = [{ name: './a.md' }, { name: './b.md' }];
  assert.deepEqual(stripCommonPrefix(files).map((f) => f.name), ['a.md', 'b.md']);
});

test('stripCommonPrefix leaves a mixed archive alone', () => {
  const files = [{ name: 'a.md' }, { name: 'img/b.png' }];
  assert.deepEqual(stripCommonPrefix(files).map((f) => f.name), ['a.md', 'img/b.png']);
});

test('gunzip tolerates the NUL padding tar adds when writing to a pipe', async () => {
  // `tar czf - .` pads stdout to a 10 KiB block after the gzip trailer.
  const dir = mkdtempSync(join(tmpdir(), 'jmp2-pipe-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'index.md'), '# Piped\n');
  const piped = execFileSync('sh', ['-c', `tar czf - -C ${dir} docs`], {
    maxBuffer: 1 << 24, encoding: 'buffer',
  });
  rmSync(dir, { recursive: true, force: true });

  assert.ok(piped.length % 10240 === 0, 'fixture should actually be block-padded');
  const files = parseTar(await maybeGunzip(new Uint8Array(piped)));
  assert.deepEqual(files.map((f) => f.name), ['docs/index.md']);
  assert.equal(new TextDecoder().decode(files[0].data), '# Piped\n');
});

test('maybeGunzip passes an uncompressed tar through', async () => {
  const gz = fixture();
  const raw = await maybeGunzip(gz);
  assert.deepEqual(await maybeGunzip(raw), raw);
});

test('a corrupt header is rejected rather than silently skipped', async () => {
  const raw = await maybeGunzip(fixture());
  const corrupt = raw.slice();
  corrupt[10] = corrupt[10] ^ 0xff;
  assert.throws(() => parseTar(corrupt), /bad tar header/);
});
