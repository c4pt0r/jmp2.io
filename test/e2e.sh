#!/usr/bin/env bash
# End-to-end smoke test against a running `wrangler dev`.
#   npx wrangler dev --port 8787 --local &
#   ./test/e2e.sh
#
# Uses real hostnames pinned to loopback with --resolve: wrangler derives the
# request URL from the connection, so a plain `Host:` header would not reach
# the subdomain routing at all.
set -euo pipefail

PORT="${PORT:-8787}"
ADMIN="${ADMIN_TOKEN:-dev-admin-token-local-only}"
TENANT="${TENANT:-dongxu}"
SLUG="${SLUG:-handbook}"

APEX="http://jmp2.io:$PORT"
SUB="http://$TENANT.jmp2.io:$PORT"
R=()
for h in jmp2.io "$TENANT.jmp2.io" acme.jmp2.io nobody.jmp2.io admin.jmp2.io \
         octosite.jmp2.io second-try.jmp2.io; do
  R+=(--resolve "$h:$PORT:127.0.0.1")
done
c() { curl -s "${R[@]}" "$@"; }
status() { curl -s "${R[@]}" -o /dev/null -w '%{http_code}' "$@"; }
# Headers only, lowercased: curl capitalizes some names, and a binary body
# would otherwise be fed through tr.
hdrs() { curl -s "${R[@]}" -D - -o /dev/null "$@" | tr -d '\r' | tr 'A-Z' 'a-z'; }

pass=0; fail=0
check() {
  if [[ "$2" == "$3" ]]; then printf '  ok   %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}
contains() {
  if [[ "$3" == *"$2"* ]]; then printf '  ok   %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL %s\n       missing: %s\n' "$1" "$2"; fail=$((fail+1)); fi
}
absent() {
  if [[ "$3" != *"$2"* ]]; then printf '  ok   %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL %s\n       unexpectedly present: %s\n' "$1" "$2"; fail=$((fail+1)); fi
}

# The suite asserts on absolute state (tenant lists, rate-limit counters, "this
# name is taken"), so it starts from a clean local database every time.
echo "== reset local state =="
npx wrangler d1 execute jmp2 --local -y --command \
  "DELETE FROM files; DELETE FROM versions; DELETE FROM sites; DELETE FROM tokens; DELETE FROM tenants; DELETE FROM rate_limits;" \
  > /dev/null 2>&1 || { echo "could not reset the local D1 database"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SITE="$WORK/docs"
mkdir -p "$SITE/img" "$SITE/guide"

cat > "$SITE/index.md" <<'MD'
---
title: Handbook
---
# Handbook

Welcome. See the [API reference](./api.md) and the [guide](./guide/).

![logo](./img/logo.png)

<script>alert(1)</script>
[bad](javascript:alert(1))
MD

cat > "$SITE/api.md" <<'MD'
# API

Back to [home](./index.md). Root-relative asset: ![logo](/img/logo.png)
MD

cat > "$SITE/guide/index.md" <<'MD'
# Guide

Sibling image: ![logo](../img/logo.png)
MD

printf '\x89PNG\r\n\x1a\nFAKE' > "$SITE/img/logo.png"
printf '<html>phish</html>' > "$SITE/evil.html"

echo "== admin: create tenant and token =="
c -X POST "$APEX/_api/admin/tenants" -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d "{\"id\":\"$TENANT\",\"name\":\"Dongxu\"}" > /dev/null || true
TOKEN=$(c -X POST "$APEX/_api/admin/tokens" -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d "{\"tenant_id\":\"$TENANT\",\"name\":\"e2e\"}" \
  | sed -n 's/.*"token": "\([^"]*\)".*/\1/p')
[[ -n "$TOKEN" ]] || { echo "could not mint a token"; exit 1; }
echo "  token: ${TOKEN:0:18}..."

echo "== landing page, skill and machine-readable docs =="
LAND=$(c "$APEX/")
contains "landing page renders the api table" "/sites/:slug/tarball" "$LAND"
contains "landing page states the api base url" "https://jmp2.io/_api" "$LAND"
contains "landing page offers signup" 'href="/signup"' "$LAND"
contains "landing page links the raw skill" 'href="/skill.md"' "$LAND"
contains "landing page ships the theme toggle" 'data-theme-toggle' "$LAND"
contains "landing page defines a dark override" '[data-theme="dark"]' "$LAND"
absent  "landing page has no colour accent" "#2563eb" "$LAND"

SKILL=$(c "$APEX/skill.md")
contains "skill.md carries frontmatter" "name: jmp2" "$SKILL"
contains "skill.md has a description" "description:" "$SKILL"
contains "skill.md documents publishing" "tarball" "$SKILL"
contains "skill.md is served as plain text" "content-type: text/plain" "$(hdrs "$APEX/skill.md")"
check "SKILL.md resolves too" 200 "$(status "$APEX/SKILL.md")"

contains "llms.txt points at the skill" "https://jmp2.io/skill.md" "$(c "$APEX/llms.txt")"
contains "openapi is json" "content-type: application/json" "$(hdrs "$APEX/openapi.json")"
OPENAPI=$(c "$APEX/openapi.json")
contains "openapi declares bearer auth" '"bearerAuth"' "$OPENAPI"
contains "openapi documents the tarball route" '/sites/{slug}/tarball' "$OPENAPI"
printf '%s' "$OPENAPI" | python3 -c "import json,sys; json.load(sys.stdin)" \
  && { printf '  ok   openapi parses as json\n'; pass=$((pass+1)); } \
  || { printf '  FAIL openapi parses as json\n'; fail=$((fail+1)); }

CLI=$(c "$APEX/cli")
contains "cli is served" "#!/usr/bin/env bash" "$CLI"
contains "the served cli points at this deployment" "https://jmp2.io" "$CLI"
contains "cli is plain text" "content-type: text/plain" "$(hdrs "$APEX/cli")"
check "/jmp2 is an alias for /cli" 200 "$(status "$APEX/jmp2")"
# The download has to be runnable, not just present.
printf '%s' "$CLI" > "$WORK/jmp2-downloaded"
chmod +x "$WORK/jmp2-downloaded"
bash -n "$WORK/jmp2-downloaded" \
  && { printf '  ok   the downloaded cli parses as bash\n'; pass=$((pass+1)); } \
  || { printf '  FAIL the downloaded cli parses as bash\n'; fail=$((fail+1)); }
contains "the downloaded cli runs" "jmp2 push" "$(bash "$WORK/jmp2-downloaded" help)"
contains "landing page documents installing the cli" "https://jmp2.io/cli" "$LAND"

CSPH=$(hdrs "$APEX/")
contains "csp pins the theme script by hash" "script-src 'sha256-" "$CSPH"
absent  "csp never allows inline script" "script-src 'unsafe-inline'" "$CSPH"

echo "== auth =="
check "no token is rejected" 401 "$(status "$APEX/_api/whoami")"
check "bad token is rejected" 401 "$(status "$APEX/_api/whoami" -H 'Authorization: Bearer jmp2_live_nope')"
contains "whoami names the tenant" "\"tenant\": \"$TENANT\"" \
  "$(c "$APEX/_api/whoami" -H "Authorization: Bearer $TOKEN")"
check "admin endpoint rejects a site token" 401 \
  "$(status -X POST "$APEX/_api/admin/tenants" -H "Authorization: Bearer $TOKEN" -d '{"id":"x2"}')"

echo "== publish a folder as a tarball =="
tar czf "$WORK/site.tar.gz" -C "$WORK" docs
PUB=$(c -T "$WORK/site.tar.gz" "$APEX/_api/sites/$SLUG/tarball" -H "Authorization: Bearer $TOKEN")
contains "publish reports a url" "$TENANT.jmp2.io/$SLUG/" "$PUB"
contains "publish counted all five files" '"files": 5' "$PUB"

echo "== serving =="
check "site root renders" 200 "$(status "$SUB/$SLUG/")"
HOME_HTML=$(c "$SUB/$SLUG/")
contains "title from frontmatter" "<title>Handbook" "$HOME_HTML"
contains "sidebar lists the guide" "/$SLUG/guide/" "$HOME_HTML"
absent  "raw script tag is escaped" "<script>alert(1)</script>" "$HOME_HTML"
contains "escaped script is shown as text" "&lt;script&gt;" "$HOME_HTML"
absent  "javascript: href is neutralized" 'href="javascript:' "$HOME_HTML"
contains "md link lost its extension" 'href="./api"' "$HOME_HTML"
contains "image src preserved" 'src="./img/logo.png"' "$HOME_HTML"
# User pages allow exactly one script: the hash-pinned theme toggle. Anything
# injected has a different hash and is still blocked.
DOCCSP=$(hdrs "$SUB/$SLUG/")
contains "csp pins scripts to one hash" "script-src 'sha256-" "$DOCCSP"
absent  "csp never allows inline script on user pages" "script-src 'unsafe-inline'" "$DOCCSP"
contains "user pages still cannot post forms" "form-action 'none'" "$DOCCSP"

check "extensionless doc renders" 200 "$(status "$SUB/$SLUG/api")"
API_HTML=$(c "$SUB/$SLUG/api")
contains "root-relative asset is remounted" "src=\"/$SLUG/img/logo.png\"" "$API_HTML"
contains "index.md link points at the directory" 'href="./"' "$API_HTML"

echo "== raw source and assets =="
contains "raw .md is text/plain" "content-type: text/plain" "$(hdrs "$SUB/$SLUG/api.md")"
contains "raw .md is the source" "# API" "$(c "$SUB/$SLUG/api.md")"
contains "png keeps its type" "content-type: image/png" "$(hdrs "$SUB/$SLUG/img/logo.png")"
HTML_HDR=$(hdrs "$SUB/$SLUG/evil.html")
contains "uploaded .html is defused to text/plain" "content-type: text/plain" "$HTML_HDR"
contains "nosniff is set" "x-content-type-options: nosniff" "$HTML_HDR"

echo "== every page type shares the shell =="
for page in "$SUB/" "$SUB/$SLUG/" "$APEX/" "$APEX/signup"; do
  H=$(c "$page")
  contains "toggle present on $page" "data-theme-toggle" "$H"
  absent  "no leftover accent colour on $page" "#2563eb" "$H"
done

echo "== redirects and 404s =="
check "directory without slash redirects" 301 "$(status "$SUB/$SLUG/guide")"
contains "redirect target has the slash" "location: /$SLUG/guide/" \
  "$(hdrs "$SUB/$SLUG/guide")"
check "bare slug redirects" 301 "$(status "$SUB/$SLUG")"
check "missing doc is 404" 404 "$(status "$SUB/$SLUG/nope")"
check "unknown site is 404" 404 "$(status "$SUB/nosuchsite/")"
check "unknown tenant is 404" 404 "$(status "http://nobody.jmp2.io:$PORT/$SLUG/")"
check "reserved subdomain is 404" 404 "$(status "http://admin.jmp2.io:$PORT/")"
check "traversal is refused" 404 "$(status --path-as-is "$SUB/$SLUG/../../etc/passwd")"
check "writes are refused on a tenant host" 405 \
  "$(status -X PUT "$SUB/$SLUG/x.md" -H "Authorization: Bearer $TOKEN" -d hi)"
check "apex serves a landing page" 200 "$(status "$APEX/")"

echo "== single-file update and republish =="
c -X PUT "$APEX/_api/sites/$SLUG/files/api.md" -H "Authorization: Bearer $TOKEN" \
  --data-binary '# API v2' > /dev/null
absent "staged edit is not live yet" "API v2" "$(c "$SUB/$SLUG/api")"
c -X POST "$APEX/_api/sites/$SLUG/publish" -H "Authorization: Bearer $TOKEN" > /dev/null
contains "published edit is live" "API v2" "$(c "$SUB/$SLUG/api")"
contains "old assets survive the republish" "content-type: image/png" \
  "$(hdrs "$SUB/$SLUG/img/logo.png")"

echo "== rollback =="
c -X POST "$APEX/_api/sites/$SLUG/rollback" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"version":1}' > /dev/null
absent "rollback restores the previous version" "API v2" "$(c "$SUB/$SLUG/api")"

echo "== a tarball replaces, it does not merge =="
SHRUNK="$WORK/shrunk"; mkdir -p "$SHRUNK/docs"
cp "$SITE/index.md" "$SHRUNK/docs/index.md"
tar czf "$WORK/shrunk.tar.gz" -C "$SHRUNK" docs
c -T "$WORK/shrunk.tar.gz" "$APEX/_api/sites/$SLUG/tarball" -H "Authorization: Bearer $TOKEN" > /dev/null
check "site root still renders" 200 "$(status "$SUB/$SLUG/")"
check "a file dropped from the folder is gone" 404 "$(status "$SUB/$SLUG/api")"
check "an asset dropped from the folder is gone" 404 "$(status "$SUB/$SLUG/img/logo.png")"

echo "== merge mode keeps what the tarball omits =="
c -T "$WORK/site.tar.gz" "$APEX/_api/sites/$SLUG/tarball" -H "Authorization: Bearer $TOKEN" > /dev/null
c -T "$WORK/shrunk.tar.gz" "$APEX/_api/sites/$SLUG/tarball?merge=1" -H "Authorization: Bearer $TOKEN" > /dev/null
check "omitted file survives a merge" 200 "$(status "$SUB/$SLUG/api")"

echo "== tenant isolation =="
c -X POST "$APEX/_api/admin/tenants" -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"id":"acme"}' > /dev/null || true
ACME=$(c -X POST "$APEX/_api/admin/tokens" -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"tenant_id":"acme"}' \
  | sed -n 's/.*"token": "\([^"]*\)".*/\1/p')
check "another tenant cannot see this site" 404 \
  "$(status "$APEX/_api/sites/$SLUG" -H "Authorization: Bearer $ACME")"
check "same slug in another tenant is independent" 404 "$(status "http://acme.jmp2.io:$PORT/$SLUG/")"

echo "== token self-management =="
TOKENS=$(c "$APEX/_api/tokens" -H "Authorization: Bearer $TOKEN")
contains "the token in use is marked current" '"current": true' "$TOKENS"
absent "plaintext is never listed" 'jmp2_live_' "$TOKENS"
SECOND=$(c -X POST "$APEX/_api/tokens" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"second"}')
SECOND_ID=$(printf '%s' "$SECOND" | sed -n 's/.*"id": "\([^"]*\)".*/\1/p')
SECOND_TOK=$(printf '%s' "$SECOND" | sed -n 's/.*"token": "\([^"]*\)".*/\1/p')
check "the new token works" 200 "$(status "$APEX/_api/whoami" -H "Authorization: Bearer $SECOND_TOK")"
c -X DELETE "$APEX/_api/tokens/$SECOND_ID" -H "Authorization: Bearer $TOKEN" > /dev/null
check "a revoked token stops working" 401 \
  "$(status "$APEX/_api/whoami" -H "Authorization: Bearer $SECOND_TOK")"
check "the original token still works" 200 "$(status "$APEX/_api/whoami" -H "Authorization: Bearer $TOKEN")"
check "another tenant cannot revoke this token" 404 \
  "$(status -X DELETE "$APEX/_api/tokens/$SECOND_ID" -H "Authorization: Bearer $ACME")"

echo "== quota =="
contains "whoami reports usage" '"used_bytes"' "$(c "$APEX/_api/whoami" -H "Authorization: Bearer $TOKEN")"
npx wrangler d1 execute jmp2 --local --command \
  "UPDATE tenants SET quota_bytes = 10 WHERE id = '$TENANT'" -y > /dev/null 2>&1
check "an over-quota upload is refused" 413 \
  "$(status -T "$WORK/site.tar.gz" "$APEX/_api/sites/quotatest/tarball" -H "Authorization: Bearer $TOKEN")"
check "an over-quota single file is refused" 413 \
  "$(status -X PUT "$APEX/_api/sites/$SLUG/files/big.md" -H "Authorization: Bearer $TOKEN" --data-binary 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')"
check "the site is untouched by the refused write" 200 "$(status "$SUB/$SLUG/")"
npx wrangler d1 execute jmp2 --local --command \
  "UPDATE tenants SET quota_bytes = 1073741824 WHERE id = '$TENANT'" -y > /dev/null 2>&1
check "writes resume once quota is restored" 200 \
  "$(status -X PUT "$APEX/_api/sites/$SLUG/files/ok.md" -H "Authorization: Bearer $TOKEN" --data-binary '# ok')"

echo "== suspension =="
c -X POST "$APEX/_api/admin/tenants/$TENANT/disable" -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"reason":"e2e"}' > /dev/null
check "a suspended tenant cannot write" 403 "$(status "$APEX/_api/whoami" -H "Authorization: Bearer $TOKEN")"
check "a suspended tenant stops serving" 403 "$(status "$SUB/$SLUG/")"
c -X POST "$APEX/_api/admin/tenants/$TENANT/enable" -H "Authorization: Bearer $ADMIN" > /dev/null
check "resuming restores writes" 200 "$(status "$APEX/_api/whoami" -H "Authorization: Bearer $TOKEN")"
check "resuming restores serving" 200 "$(status "$SUB/$SLUG/")"

# We know the dev SESSION_SECRET, so a real session can be minted here and the
# claim path exercised end to end without involving GitHub.
mint_session() {
  node -e "
    const s=require('crypto');
    const body=Buffer.from(JSON.stringify({gh:process.argv[1],login:process.argv[2],exp:Math.floor(Date.now()/1000)+600})).toString('base64url');
    const sig=s.createHmac('sha256','dev-session-secret-local-only').update(body).digest('base64url');
    process.stdout.write(body+'.'+sig);
  " "$1" "$2"
}

echo "== claiming an invite-created tenant =="
OWNED=$(c -X POST "$APEX/_api/admin/tenants/$TENANT/owner" -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"github_login":"c4pt0r"}')
contains "an existing tenant can be bound to a github account" '"github_id": "773853"' "$OWNED"
check "an unknown github login is refused" 404 \
  "$(status -X POST "$APEX/_api/admin/tenants/$TENANT/owner" -H "Authorization: Bearer $ADMIN" \
     -H 'content-type: application/json' -d '{"github_login":"definitely-not-a-real-user-xyzzy-9999"}')"
check "a malformed login is refused before hitting github" 400 \
  "$(status -X POST "$APEX/_api/admin/tenants/$TENANT/owner" -H "Authorization: Bearer $ADMIN" \
     -H 'content-type: application/json' -d '{"github_login":"has spaces/and-slashes"}')"
check "one github account cannot own two tenants" 409 \
  "$(status -X POST "$APEX/_api/admin/tenants/acme/owner" -H "Authorization: Bearer $ADMIN" \
     -H 'content-type: application/json' -d '{"github_login":"c4pt0r"}')"
OWNER_SESS=$(mint_session 773853 c4pt0r)
contains "a bound owner is sent to the dashboard" "location: /account" \
  "$(hdrs "$APEX/signup" -H "Cookie: __Host-jmp2_session=$OWNER_SESS")"
contains "the dashboard shows the bound tenant" "$TENANT.jmp2.io" \
  "$(c "$APEX/account" -H "Cookie: __Host-jmp2_session=$OWNER_SESS")"
c -X DELETE "$APEX/_api/admin/tenants/$TENANT/owner" -H "Authorization: Bearer $ADMIN" > /dev/null

echo "== signup flow =="
check "signup page renders" 200 "$(status "$APEX/signup")"
contains "signed-out signup offers github" '/auth/github' "$(c "$APEX/signup")"
START=$(hdrs "$APEX/auth/github")
contains "auth start redirects to github" "location: https://github.com/login/oauth/authorize" "$START"
contains "auth start carries a state param" "state=" "$START"
contains "auth start sets a host-locked cookie" "set-cookie: __host-jmp2_session=" "$START"
check "callback with a bad state is refused" 400 "$(status "$APEX/auth/github/callback?code=x&state=nope")"
check "claim without a session redirects" 302 \
  "$(status -X POST "$APEX/auth/claim" -d 'subdomain=someone')"
check "claim with a forged cookie is refused" 302 \
  "$(status -X POST "$APEX/auth/claim" -d 'subdomain=someone' -H 'Cookie: __Host-jmp2_session=eyJnaCI6IjEifQ.forged')"

SESS=$(mint_session 4242 octocat)
CLAIM=$(c -X POST "$APEX/auth/claim" -d 'subdomain=octosite' -H "Cookie: __Host-jmp2_session=$SESS")
contains "claiming creates the subdomain" "octosite.jmp2.io" "$CLAIM"
contains "the first token is shown once" "jmp2_live_" "$CLAIM"
NEWTOK=$(printf '%s' "$CLAIM" | grep -o 'jmp2_live_[A-Za-z0-9]*' | head -1)
contains "the issued token identifies the new tenant" '"tenant": "octosite"' \
  "$(c "$APEX/_api/whoami" -H "Authorization: Bearer $NEWTOK")"
check "a reserved name is refused" 200 \
  "$(status -X POST "$APEX/auth/claim" -d 'subdomain=admin' -H "Cookie: __Host-jmp2_session=$(mint_session 5151 someone)")"
contains "a reserved name says why" "reserved" \
  "$(c -X POST "$APEX/auth/claim" -d 'subdomain=login' -H "Cookie: __Host-jmp2_session=$(mint_session 5151 someone)")"
contains "a taken name is refused" "is taken" \
  "$(c -X POST "$APEX/auth/claim" -d 'subdomain=octosite' -H "Cookie: __Host-jmp2_session=$(mint_session 5252 someone)")"
contains "a second claim is sent to the existing dashboard" "location: /account" \
  "$(hdrs -X POST "$APEX/auth/claim" -d 'subdomain=second-try' -H "Cookie: __Host-jmp2_session=$SESS")"
check "the second name was not created" 404 "$(status "http://second-try.jmp2.io:$PORT/")"
contains "signup redirects an existing tenant to the dashboard" "location: /account" \
  "$(hdrs "$APEX/signup" -H "Cookie: __Host-jmp2_session=$SESS")"

echo "== personal dashboard =="
# The signup session for the tenant claimed above doubles as a dashboard login.
check "signed-out account redirects to signup" 302 "$(status "$APEX/account")"
contains "signup sends an existing owner to the dashboard" "location: /account" \
  "$(hdrs "$APEX/signup" -H "Cookie: __Host-jmp2_session=$SESS")"

DASH=$(c "$APEX/account" -H "Cookie: __Host-jmp2_session=$SESS")
contains "dashboard names the subdomain" "octosite.jmp2.io" "$DASH"
contains "dashboard shows quota usage" "used" "$DASH"
contains "dashboard offers a sign out" "/auth/signout" "$DASH"
contains "dashboard lists the signup token" "signup" "$DASH"
absent "dashboard never prints a token value" "jmp2_live_" "$DASH"

# Publish something as that tenant so the site table has a row to show.
c -T "$WORK/site.tar.gz" "$APEX/_api/sites/notes/tarball" -H "Authorization: Bearer $NEWTOK" > /dev/null
DASH=$(c "$APEX/account" -H "Cookie: __Host-jmp2_session=$SESS")
contains "dashboard lists a published site" "octosite.jmp2.io/notes/" "$DASH"
contains "dashboard shows the live version" "v1" "$DASH"
contains "dashboard shows the file count" "<td>5</td>" "$DASH"

echo "== dashboard token actions =="
MINTED=$(c -X POST "$APEX/account/tokens" -H "Cookie: __Host-jmp2_session=$SESS" \
  -H 'origin: https://jmp2.io' -d 'name=from-dashboard')
contains "minting shows the value once" "jmp2_live_" "$MINTED"
DASHTOK=$(printf '%s' "$MINTED" | grep -o 'jmp2_live_[A-Za-z0-9]*' | head -1)
check "the dashboard-minted token works" 200 \
  "$(status "$APEX/_api/whoami" -H "Authorization: Bearer $DASHTOK")"
DASHID=$(c "$APEX/_api/tokens" -H "Authorization: Bearer $DASHTOK" \
  | python3 -c "import json,sys; print(next(t['id'] for t in json.load(sys.stdin)['tokens'] if t['current']))")
check "revoking from the dashboard redirects back" 302 \
  "$(status -X POST "$APEX/account/tokens/$DASHID/revoke" -H "Cookie: __Host-jmp2_session=$SESS" -H 'origin: https://jmp2.io')"
check "the revoked token stops working" 401 \
  "$(status "$APEX/_api/whoami" -H "Authorization: Bearer $DASHTOK")"
check "a cross-site mint is rejected" 403 \
  "$(status -X POST "$APEX/account/tokens" -H "Cookie: __Host-jmp2_session=$SESS" -H 'origin: https://evil.example')"
check "a cross-site revoke is rejected" 403 \
  "$(status -X POST "$APEX/account/tokens/$DASHID/revoke" -H "Cookie: __Host-jmp2_session=$SESS" -H 'origin: https://evil.example')"
check "a forged session cannot reach the dashboard" 302 \
  "$(status "$APEX/account" -H 'Cookie: __Host-jmp2_session=eyJnaCI6IjQyNDIifQ.forged')"

echo "== rate limiting =="
for i in $(seq 1 62); do status "$APEX/_api/admin/tenants" -H "Authorization: Bearer $ADMIN" > /dev/null; done
check "admin requests are rate limited" 429 \
  "$(status "$APEX/_api/admin/tenants" -H "Authorization: Bearer $ADMIN")"
contains "the 429 tells the client when to retry" "retry-after:" \
  "$(hdrs "$APEX/_api/admin/tenants" -H "Authorization: Bearer $ADMIN")"

echo "== delete =="
c -X DELETE "$APEX/_api/sites/$SLUG" -H "Authorization: Bearer $TOKEN" > /dev/null
check "deleted site is gone" 404 "$(status "$SUB/$SLUG/")"

echo
printf 'passed %d, failed %d\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
