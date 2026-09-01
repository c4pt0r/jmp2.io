#!/usr/bin/env node
/**
 * One-shot provisioning for a new deployment.
 *
 *   npm run setup -- --domain example.com [--name jmp2] [--account <id>]
 *
 * Creates the R2 bucket and D1 database, writes wrangler.toml from the example
 * with the real ids substituted, applies the schema, and prints the manual
 * steps that need a browser (DNS records, the GitHub OAuth app).
 *
 * Safe to re-run: existing resources are reused rather than recreated.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(`--${flag}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const domain = arg('domain');
if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) {
  console.error('usage: npm run setup -- --domain example.com [--name jmp2] [--account <id>]');
  process.exit(1);
}
const name = arg('name', domain.split('.')[0].replace(/[^a-z0-9-]/gi, '').toLowerCase());
const bucket = `${name}-sites`;

const wrangler = (args, opts = {}) =>
  execFileSync('npx', ['wrangler', ...args], { cwd: root, encoding: 'utf8', ...opts });

/** Run a command whose failure means "already exists", which is not an error here. */
function ensure(label, args) {
  try {
    wrangler(args, { stdio: 'pipe' });
    console.log(`  created ${label}`);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (/already exists|already have/i.test(out)) console.log(`  ${label} already exists`);
    else throw new Error(`could not create ${label}:\n${out}`);
  }
}

console.log(`\nProvisioning ${domain}\n`);

console.log('R2 and D1');
ensure(`R2 bucket ${bucket}`, ['r2', 'bucket', 'create', bucket]);
ensure(`D1 database ${name}`, ['d1', 'create', name]);

// Read the id back rather than parsing creation output, so a re-run also works.
const dbList = JSON.parse(wrangler(['d1', 'list', '--json'], { stdio: 'pipe' }));
const db = dbList.find((d) => d.name === name);
if (!db) throw new Error(`D1 database ${name} was created but is not listed`);
console.log(`  database_id ${db.uuid}`);

let accountId = arg('account');
if (!accountId) {
  const who = wrangler(['whoami'], { stdio: 'pipe' });
  const ids = [...who.matchAll(/\b([0-9a-f]{32})\b/g)].map((m) => m[1]);
  if (ids.length !== 1) {
    throw new Error('could not determine the account id; pass --account <id>');
  }
  accountId = ids[0];
}
console.log(`  account_id ${accountId}`);

const target = join(root, 'wrangler.toml');
if (existsSync(target)) {
  console.log('\nwrangler.toml already exists — leaving it alone');
} else {
  const config = readFileSync(join(root, 'wrangler.example.toml'), 'utf8')
    .replace(/^# Copy to wrangler\.toml[\s\S]*?\n\n/, '')
    .replaceAll('example.com', domain)
    .replaceAll('YOUR_ACCOUNT_ID', accountId)
    .replaceAll('YOUR_DATABASE_ID', db.uuid)
    .replace(/^name = "jmp2"$/m, `name = "${name}"`)
    .replaceAll('jmp2-sites', bucket)
    .replaceAll('database_name = "jmp2"', `database_name = "${name}"`);
  writeFileSync(target, config);
  console.log('\nwrote wrangler.toml');
}

console.log('\nSchema');
for (const where of ['--local', '--remote']) {
  wrangler(['d1', 'execute', name, where, '--file=./schema.sql', '-y'], { stdio: 'pipe' });
  console.log(`  applied ${where}`);
}

const adminToken = `${name}_admin_${randomBytes(24).toString('base64url')}`;
const sessionSecret = randomBytes(48).toString('base64url');

console.log(`
Done. Remaining steps, in order:

1. DNS — add two proxied records on ${domain} (content is irrelevant; the Worker
   intercepts before any origin):

     AAAA  @  100::  proxied
     AAAA  *  100::  proxied

   Free Universal SSL covers the apex and one wildcard level, which is exactly
   <tenant>.${domain}.

2. Secrets — ADMIN_TOKEN mints tenants and tokens; SESSION_SECRET signs the
   signup cookies. Generated for you; store them somewhere safe first:

     ADMIN_TOKEN     ${adminToken}
     SESSION_SECRET  ${sessionSecret}

     npx wrangler secret put ADMIN_TOKEN
     npx wrangler secret put SESSION_SECRET

3. Sign-in providers (all optional — without any, /signup returns a clear 503
   and everything else works). Configure either, both, or neither.

   GitHub, an OAuth App at https://github.com/settings/developers:
     Homepage URL              https://${domain}
     Authorization callback    https://${domain}/auth/github/callback

   Google, a Web application client at
   https://console.cloud.google.com/apis/credentials:
     Authorized origin         https://${domain}
     Authorized redirect URI   https://${domain}/auth/google/callback

   Keep redirect URIs exact for both. *.${domain} serves content any signed-up
   user can upload, and a wildcard redirect would let a provider send
   authorization codes there.

     npx wrangler secret put GITHUB_CLIENT_ID
     npx wrangler secret put GITHUB_CLIENT_SECRET
     npx wrangler secret put GOOGLE_CLIENT_ID
     npx wrangler secret put GOOGLE_CLIENT_SECRET

4. Deploy:

     npx wrangler deploy

   The API token needs Zone -> Workers Routes -> Edit and Zone -> DNS -> Edit
   for ${domain}, or the routes will fail to attach.
`);
