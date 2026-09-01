import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, enabledProviders, providerConfigured } from '../src/providers.js';
import { sessionIdentity } from '../src/oauth.js';

const full = {
  SESSION_SECRET: 's',
  GITHUB_CLIENT_ID: 'gh', GITHUB_CLIENT_SECRET: 'ghs',
  GOOGLE_CLIENT_ID: 'go', GOOGLE_CLIENT_SECRET: 'gos',
};

test('every provider describes what it needs', () => {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.label, `${name} has no label`);
    assert.equal(typeof p.authorizeUrl, 'function', `${name} cannot start a round trip`);
    assert.equal(typeof p.identify, 'function', `${name} cannot finish one`);
    assert.ok(p.idVar && p.secretVar, `${name} does not say which secrets it needs`);
  }
});

test('a provider is offered only when both its secrets are set', () => {
  assert.deepEqual(enabledProviders(full), ['github', 'google']);
  assert.deepEqual(enabledProviders({ ...full, GOOGLE_CLIENT_SECRET: undefined }), ['github']);
  assert.deepEqual(enabledProviders({ ...full, GITHUB_CLIENT_ID: undefined }), ['google']);
  assert.deepEqual(enabledProviders({}), []);
  // Without a session secret nothing can be signed, so nothing can be offered.
  assert.deepEqual(enabledProviders({ ...full, SESSION_SECRET: undefined }), []);
  assert.ok(!providerConfigured(full, 'gitlab'), 'unknown providers are never configured');
});

test('authorize urls carry the right client, redirect and state', () => {
  for (const name of ['github', 'google']) {
    const url = new URL(PROVIDERS[name].authorizeUrl(full, {
      redirectUri: 'https://jmp2.io/auth/x/callback', state: 'abc123',
    }));
    assert.equal(url.searchParams.get('redirect_uri'), 'https://jmp2.io/auth/x/callback', name);
    assert.equal(url.searchParams.get('state'), 'abc123', name);
    assert.ok(url.searchParams.get('client_id'), `${name} sent no client_id`);
    assert.equal(url.protocol, 'https:', name);
  }
});

test('neither provider asks for more than identity', () => {
  const scope = (name) => new URL(PROVIDERS[name].authorizeUrl(full, {
    redirectUri: 'https://jmp2.io/auth/x/callback', state: 's',
  })).searchParams.get('scope');
  assert.equal(scope('github'), '', 'GitHub needs no scope at all for identity');
  assert.equal(scope('google'), 'openid email');
  assert.ok(!scope('google').includes('profile'));
  assert.ok(!scope('google').includes('drive'));
});

test('google sends the parameters its token exchange requires', () => {
  const url = new URL(PROVIDERS.google.authorizeUrl(full, {
    redirectUri: 'https://jmp2.io/auth/google/callback', state: 's',
  }));
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.host, 'accounts.google.com');
});

test('sessions resolve to an identity, old shape included', () => {
  assert.deepEqual(sessionIdentity({ p: 'google', s: '1234', login: 'a@b.c' }),
    { provider: 'google', subject: '1234', label: 'a@b.c' });
  // Sessions minted before a second provider existed must keep working, or the
  // upgrade signs everybody out.
  assert.deepEqual(sessionIdentity({ gh: '773853', login: 'c4pt0r' }),
    { provider: 'github', subject: '773853', label: 'c4pt0r' });
  for (const bad of [null, undefined, {}, { login: 'x' }, { p: 'github' }, { s: '1' }]) {
    assert.equal(sessionIdentity(bad), null);
  }
});

test('a handle is checked for shape before any request goes out', () => {
  const { validHandle } = PROVIDERS.github;
  assert.ok(validHandle('c4pt0r'));
  assert.ok(validHandle('a-b-c'));
  for (const bad of ['has spaces', 'a/b', '-leading', 'trailing-', '', 'x'.repeat(40), '../etc']) {
    assert.ok(!validHandle(bad), `should reject ${JSON.stringify(bad)}`);
  }
});
