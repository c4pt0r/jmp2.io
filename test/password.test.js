import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basicAuthCredentials, hashPassword, usernameMatches, verifyPassword } from '../src/password.js';

test('a password verifies against its own hash and nothing else', async () => {
  const stored = await hashPassword('hunter2');
  assert.ok(await verifyPassword('hunter2', stored));
  assert.ok(!await verifyPassword('hunter3', stored));
  assert.ok(!await verifyPassword('', stored));
  assert.ok(!await verifyPassword('HUNTER2', stored));
});

test('the stored form is salted, so equal passwords hash differently', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notEqual(a, b, 'a shared salt would let one crack reveal every site');
  assert.ok(await verifyPassword('same', a));
  assert.ok(await verifyPassword('same', b));
});

test('the stored form records its parameters', async () => {
  const stored = await hashPassword('x');
  const [scheme, iterations, salt, hash] = stored.split('$');
  assert.equal(scheme, 'pbkdf2');
  assert.ok(Number(iterations) >= 100_000, 'iterations should not silently regress');
  assert.ok(salt.length > 10 && hash.length > 20);
});

test('malformed stored values are rejected, not thrown on', async () => {
  for (const bad of [null, undefined, '', 'nonsense', 'pbkdf2$x$y', 'md5$1$a$b', 'pbkdf2$0$a$b',
    'pbkdf2$99999999$a$b', 'pbkdf2$1000$!!!$!!!']) {
    assert.equal(await verifyPassword('hunter2', bad), false, `should reject ${bad}`);
  }
});

test('a repeated check still only accepts the right password', async () => {
  // Verification is memoized per isolate; the memo must not turn into a bypass.
  const stored = await hashPassword('correct');
  assert.ok(await verifyPassword('correct', stored));
  assert.ok(await verifyPassword('correct', stored));
  assert.ok(!await verifyPassword('wrong', stored));
  const rotated = await hashPassword('rotated');
  assert.ok(!await verifyPassword('correct', rotated), 'a new hash must not inherit the memo');
});

test('basic auth headers are split, and anything else ignored', () => {
  const auth = (v) => new Request('https://x.test/', { headers: v ? { authorization: v } : {} });
  assert.deepEqual(basicAuthCredentials(auth(`Basic ${btoa('user:hunter2')}`)), { user: 'user', password: 'hunter2' });
  assert.deepEqual(basicAuthCredentials(auth(`basic ${btoa(':hunter2')}`)), { user: '', password: 'hunter2' });
  // Only the first colon separates; the rest belongs to the password.
  assert.deepEqual(basicAuthCredentials(auth(`Basic ${btoa('u:has:colons')}`)), { user: 'u', password: 'has:colons' });
  assert.equal(basicAuthCredentials(auth('Bearer abc')), null);
  assert.equal(basicAuthCredentials(auth('Basic !!!not-base64!!!')), null);
  assert.equal(basicAuthCredentials(auth(`Basic ${btoa('nocolon')}`)), null);
  assert.equal(basicAuthCredentials(auth()), null);
});

test('an unset username accepts anyone; a set one accepts only itself', () => {
  assert.ok(usernameMatches(null, 'anything'), 'no configured username means any will do');
  assert.ok(usernameMatches('', 'anything'));
  assert.ok(usernameMatches('alice', 'alice'));
  assert.ok(!usernameMatches('alice', 'Alice'));
  assert.ok(!usernameMatches('alice', 'alic'));
  assert.ok(!usernameMatches('alice', 'alices'));
  assert.ok(!usernameMatches('alice', ''));
  assert.ok(!usernameMatches('alice', null));
});
