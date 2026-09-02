/**
 * The single source of truth for how this deployment is used.
 *
 * One document, served four ways: rendered as the landing page at `/`, raw at
 * `/skill.md` for dropping into `~/.claude/skills/<name>/SKILL.md`, summarized
 * at `/llms.txt`, and specified at `/openapi.json`. Keeping them one file means
 * the human docs and the agent docs cannot drift apart — and the landing page
 * is rendered by the same markdown pipeline that serves every user site, so it
 * is also a live demo.
 *
 * Everything is a function of `rootDomain` so a fork can host this on its own
 * domain without editing prose. Links must be absolute: the renderer strips
 * `.md` from relative links, which is right for a published site and wrong for
 * a page that links to `/skill.md`.
 */

/** The skill and CLI name, derived from the domain — `jmp2.io` becomes `jmp2`. */
export const skillName = (rootDomain) =>
  rootDomain.split('.')[0].replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'site';

// A single-line description on purpose: the same flat `key: value` parser that
// reads frontmatter out of user documents also has to be able to read this file.
const frontmatter = (rootDomain) => `---
name: ${skillName(rootDomain)}
description: "Publish markdown files or whole folders to ${rootDomain} over HTTP and get a public shareable URL back. Use when the user wants to share a document, report, note, or set of docs as a link rather than a file - 'put this online', 'give me a link to this', 'publish these docs', 'host this markdown'. Covers publishing, updating, versioning and rollback, listing sites, and managing API tokens."
---
`;

export function skillBody(rootDomain) {
  const d = rootDomain;
  const cli = skillName(rootDomain);
  const ENV = `${cli.toUpperCase().replace(/-/g, '_')}_TOKEN`;

  return `# ${d}

Push a markdown file or a whole folder, get a public URL. Relative links and
image assets keep working. One HTTP call, no build step, no repo.

\`\`\`sh
tar czf - ./docs | curl -T - https://${d}/_api/sites/handbook/tarball \\
  -H "Authorization: Bearer $${ENV}"
# -> https://<you>.${d}/handbook/
\`\`\`

## Getting a token

Sign in at [${d}/signup](https://${d}/signup) with GitHub or Google, pick a
subdomain, and copy the token it shows once. Store it:

\`\`\`sh
mkdir -p ~/.${cli} && chmod 700 ~/.${cli}
printf '%s' '${cli}_live_...' > ~/.${cli}/token && chmod 600 ~/.${cli}/token
export ${ENV}=$(cat ~/.${cli}/token)
\`\`\`

Tokens are stored hashed, so the value is shown once and cannot be recovered.
Mint and revoke more from [your dashboard](https://${d}/account) or the API.
Reads are public; the token is only ever needed for writes.

## How URLs work

A document's URL is its path **without** the \`.md\`. That single rule is what
makes relative links written for the filesystem keep resolving on the web.

| Source file | URL |
| --- | --- |
| \`index.md\` | \`/handbook/\` |
| \`docs/api.md\` | \`/handbook/docs/api\` |
| \`docs/api.md\` (source) | \`/handbook/docs/api.md\` |
| \`docs/index.md\` | \`/handbook/docs/\` |
| \`img/a.png\` | \`/handbook/img/a.png\` |

So \`[api](./api.md)\` renders as \`href="./api"\` and resolves correctly, and
\`![](./img/a.png)\` needs no rewriting at all. Root-relative links (\`/img/a.png\`)
are rewritten to sit under the site root. \`index.md\` and \`README.md\` both map to
their directory.

## Publishing

**A whole folder.** The tarball describes the entire site, so it *replaces*:
files deleted locally disappear from the site.

\`\`\`sh
tar czf - -C ./docs . | curl -T - https://${d}/_api/sites/handbook/tarball \\
  -H "Authorization: Bearer $${ENV}"
\`\`\`

Add \`?merge=1\` to overlay onto the current version instead of replacing.
Add \`?publish=0\` to stage without going live.

**One file.** Staging a single file inherits the rest of the live version, so
this updates one page without disturbing the others:

\`\`\`sh
curl -X PUT https://${d}/_api/sites/handbook/files/docs/api.md \\
  -H "Authorization: Bearer $${ENV}" --data-binary @api.md
curl -X POST https://${d}/_api/sites/handbook/publish \\
  -H "Authorization: Bearer $${ENV}"
\`\`\`

**A single-page site.** Name the file \`index.md\` and the slug is the whole URL:

\`\`\`sh
curl -X PUT https://${d}/_api/sites/notes/files/index.md \\
  -H "Authorization: Bearer $${ENV}" --data-binary @notes.md
curl -X POST https://${d}/_api/sites/notes/publish \\
  -H "Authorization: Bearer $${ENV}"
# -> https://<you>.${d}/notes/
\`\`\`

## Visibility

Every site is one of three things. New sites are **public** unless you say
otherwise.

| State | Reachable by URL | Listed on \`<you>.${d}/\` | Needs a password |
| --- | --- | --- | --- |
| public | yes | yes | no |
| secret | yes | no | no |
| secret + password | yes | no | yes |

**Secret is unlisted, not private.** Anyone who has the URL can still read it.
Add a password when the content actually needs protecting.

\`\`\`sh
# at publish time
tar czf - -C ./docs . | curl -T - \\
  "https://${d}/_api/sites/handbook/tarball?visibility=secret" \\
  -H "Authorization: Bearer $${ENV}"

# with a password — sent as a header, never in the URL
tar czf - -C ./docs . | curl -T - \\
  https://${d}/_api/sites/handbook/tarball \\
  -H "Authorization: Bearer $${ENV}" -H "X-Site-Password: hunter2"

# or change it later
curl -X POST https://${d}/_api/sites/handbook/visibility \\
  -H "Authorization: Bearer $${ENV}" -H 'content-type: application/json' \\
  -d '{"visibility":"secret","password":"hunter2"}'

# back to public, dropping the password
curl -X POST https://${d}/_api/sites/handbook/visibility \\
  -H "Authorization: Bearer $${ENV}" -H 'content-type: application/json' \\
  -d '{"visibility":"public","password":null}'
\`\`\`

Passwords are checked with HTTP Basic auth. A username is optional: set one from
[your dashboard](https://${d}/account) and it must match, otherwise any username
is accepted. Passwords are stored
as PBKDF2-SHA256 with a per-site salt, and protected pages are never written to
the shared edge cache, so a cached copy can never be handed to someone who did
not authenticate. Clearing a password is explicit (\`"password": null\`) so a
routine publish cannot unlock a site by accident.

You can also do all of this from [your dashboard](https://${d}/account): set
visibility, the username and the password; add and edit documents in a plain
editor; and publish by dropping a markdown file, a folder, or a .zip / .tar.gz
onto the page and giving it a name. Saving there publishes a new version, so the
previous one stays available for rollback.

## Versions and rollback

Every publish writes a new version and flips a pointer only once it is complete,
so a publish is atomic and never leaves a half-updated site. The last few
versions are kept.

\`\`\`sh
curl https://${d}/_api/sites/handbook -H "Authorization: Bearer $${ENV}"
curl -X POST https://${d}/_api/sites/handbook/rollback \\
  -H "Authorization: Bearer $${ENV}" \\
  -H 'content-type: application/json' -d '{"version": 3}'
\`\`\`

## API

Base URL \`https://${d}/_api\`. Auth is \`Authorization: Bearer <token>\` on every
endpoint. All responses are JSON.

| Method | Path | Does |
| --- | --- | --- |
| \`GET\` | \`/whoami\` | tenant, quota, bytes used |
| \`GET\` | \`/sites\` | list your sites |
| \`GET\` | \`/sites/:slug\` | one site with its version history |
| \`PUT\` | \`/sites/:slug/tarball\` | stage a tar.gz — \`?merge=1\`, \`?publish=0\`, \`?strip=0\`, \`?visibility=\` |
| \`PUT\` | \`/sites/:slug/files/*path\` | stage one file (body is the bytes) |
| \`DELETE\` | \`/sites/:slug/files/*path\` | drop one file from the staged version |
| \`POST\` | \`/sites/:slug/publish\` | make the staged version live |
| \`POST\` | \`/sites/:slug/rollback\` | \`{"version": N}\` |
| \`POST\` | \`/sites/:slug/visibility\` | \`{"visibility": "public"\|"secret", "password": "..."\|null}\` |
| \`DELETE\` | \`/sites/:slug\` | delete a site and all its versions |
| \`GET\` | \`/tokens\` | list tokens (ids and metadata only) |
| \`POST\` | \`/tokens\` | mint another token |
| \`DELETE\` | \`/tokens/:id\` | revoke a token |

A tarball upload publishes by default and returns the URL:

\`\`\`json
{ "version": 2, "files": 12, "bytes": 48210,
  "title": "Handbook", "url": "https://you.${d}/handbook/", "published": true }
\`\`\`

Slugs are 1–63 characters of \`[a-z0-9-]\`. Limits: 25 MB per upload, 10 MB per
file, 2000 files, 120 writes per minute.

## Things worth knowing before you are surprised

- **A tarball replaces.** Files you deleted locally vanish from the site. Use
  \`?merge=1\` if that is not what you want.
- **Raw HTML in markdown is escaped, not rendered.** So are \`javascript:\` links.
  Uploaded \`.html\` files are served as \`text/plain\` on purpose — every subdomain
  here is somebody's own origin, and nothing user-supplied is returned as HTML.
- **Directories redirect to a trailing slash.** \`/handbook/docs\` 301s to
  \`/handbook/docs/\`, without which relative links resolve one level too high.
- **Unknown file types download** rather than render.
- **Secret means unlisted, not private.** Without a password the URL is still
  publicly readable; it is simply absent from your index.
- **\`tar czf -\` pads its output**, which some strict gzip readers reject. This
  handles it, so piping straight into \`curl -T -\` is fine.

## Errors

| Status | Means |
| --- | --- |
| 401 | token missing, revoked, or expired |
| 403 | subdomain suspended |
| 404 | no such site, token, or version |
| 413 | over quota, or past a size limit |
| 429 | rate limited — see \`Retry-After\` |

## CLI

\`\`\`sh
curl -fsSL https://${d}/cli -o /usr/local/bin/${cli} && chmod +x /usr/local/bin/${cli}
# or anywhere on your PATH:  -o ~/.local/bin/${cli}
\`\`\`

It is a single dependency-free bash script — read it before you run it.

\`\`\`sh
${cli} push handbook ./docs     # publish a folder
${cli} push notes ./notes.md    # publish one file as its own site
${cli} ls                       # list sites
${cli} info handbook            # versions
${cli} push handbook ./docs --secret          # unlisted
${cli} push handbook ./docs --password hunter2  # and password protected
${cli} secret handbook hunter2  # change an existing site
${cli} public handbook          # list it again, dropping the password
${cli} rollback handbook 3
${cli} rm handbook
${cli} tokens                   # list / token-new / token-rm <id>
\`\`\`

It reads \`${ENV}\` or \`~/.${cli}/token\`, and excludes \`node_modules\`, \`.git\`,
\`target\`, \`dist\` and friends from uploads — \`${cli} push <slug>\` with no path
defaults to the current directory, which is otherwise an easy way to upload a
whole build tree by accident.

## Install this page as a Claude Code skill

\`\`\`sh
mkdir -p ~/.claude/skills/${cli}
curl -o ~/.claude/skills/${cli}/SKILL.md https://${d}/skill.md
\`\`\`

The raw source of this page *is* the skill — [\`/skill.md\`](https://${d}/skill.md)
is the same document with frontmatter, so the docs and the skill can never drift.

## Self-hosting

The whole thing is one Cloudflare Worker with R2 and D1. Source and setup:
[github.com/c4pt0r/jmp2.io](https://github.com/c4pt0r/jmp2.io).
`;
}

export const skillMarkdown = (rootDomain) => frontmatter(rootDomain) + skillBody(rootDomain);

export const llmsTxt = (rootDomain) => `# ${rootDomain}

> Publish a markdown file or folder over HTTP and get a public shareable URL.
> Reads are public; writes need a bearer token from https://${rootDomain}/signup.

Publish: tar czf - ./docs | curl -T - https://${rootDomain}/_api/sites/<slug>/tarball -H "Authorization: Bearer $TOKEN"
Result:  https://<tenant>.${rootDomain}/<slug>/

## Docs

- [Full API and usage](https://${rootDomain}/skill.md): complete reference, as an agent skill
- [OpenAPI](https://${rootDomain}/openapi.json): machine-readable spec
- [CLI](https://${rootDomain}/cli): single-file bash client
`;

/** Minimal but accurate OpenAPI description of the write API. */
export function openApi(rootDomain) {
  const slug = {
    name: 'slug', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
  };
  const jsonOk = (description) => ({
    description, content: { 'application/json': { schema: { type: 'object' } } },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: rootDomain,
      version: '1.0.0',
      description: 'Publish markdown files and folders as public web pages.',
    },
    servers: [{ url: `https://${rootDomain}/_api` }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
    paths: {
      '/whoami': { get: { summary: 'Token identity, quota and usage', responses: { 200: jsonOk('ok') } } },
      '/sites': { get: { summary: 'List sites', responses: { 200: jsonOk('ok') } } },
      '/sites/{slug}': {
        get: { summary: 'One site with version history', parameters: [slug], responses: { 200: jsonOk('ok'), 404: jsonOk('no such site') } },
        delete: { summary: 'Delete a site', parameters: [slug], responses: { 200: jsonOk('deleted') } },
      },
      '/sites/{slug}/tarball': {
        put: {
          summary: 'Stage a tar.gz and publish it',
          description: 'Replaces the site unless merge=1. Body is the gzipped tar.',
          parameters: [
            slug,
            { name: 'merge', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'overlay instead of replace' },
            { name: 'publish', in: 'query', schema: { type: 'string', enum: ['0'] }, description: 'stage without going live' },
            { name: 'strip', in: 'query', schema: { type: 'string', enum: ['0'] }, description: 'keep the wrapping directory' },
            { name: 'visibility', in: 'query', schema: { type: 'string', enum: ['public', 'secret'] } },
            { name: 'X-Site-Password', in: 'header', schema: { type: 'string' }, description: 'set a Basic auth password; implies visibility=secret' },
          ],
          requestBody: { required: true, content: { 'application/gzip': { schema: { type: 'string', format: 'binary' } } } },
          responses: { 201: jsonOk('published'), 400: jsonOk('bad archive'), 413: jsonOk('too large or over quota') },
        },
      },
      '/sites/{slug}/files/{path}': {
        put: {
          summary: 'Stage one file',
          parameters: [slug, { name: 'path', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          responses: { 200: jsonOk('staged'), 413: jsonOk('too large or over quota') },
        },
        delete: {
          summary: 'Drop one file from the staged version',
          parameters: [slug, { name: 'path', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: jsonOk('unstaged') },
        },
      },
      '/sites/{slug}/publish': {
        post: { summary: 'Make the staged version live', parameters: [slug], responses: { 200: jsonOk('published'), 400: jsonOk('nothing staged') } },
      },
      '/sites/{slug}/rollback': {
        post: {
          summary: 'Point the site at an earlier version',
          parameters: [slug],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['version'], properties: { version: { type: 'integer' } } } } } },
          responses: { 200: jsonOk('rolled back'), 404: jsonOk('no such version') },
        },
      },
      '/sites/{slug}/visibility': {
        post: {
          summary: 'Set whether a site is listed, and its password',
          parameters: [slug],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    visibility: { type: 'string', enum: ['public', 'secret'] },
                    password: {
                      type: ['string', 'null'],
                      description: 'null clears it; omit to leave it unchanged',
                    },
                  },
                },
              },
            },
          },
          responses: { 200: jsonOk('updated'), 400: jsonOk('bad visibility or password'), 404: jsonOk('no such site') },
        },
      },
      '/tokens': {
        get: { summary: 'List tokens', responses: { 200: jsonOk('ok') } },
        post: { summary: 'Mint a token', responses: { 201: jsonOk('created, plaintext returned once') } },
      },
      '/tokens/{id}': {
        delete: { summary: 'Revoke a token', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonOk('revoked') } },
      },
    },
  };
}
