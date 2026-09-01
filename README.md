# jmp2

Push a markdown file or a whole folder, get a public URL. Relative links and
image assets keep working. One HTTP call, no build step, no repo.

```sh
tar czf - ./docs | curl -T - https://jmp2.io/_api/sites/handbook/tarball \
  -H "Authorization: Bearer $JMP2_TOKEN"
# -> https://you.jmp2.io/handbook/
```

Multi-tenant markdown hosting on a single Cloudflare Worker, with R2 for files
and D1 for metadata. Runs comfortably inside the free tier. Live at
[jmp2.io](https://jmp2.io); self-host it on your own domain in about ten
minutes.

## Shape

- **Reads** live on tenant subdomains: `https://<tenant>.<domain>/<slug>/...`
- **Writes** live on the apex: `https://<domain>/_api/...`, bearer token only

Splitting them means the read path needs no CORS, no cookies and no write
surface at all, and each tenant is its own browser origin — a hostile SVG or
future embedded HTML can only reach its own tenant.

Free Universal SSL covers the apex and one wildcard level, which is exactly
`<tenant>.<domain>`. Deeper hosts are rejected by the router.

## URL rules

A document's URL is its path without the `.md`, which is what makes relative
links written for the filesystem keep resolving on the web.

| Source file       | URL                     |
| ----------------- | ----------------------- |
| `index.md`        | `/handbook/`            |
| `docs/api.md`     | `/handbook/docs/api`    |
| `docs/api.md` raw | `/handbook/docs/api.md` |
| `docs/index.md`   | `/handbook/docs/`       |
| `img/a.png`       | `/handbook/img/a.png`   |

So `[api](./api.md)` renders as `href="./api"` and resolves correctly, and
`![](./img/a.png)` needs no rewriting at all. Two consequences worth knowing:

- `/handbook/docs` 301s to `/handbook/docs/`. Without the trailing slash every
  relative link inside that document would resolve one level too high.
- Root-relative links (`/img/a.png`) are rewritten to sit under the site root,
  since a site is mounted at `/<slug>/` rather than at `/`.

## Visibility

Every site is one of three things; new sites are **public**.

| State | Reachable by URL | Listed on the tenant index | Password |
| --- | --- | --- | --- |
| `public` | yes | yes | no |
| `secret` | yes | no | no |
| `secret` + password | yes | no | HTTP Basic |

Secret means *unlisted*, not private — anyone holding the URL can still read it.
That distinction is spelled out in the UI rather than left to the word "secret",
because reading it as "nobody can reach this" is the dangerous misunderstanding.

```sh
jmp2 push handbook ./docs --secret
jmp2 push handbook ./docs --password hunter2   # implies --secret
jmp2 public handbook                            # relist, dropping the password
```

A username is optional: set one and Basic auth must match it, otherwise any
username is accepted. Visibility, username and password are all settable from
the dashboard as well as the CLI.

Passwords are PBKDF2-SHA256 with a per-site salt. Three things make the gate
hold:

- **Protected sites never enter the shared edge cache.** A cached response would
  otherwise be served to the next visitor with no credentials at all. They also
  carry `Cache-Control: private, no-store`.
- **Everything under the site is gated**, not just rendered pages — assets and
  raw `.md` too.
- **Clearing a password is explicit** (`"password": null`), so a routine publish
  cannot unlock a site by accident.

Basic auth resends credentials on every request, so a protected page with ten
images would pay the KDF eleven times. Successful verifications are memoized per
isolate, keyed by the stored hash *and* the supplied password — rotating the
password changes the stored hash, which changes the key, so a stale isolate
cannot keep honouring the old one.

Passwords are sent to the API in an `X-Site-Password` header rather than the
query string: query strings end up in access logs, shell history and `Referer`.

## The dashboard

`/account` lists every site the signed-in owner has, secret ones included, as
cards rather than table rows — a row cannot carry its own controls without the
columns fighting. Because the palette is monochrome, state reads as shape: a
filled pill means listed, an outline means unlisted, a dot marks a password.

Deleting a site is irreversible and the CSP admits no script, so there is no
confirm dialog to lean on. The confirmation page states what disappears and
asks the owner to type the slug — a misclick cannot get past that, and it needs
nothing the browser has to run.

The editor is a `<textarea>` and a form post, with one sticky strip of chrome
and the viewport given to the text. New pages are added from the same row as
the file tabs; a name without an extension gets `.md`, and the page goes live
immediately with a heading taken from its name — the alternative is a draft
state, and a stub the owner is about to edit is easier to explain than a
staging area they cannot see. Saving copies the live manifest into a new
version, overwrites the one file and flips the pointer: the same copy-on-write
publish the API performs, so the previous version stays available for rollback.

An empty password field means "leave it alone", not "remove it". Removing a
password is a separate checkbox, so saving a username cannot silently unlock a
site.

## Versions

Every publish writes a new version and flips a pointer only once it is complete,
so a publish is atomic and rollback is a pointer move. Staging a single file
inherits the live version's manifest by copying rows, not objects — editing one
file of a 500-file site costs one R2 write. Objects are reference-counted by
`(src_version, path)`, so retiring a version never deletes bytes another version
still points at.

A tarball describes the whole site, so it **replaces**: files deleted locally
disappear. Pass `?merge=1` to overlay instead.

## Self-hosting

You need a Cloudflare account and a domain on it. The whole service is one
Worker; nothing else has to be running.

```sh
git clone https://github.com/c4pt0r/jmp2.io && cd jmp2.io
npm install
npx wrangler login
npm run setup -- --domain example.com
```

`npm run setup` creates the R2 bucket and D1 database, writes `wrangler.toml`
from `wrangler.example.toml` with the real ids filled in, applies the schema to
both the local and remote databases, and prints the remaining steps. It is safe
to re-run: existing resources are reused.

Those remaining steps need a browser:

**1. DNS** — two proxied records on your zone. The content is irrelevant; the
Worker intercepts before any origin is reached.

```
AAAA  @  100::  proxied
AAAA  *  100::  proxied
```

**2. Secrets** — `setup` generates them; store them somewhere safe first.

```sh
npx wrangler secret put ADMIN_TOKEN      # mints tenants and tokens; treat as root
npx wrangler secret put SESSION_SECRET   # signs signup/dashboard cookies
```

**3. Sign-in providers**, all optional. Configure either, both, or neither;
without any, `/signup` returns a clear 503 and you onboard people by hand with
the admin API.

GitHub — an OAuth App at <https://github.com/settings/developers>:

| Field | Value |
| --- | --- |
| Homepage URL | `https://example.com` |
| Authorization callback URL | `https://example.com/auth/github/callback` |
| Allow wildcard matching | **leave off** |

Google — an OAuth client ID of type *Web application* at
<https://console.cloud.google.com/apis/credentials>:

| Field | Value |
| --- | --- |
| Authorized JavaScript origins | `https://example.com` |
| Authorized redirect URI | `https://example.com/auth/google/callback` |

Wildcard or overly broad redirect URIs must stay off for both: `*.example.com`
serves content any signed-up user can upload, and a wildcard redirect would let
the provider send authorization codes there.

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

**4. Deploy.**

```sh
npx wrangler deploy
```

The Cloudflare API token needs `Zone → Workers Routes → Edit` and
`Zone → DNS → Edit` on the zone, or the routes will fail to attach and the
Worker will upload but never receive traffic.

### Onboarding without OAuth

```sh
curl -X POST https://example.com/_api/admin/tenants \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"id":"alice","name":"Alice"}'

curl -X POST https://example.com/_api/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"tenant_id":"alice","name":"laptop"}'
```

`POST /_api/admin/tenants/:id/owner` binds an invite-created tenant to a
sign-in account afterwards, so it shows up in that person's dashboard — with
`{"github_login":"..."}` for a handle the provider can resolve, or
`{"provider":"google","subject":"...","label":"..."}` where it cannot.

## Configuration

| File | Purpose |
| --- | --- |
| `wrangler.example.toml` | template; copy to `wrangler.toml` or let `setup` write it |
| `.dev.vars.example` | the four secrets, for local `npm run dev` |
| `wrangler.toml` | **gitignored** — account id, database id and domain are per-deployment |
| `.dev.vars` | **gitignored** — real local credentials |

Everything user-visible derives from one variable, `ROOT_DOMAIN`:

- the landing page, `/skill.md`, `/llms.txt` and `/openapi.json`
- the tenant subdomain pattern and host routing
- the CLI name, its config directory, and its `*_TOKEN` env var
- the token prefix (`example_live_...`), so a leaked token names its deployment

`/cli` is rewritten on the way out to point at the deployment serving it, so a
client installed from a fork talks to that fork. A test renders every document
for a second domain and fails if any `jmp2.io` survives.

## The landing page is the docs is the skill

`src/skill.js` holds one markdown document, served five ways:

| URL | What |
| --- | --- |
| `/` | rendered through the same markdown pipeline that serves user sites |
| `/skill.md` | verbatim, with frontmatter, for `~/.claude/skills/<name>/SKILL.md` |
| `/llms.txt` | a short pointer file for agents |
| `/openapi.json` | machine-readable spec of the write API |
| `/cli` | the bash client, byte-identical to `bin/jmp2` |

Human docs, agent docs and the front page cannot drift because they are the same
bytes — and rendering the front page with the product's own renderer makes it a
live demo of what publishing looks like.

Its frontmatter description is deliberately a single quoted line: the flat
`key: value` parser that reads frontmatter out of *user* documents also has to
be able to read this file.

## Look and feel

Article pages are a single centred column with the navigation floated into the
left margin: the site's other pages, then the current document's own outline.
Below 1280px the rail collapses to a block above the article rather than
competing with the text for width.

Monochrome and dark by default, with light one click away and remembered.
`prefers-color-scheme` is deliberately not consulted: honouring it would leave
every visitor on a light operating system seeing a light page, which is exactly
what the default is meant to decide. Because no hue carries meaning, links are
underlined rather than coloured.

A site with more than one document gets a sidebar listing its pages, which the
reader can collapse; the preference is remembered. A one-document site gets
neither — there is nothing to navigate between, and no control for a sidebar
that is not there.

The toggle needs script, which the CSP would otherwise forbid outright. Rather
than opening `script-src` to `'unsafe-inline'`, the one small inline script is
**pinned by SHA-256 hash**: that exact source may run and nothing else, so an
injected `<script>` is still blocked. A unit test recomputes the hash and fails
if the script is edited without updating it.

Rendered pages are edge-cached under a key qualified by both the site's content
version and `RENDER_VERSION` — a fingerprint of the CSS, CSP and shell — so a
deploy that changes the markup invalidates cached HTML instead of serving the
previous look until the TTL expires.

## Guardrails

- **Quota**, checked before any R2 write, so an over-quota upload costs nothing
  to store. Usage sums distinct `(slug, src_version, path)`, since versions share
  objects and manifest rows would double-count inherited files.
- **Rate limits**: fixed-window counters in D1 on writes (per tenant), signup
  (per IP) and admin (per IP). Reads are not counted — they are served from the
  edge cache and mostly never reach the Worker.
- **Suspension**: `tenants.disabled_at` stops a tenant serving and writing while
  keeping its data, so an abuse report can be investigated after the content is
  offline.
- **Token lifecycle**: users list, mint and revoke their own tokens by public id;
  the plaintext is never retrievable after minting.

## Security posture

- Raw HTML in markdown is escaped, not sanitized. Cheap and total; the cost is
  no embedded HTML.
- `javascript:`, `data:` and protocol-relative links are neutralized.
- Uploaded `.html` is served as `text/plain`. Tenant subdomains are free hosting
  with a real certificate, so an attacker-controlled HTML page would be a
  phishing page. Unknown types download rather than render.
- `script-src` admits exactly one hash-pinned script and nothing else; a
  directly-navigated SVG gets `sandbox`.
- Reserved subdomains (`login`, `secure`, `pay`, …) can never become tenants.
- Tokens are stored as SHA-256; the plaintext exists only in the mint response.
- Signup sessions are HMAC-signed `__Host-` cookies, pinned to the apex where
  tenant subdomains cannot see them. Dashboard mutations check `Origin` on top
  of `SameSite=Lax`.

## Layout

```
src/index.js      host routing (apex vs tenant), docs routes
src/api.js        write API, staging, publish, versions, admin
src/serve.js      read path, URL resolution, caching
src/render.js     markdown -> HTML, link rewriting
src/tar.js        tar/gzip reader
src/theme.js      page shell, CSS, CSP, theme toggle
src/skill.js      the one document behind /, /skill.md, /llms.txt, /openapi.json
src/oauth.js      signup flow, provider-agnostic
src/providers.js  one descriptor per identity provider
src/account.js    signed-in dashboard
src/auth.js       signed-cookie sessions
src/tokens.js     token minting
src/ratelimit.js  fixed-window counters
src/util.js       paths, content types, validation
bin/jmp2          CLI (the editable source)
src/cli.js        generated from bin/jmp2, served at /cli
```

## The CLI

`bin/jmp2` is a dependency-free bash script and stays the editable source.
`scripts/build-cli.mjs` mirrors it into `src/cli.js` so the Worker can serve it;
`npm test` regenerates first and fails if the two drift, so the published client
can never lag the repo.

```sh
curl -fsSL https://jmp2.io/cli -o ~/.local/bin/jmp2 && chmod +x ~/.local/bin/jmp2
```

Downloaded and inspected rather than piped into a shell — it is 70 lines, and
people should be able to read what they are about to run.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 execute jmp2 --local --file=./schema.sql
npm run dev          # wrangler dev --env dev --local
npm test             # unit tests
npm run test:e2e     # end-to-end against the dev server
```

`wrangler dev` rewrites the request Host to the first configured route, which
collapses every tenant subdomain onto the apex. The `[env.dev]` block sets
`routes = []` so the real Host survives; the e2e script then pins real hostnames
to loopback with `curl --resolve` and resets the local database first, so it is
repeatable.

Schema changes after the first deploy go in `migrations/` and are applied to both
`--local` and `--remote`; `schema.sql` stays the full shape for fresh installs.

## Not built yet

Syntax highlighting, mermaid, OG preview images, private sites, custom domains,
per-document permalinks with previews.

## License

MIT
