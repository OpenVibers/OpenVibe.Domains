# OpenVibe.Domains

> Name it, price it, run it.

**Status:** v1 is the service skeleton (see [STATUS.json](STATUS.json)); the pages are plain placeholders.
**Domain:** `openvibe.domains` · **Port:** 5070 · **Service id:** `domains` · **Env prefix:** `DOMAINS`
**License:** AGPL-3.0-only (same as every OpenVibe service).

OpenVibe.Domains is a stateless read-only front over two OpenVibe services. For a name it shows the registry's
availability and every registrar's prices for that ending, with one-, three- and five-year totals; every ending has
its own page; every domain has a page with its public registration history.

There is no database, no sign-in, no session and no event stream. Nothing is stored and nothing is written.

## Pages (v1)

| Route | What it shows |
|---|---|
| `/` | the first page of OpenVibe.Host's price catalog (popular endings), plus OpenVibe.Tools' public "most looked up" and "expiring soon" lists when it answers |
| `/search?q=` | registry status for the name, and every registrar's first-year, three-year and five-year totals, sorted by the three-year total; `noindex` because every query is a page |
| `/tld/:tld` | one ending (`.dev`, `co.uk`) with every registrar's prices, the five-year total and the renewal-trap mark |
| `/.<ending>` | 301 to `/tld/<ending>` (for example `/.dev` → `/tld/dev`) |
| `/d/:domain` | a full domain: its public history from OpenVibe.Tools and its ending's prices from OpenVibe.Host |
| anything else | the 404 page |

All of it is server-rendered and readable without JavaScript. The shell is the OpenVibe Frame (`openvibe-shared/shell`):
theme loader, navbar mounted into `#navbar-mount`, the shared server-rendered footer, service id `domains`.

## The control panel (v2)

`/panel` is a signed-in person's own (sign-in with OpenVibe.Network, client `domains`).

- **Connect:** paste a Cloudflare API token (Edit zone DNS + Zone Read) or a Porkbun API key pair (create keys at
  porkbun.com/account/api, then switch on API access for each domain). Domains verifies it, then stores it as a
  secret in your own Network project (`OpenVibe.Domains`, ADR-056), granted to `domains` for calls to that provider
  only (`https://api.cloudflare.com` or `https://api.porkbun.com`). It is revealed per call (`network.secret.use`)
  and never kept here. Porkbun's pair is one JSON secret, parsed only inside its client.
- **Zones and records:** zones are synced into `domains_zones` (Porkbun's domains are its zones); records are read
  live.
- **Proposals:** every change is a `domains.proposal@1`: create, update or delete records, why, what could break, and
  7 days to decide. A registrar change is a nameserver list update (`NS`) or a DNSSEC DS create/delete (`DS`), applied
  through the registrar API. Approve on `/panel/p/:id` or in the Action Center. Changes apply in order; a record or
  nameserver list that moved since the proposal stops the run (stale). An applied (or part-applied) proposal rolls
  back in one step.
- **API:** `GET /api/v1/panel/connections`, `/api/v1/panel/zones`, `/api/v1/panel/zones/:conn/:zone/records`,
  `GET|POST /api/v1/proposals`, `POST /api/v1/proposals/:id/decide|rollback` with your Network token; Network's Action
  Center reads `GET /api/v1/actions?subject=` (`domains.actions.read`) and decides (`domains.proposal.decide`).

## API

Everything under `/api/v1`, read-only, CORS-open (`Access-Control-Allow-Origin: *`), cached publicly for five
minutes. A bad name is RFC 9457 `application/problem+json`; an ending the catalog does not know is 404.

| Route | Answer |
|---|---|
| `GET /api/v1/search?q=` | `{ name, status, rows }` — `name` is `{ label, tld, ascii, display }`, `status` is the registry's answer, `rows` are the priced registrar rows |
| `GET /api/v1/tlds?q=&kind=&sort=&page=` | OpenVibe.Host's list as it answers it: `{ tlds, next_cursor }`. Sorts: `popular`, `tld`, `register`, `renew`, `five_year` |
| `GET /api/v1/tlds/:tld` | `{ tld }` with its prices priced like the page |
| `GET /api/v1/domains/:domain` | `{ name, history, prices }` — history from OpenVibe.Tools, prices for that domain's ending only |

`/api/v1` and `/search` share a per-IP limit of 120 requests a minute (`express-rate-limit`).

## What "priced" means

OpenVibe.Host's check rows carry `register`, `renew`, `five_year`, `registrars`, `currency`, `checked_at`, `tld`,
`display` and `kind`. Each row gains:

- `y1` — first year: `register`;
- `y3` — three years: `register + 2 × renew`;
- `y5` — five years: the catalog's `five_year` when it has one, else `register + 4 × renew`;
- `trap` — `renew ≥ 2 × register` **and** `renew − register ≥ 5`: the cheap-first-year renewal trap.

A total that needs a missing price is `null`, never `NaN`. Money is rounded to cents. Only USD rows are compared and
sorted (by `y3`, rows without a `y3` last); other currencies are kept after them and flagged `currency_other: true`.

## The data it reads

| Source | Endpoint | Used for | Cache |
|---|---|---|---|
| OpenVibe.Host | `GET /api/v1/catalog/domains?sort=…&cursor=…` | the catalog's ending list and the sitemap | 10 minutes |
| OpenVibe.Host | `GET /api/v1/catalog/domains/:tld` | one ending's registrar prices and history | 10 minutes |
| OpenVibe.Host | `GET /api/v1/catalog/domains/check?name=` | a name's registry status and priced endings | 2 minutes |
| OpenVibe.Tools | `GET /api/v1/domains/` | the public most-looked-up and expiring-soon lists | 10 minutes |
| OpenVibe.Tools | `GET /api/v1/domains/:domain` | a domain's public snapshots and changes | 10 minutes |

Both clients take an injectable `fetchImpl`, time out after 8 seconds, and keep a small in-process `Map` cache with a
2,000-entry cap (oldest insertion out). A failure is `null` and one short log line — never an exception in a page.
The upstream URLs come from `OV_HOST_INTERNAL_URL` / `OV_TOOLS_INTERNAL_URL`, or the internal origins in the pinned
OpenVibe.Contracts manifests, with `https://openvibe.tools` as the Tools fallback.

OpenVibe.Tools keeps RDAP's public registration facts only (registrar, dates, status codes, name servers, DNSSEC) and
publishes a domain on its lists only after at least five lookups. This service adds no data of its own.

## Configuration

Copy [.env.example](.env.example) to the environment file (`/etc/openvibe/domains.env` in production):

| Variable | Default | What |
|---|---|---|
| `NODE_ENV` | `development` | `production` selects the production base URL |
| `PORT` | `5070` | listen port |
| `HOST` | `127.0.0.1` | listen address |
| `BASE_URL` | `https://openvibe.domains` in production | public origin used for canonical URLs, the sitemap and llms.txt |
| `TRUST_PROXY` | `2` | how many proxies to trust (nginx and the CDN) |
| `OV_HOST_INTERNAL_URL` | the Host manifest's `internalOrigin` | OpenVibe.Host's internal API |
| `OV_TOOLS_INTERNAL_URL` | the Tools manifest's `internalOrigin` | OpenVibe.Tools' internal API |
| `DOMAINS_RATE_LIMIT_PER_MIN` | `120` | the shared `/api/v1` and `/search` per-IP budget |
| `DOMAINS_UPSTREAM_TIMEOUT_MS` | `8000` | the two data clients' timeout |

## Run it

```bash
npm install
npm test                 # every test/*.test.js, each in its own process, with stub upstreams
npm run dev              # http://localhost:5070
npm start                # production
```

The tests need no database, no network and no running OpenVibe site. `node --check` every `.js` file is the other
gate.

## Machine endpoints

| Route | What |
|---|---|
| `/api/health` | `{ status: "ok", service: "openvibe-domains", version }` |
| `/api/ready` | truthful readiness (`openvibe-shared/ready`): `ready` while the process serves; a Host or Tools failure makes `status: "degraded"` and names it, never 503 |
| `/release.json`, `/release-metrics` | the release manifest and the tab collector (`openvibe-shared/release`) |
| `/metrics` | Prometheus text format, loopback only (`openvibe-shared/metrics`) |
| `/shared/*` | this service's own pinned OpenVibe Frame files |
| `/robots.txt` | allow everything, name the sitemap |
| `/sitemap.xml` | `/` and one `/tld/<ending>` per ending in every page of the Host catalog; `lastmod` from the release |
| `/llms.txt` | what the site is, its pages and its API |

## Deploy

- `deploy/systemd/openvibe-domains.service` — user `ubuntu`, `WorkingDirectory=/opt/openvibe.domains`,
  `EnvironmentFile=/etc/openvibe/domains.env`, port 5070.
- `deploy/nginx/openvibe.domains.conf` — TLS, `www` → apex 301, proxy to `127.0.0.1:5070`, security headers, GET-only
  `/api/v1`, loopback-only metrics.
- CI: `.github/workflows/ci.yml` runs the shared syntax/contracts/security jobs; there is no database service.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

<!-- versions:start -->
- openvibe-contracts: v0.233.0
- openvibe-sdk: v0.74.0
- openvibe-shared: v4.82.0
<!-- versions:end -->
