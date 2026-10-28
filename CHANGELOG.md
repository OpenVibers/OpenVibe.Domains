# Changelog

What changed in OpenVibe.Domains, newest first.

## 0.1.0 — 2026-10-28

The service skeleton: a stateless read-only front over OpenVibe.Host's price catalog and OpenVibe.Tools' public
domain history.

- **Name parsing** (`server/names.js`): a label and an optional ending from what a person types — a bare label with
  spaces or underscores, a full name, a URL with a scheme, path or port, an IDN (`münchen.de`) — normalized to ASCII
  for the Host call and kept in Unicode for display. 1–63 character labels, no edge hyphens, 253 characters total.
- **Pricing** (`server/pricing.js`): every registrar row gains `y1`, `y3`, `y5` and the renewal trap
  (`renew ≥ 2 × register` and `renew − register ≥ 5`), rounded to cents. USD rows are compared and sorted by `y3`;
  other currencies are kept after them and flagged `currency_other`.
- **Data clients** (`server/data/host.js`, `server/data/tools.js`): injectable `fetchImpl`, 8-second timeouts, a
  2,000-entry in-process cache (catalog 10 minutes, ending 10, name check 2, domain history 10), a failure is null
  and one short log line.
- **Pages** (`server/http/pages.js`): `/` (the popular first catalog page and the Tools lists), `/search?q=`
  (registry status and prices, `noindex`), `/tld/:tld`, `/.dev` 301, `/d/:domain` (public history plus its ending's
  prices), and a 404. The views are plain placeholders on the shared Frame for the main session to replace.
- **API** (`server/http/api.js`): `GET /api/v1/search?q=`, `/tlds`, `/tlds/:tld`, `/domains/:domain`; CORS-open,
  public for five minutes, 400 problem+json for a bad name, 404 for an unknown ending, and a 120/min per-IP limit
  shared with `/search`.
- **Plumbing:** helmet with Help's CSP, health, truthful readiness (Host and Tools are optional checks, so a failure
  is `degraded`, not 503), release.json and the release collector, `/shared`, robots.txt, sitemap.xml (every ending
  in the catalog pages), llms.txt, loopback-only metrics and graceful stop.
- **Repo:** deploy files (systemd, nginx), CI, README, STATUS, SECURITY, LICENSE, .env.example and four test files.
