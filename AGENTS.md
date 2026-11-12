# AGENTS.md — OpenVibe.Domains

## Project overview

"Name it, price it, run it." Domains is two things: a **stateless read-only front** over OpenVibe.Host's
price catalog and OpenVibe.Tools' public registry data (availability, registrar prices with 1/3/5-year
totals, per-ending pages, a domain's public registration history), and a **v2 control panel** where a
person connects a registrar/DNS account and every change is a reviewable proposal. Node.js/Express,
PostgreSQL for the panel, server-rendered, CommonJS, **no build step**.

- Service id `domains`, port `5070`, origin `https://openvibe.domains`, unit `openvibe-domains.service`,
  release root `/opt/openvibe.domains`.
- v1 has **no database, no sign-in, no session, no event stream**; it stores nothing and writes nothing.
  v2 adds the panel's own `ov_domains` state and Network project secrets for credentials.

## What it owns

- Pages `/`, `/search?q=`, `/tld/:tld`, `/.<ending>` (301 to `/tld/<ending>`), `/d/:domain`, 404 — all
  server-rendered, readable without JavaScript, in the OpenVibe Frame.
- The price arithmetic: `y1 = register`, `y3 = register + 2 × renew`, `y5 = five_year` or
  `register + 4 × renew`; `trap` when `renew ≥ 2 × register` **and** `renew − register ≥ 5`; a total
  needing a missing price is `null`, never `NaN`; only USD rows are compared/sorted, other currencies
  follow with `currency_other: true`.
- The panel (`/panel`): connections (Cloudflare API token with Edit zone DNS + Zone Read, or a Porkbun
  key pair), zones synced into `domains_zones`, records read live, proposals and their application.
- `domains.proposal@1`: create/update/delete records, why, what could break, a 7-day decision window; a
  registrar change is an `NS` list update or a `DNSSEC DS` create/delete. Approve on `/panel/p/:id` or in
  the Action Center; changes apply in order; a record change applies through the provider API.
- The JSON API under `/api/v1` (read-only in v1; the panel's routes in v2), discovery files, health/ready.
- `ov_domains` migrations (`0001_panel.sql`, `0002_config.sql`).

Not owned: the prices and registry data (Host/Tools), the domains themselves and their DNS truth (the
registrar), credentials (a person's Network project secret, ADR-056), identity (Network).

## Who calls it, and whom it calls

- Callers: people in the browser; the Action Center (proposal approvals); services with a Network service
  token audience `openvibe.domains` and the route's capability.
- Depends on:
  - **OpenVibe.Host** — its internal API (`OV_HOST_INTERNAL_URL`) for the price catalog/check rows.
  - **OpenVibe.Tools** — its internal API (`OV_TOOLS_INTERNAL_URL`) for "most looked up", "expiring soon"
    and a domain's public history.
  - **OpenVibe.Network** — SSO client `domains`, JWKS, and the person's project secret store; a provider
    credential is stored as a **secret in the person's own Network project** (`OpenVibe.Domains`,
    ADR-056), granted to `domains` for calls to that provider only
    (`https://api.cloudflare.com` or `https://api.porkbun.com`), revealed per call (`network.secret.use`)
    and never kept here. Porkbun's key pair is one JSON secret, parsed only inside its client.
  - **Events** — account export/deletion; the Action Center's proposal flow.
  - PostgreSQL (`DATABASE_URL`, `DATABASE_DIRECT_URL` for migrations) and the pinned SDK/Shared.

The two data clients are cached and bounded (`DOMAINS_UPSTREAM_TIMEOUT_MS`, default 8 s); a Host/Tools
failure shows what is available, never a fabricated price.

## Repository map

- **Entry:** [server/index.js](server/index.js) — `createApp()`, listen, graceful stop.
- **App:** [server/app.js](server/app.js) — `/`/`/search`/`/tld/:tld`/`/d/:domain`, `/panel/*`, `/auth`,
  `/api/v1`, `/internal/events`, `/internal/config`, `/shared`, `/css`, discovery, health/ready/release.
- **Config/db:** [server/config.js](server/config.js), [server/db.js](server/db.js),
  [server/settings.js](server/settings.js).
- **Data/pricing:** [server/data/host.js](server/data/host.js), [server/data/tools.js](server/data/tools.js),
  [server/data/cache.js](server/data/cache.js), [server/pricing.js](server/pricing.js),
  [server/names.js](server/names.js).
- **Panel:** [server/panel/panel.js](server/panel/panel.js),
  [server/panel/vault.js](server/panel/vault.js), [server/panel/cloudflare.js](server/panel/cloudflare.js),
  [server/panel/porkbun.js](server/panel/porkbun.js).
- **HTTP/views:** [server/http/api.js](server/http/api.js), `pages.js`, `panel.js`, `principal.js`,
  `discovery.js`, `router.js`; [server/views/](server/views/) (`index.js`, `panel.js`, `short.js`).
- **Auth:** [server/auth/sso.js](server/auth/sso.js), [server/auth/keys.js](server/auth/keys.js).
- **Deploy:** [deploy/systemd/openvibe-domains.service](deploy/systemd/openvibe-domains.service),
  [deploy/nginx/openvibe.domains.conf](deploy/nginx/openvibe.domains.conf).

## Commands

```bash
npm install
npm run dev                # http://localhost:5070
npm start                  # production
npm test                   # test/run.js, each file in its own process, stub upstreams
npm test -- data           # filter by file name; --strict makes a skip fail
ov test                    # the harness's sharded run of what the change reaches
node --check <file.js>
```

The tests need no database, no network and no running OpenVibe site.

## Database and migrations

The v1 pages need no database. The v2 panel uses `ov_domains` on the host's data role (ADR-035):
`domains_zones` and the proposal/config state from [migrations/](migrations/). Async through
`openvibe-sdk/db`; never edit an applied migration, add a new number. **A provider credential is never a
row here** — only its Network project/secret name; the value is revealed per call.

## Auth and panel security

- v1 pages are public and anonymous; a read is the same for every caller and no session is created.
- The panel signs a person in through Network SSO (client `domains`, PKCE); the person's Network token is
  used for their project secrets.
- A provider token/key is verified before storage, stored in the **person's own Network project** with a
  grant limited to that provider's origin, and revealed only when a call is made. Nothing is logged or
  echoed; Porkbun's JSON pair is parsed only in its client.
- Every DNS change is a proposal with a reason, a risk note and a 7-day window; apply in order, and record
  the outcome. A registrar change (`NS`/`DS`) uses the registrar API.
- Service callers need the route's capability (`domains.*`); account export/deletion goes through
  `/internal/events` only.

## Frontend loading model

All pages are server-rendered and readable without JavaScript; the Frame comes from `openvibe-shared/shell`
(theme loader, navbar into `#navbar-mount`, shared footer), and `/shared/*` is served from the pinned
node_modules. There is no SPA, bundler or transpiler. `/css/domains.css` is the only page CSS served here.

## Deploy

Unit [deploy/systemd/openvibe-domains.service](deploy/systemd/openvibe-domains.service) runs
`/opt/openvibe.domains/server/index.js` as `ubuntu` on port `5070`, env `/etc/openvibe/domains.env`; vhost
[deploy/nginx/openvibe.domains.conf](deploy/nginx/openvibe.domains.conf) (TLS, `www`→apex 301, GET-only
`/api/v1`, loopback-only metrics). The repository does not document an `ovhost deploy domains` command —
use the host's own service installer. CI runs syntax/contracts/security and has no database service.

## Tests

`npm test` runs [test/run.js](test/run.js) with stub upstreams: [test/data.test.js](test/data.test.js)
(pricing arithmetic, missing price → `null`, currency handling, renew-trap), `test/home-short.test.js`,
`test/agent-layer.test.js`, `test/account-data.test.js` and helpers. No network or database is needed.
`ov test` runs the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; data clients and panel providers are injectable
  factories so tests pass stubs.
- Money is integer minor units / rounded cents with a currency; a total that needs a missing input is
  `null`, not `0` or `NaN`.
- Prices are labelled with their check date (`checked_at`) and source; "as of" is part of the page.
- Errors are small JSON problems or the 404 page; a provider/upstream failure is a clear notice, not a 500.

## Pitfalls

- **Never fabricate a price or a total.** Missing input → `null`; only USD rows are compared; other
  currencies are kept and flagged, never silently converted.
- **The renew trap is a warning, not an exclusion**: `renew ≥ 2 × register` and `renew − register ≥ 5`;
  do not reorder the list by it.
- **Credentials belong to the person's Network project**, never to `ov_domains`, an env file or a log; a
  provider grant is limited to that provider's origin and revealed per call.
- **Every DNS change is a proposal** with a reason, risk, 7-day window and ordered application; do not add
  a direct "apply now" admin path.
- **`/.<ending>` must 301** to `/tld/<ending>`; a new ending route keeps that alias.
- **v1 stays read-only**; do not add a write API to the price pages.
- **The `www` host canonicalises to the apex**; keep the 301.
- **Loopback-only metrics and GET-only `/api/v1`** in the vhost; do not widen it for a new route without
  the nginx test.

## Documentation

- [README.md](README.md) — the pages, panel, API, what "priced" means, the data it reads, configuration,
  run, machine endpoints, deploy.
- [STATUS.json](STATUS.json) — the v1/v2 state.
- OpenVibe.Contracts holds `domains.*`/`domains.proposal@1`; Host/Tools/Network own their upstream shapes.
