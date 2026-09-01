import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COOKIE, clearCookie, readCookie, setCookie, sign, verify } from '../src/auth.js';

const SECRET = 'test-secret-not-used-anywhere-real';

test('a signed payload round-trips', async () => {
  const token = await sign({ gh: '123', login: 'octocat' }, SECRET);
  assert.deepEqual(await verify(token, SECRET), { gh: '123', login: 'octocat' });
});

test('a tampered payload is rejected', async () => {
  const token = await sign({ gh: '123' }, SECRET);
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ gh: '999' })).toString('base64url');
  assert.equal(await verify(`${forged}.${sig}`, SECRET), null);
  assert.equal(await verify(`${body}.${sig.slice(0, -2)}xx`, SECRET), null);
});

test('a different secret is rejected', async () => {
  const token = await sign({ gh: '123' }, SECRET);
  assert.equal(await verify(token, 'other-secret'), null);
});

test('malformed input is rejected without throwing', async () => {
  for (const bad of ['', '.', 'nodot', 'a.b', null, undefined, 'x'.repeat(5000)]) {
    assert.equal(await verify(bad, SECRET), null);
  }
});

test('an expired session is rejected', async () => {
  const token = await sign({ gh: '123', exp: 1000 }, SECRET);
  assert.equal(await verify(token, SECRET, 1001), null);
  assert.ok(await verify(token, SECRET, 999));
});

test('cookies parse out of a crowded header', () => {
  const request = new Request('https://jmp2.io/', {
    headers: { cookie: `other=1; ${COOKIE}=abc.def; trailing=2` },
  });
  assert.equal(readCookie(request, COOKIE), 'abc.def');
  assert.equal(readCookie(new Request('https://jmp2.io/'), COOKIE), null);
});

test('the session cookie is host-locked and not script-readable', () => {
  const c = setCookie('v', 600);
  assert.ok(c.startsWith('__Host-'), 'the __Host- prefix pins it to the apex');
  for (const attr of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) {
    assert.ok(c.includes(attr), `missing ${attr}`);
  }
  assert.ok(!/Domain=/i.test(c), '__Host- forbids Domain, which would leak it to tenants');
  assert.ok(clearCookie().includes('Max-Age=0'));
});
