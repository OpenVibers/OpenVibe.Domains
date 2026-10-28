'use strict';

/** The pages, the API, the crawl artifacts and readiness, against stub Host and Tools clients. */
const assert = require('assert');
const { boot, check, done } = require('./helpers');

const LIST = [
    { tld: 'com', display: '.com', kind: 'generic', currency: 'USD', register: 9.2, renew: 11.08, transfer: 9.2, five_year: 55.4, registrars: 2, checked_at: '2026-10-22T15:16:02.303Z' },
    { tld: 'dev', display: '.dev', kind: 'generic', currency: 'USD', register: 8.75, renew: 12.87, transfer: 12.87, five_year: 60.23, registrars: 2, checked_at: '2026-10-22T15:16:02.303Z' },
];

const PRICES = [
    { registrar: 'Porkbun', registrar_slug: 'porkbun', tld: 'dev', display: '.dev', kind: 'generic', currency: 'USD', register: 8.75, renew: 12.87, transfer: 12.87, five_year: 60.23, checked_at: '2026-10-22T15:16:02.303Z' },
    { registrar: 'OVHcloud', registrar_slug: 'ovhcloud', tld: 'dev', display: '.dev', kind: 'generic', currency: 'USD', register: 13.19, renew: 17.19, transfer: 17.19, five_year: 81.95, checked_at: '2026-10-22T15:16:02.303Z' },
    { registrar: 'Com Registrar', registrar_slug: 'com-registrar', tld: 'com', display: '.com', kind: 'generic', currency: 'USD', register: 9.2, renew: 11.08, transfer: 9.2, five_year: 55.4, checked_at: '2026-10-22T15:16:02.303Z' },
    { registrar: 'Euro Registrar', registrar_slug: 'euro', tld: 'dev', display: '.dev', kind: 'generic', currency: 'EUR', register: 5, renew: 6, transfer: 5, five_year: null, checked_at: '2026-10-22T15:16:02.303Z' },
];

const HISTORY = {
    ok: true,
    domain: 'example.com',
    snapshots: [{
        facts: { registrar: 'Example Registrar', created: '1995-08-14T04:00:00.000Z', expires: '2026-08-13T04:00:00.000Z', status: ['client transfer prohibited'] },
        first_seen: '2026-10-01T00:00:00.000Z', last_seen: '2026-10-28T00:00:00.000Z', seen: 2,
    }],
    changes: [],
    lookups: 42,
    first_seen: '2026-10-01T00:00:00.000Z',
};
const LISTS = {
    ok: true,
    most_looked_up: [{ domain: 'example.com', lookups: 42, registrar: 'Example Registrar', expires: '2026-08-13T04:00:00.000Z' }],
    expiring_soon: [],
    min_lookups: 5,
};

function fakeRelease() {
    const full = { release: 'abc1234', released_at: '2026-10-28T12:00:00.000Z' };
    return {
        release: full.release,
        full: () => full,
        mount(app) {
            app.get('/release.json', (_req, res) => res.json(full));
            app.post('/release-metrics', (_req, res) => res.status(204).end());
        },
    };
}

function stubs() {
    let failHost = false;
    let lastList = null;
    let checkCalls = 0;
    const host = {
        async tlds(query = {}) {
            lastList = query;
            if (failHost) return null;
            return { tlds: LIST, next_cursor: null };
        },
        async tld(t) {
            if (t !== 'dev' && t !== 'com') return null;
            return {
                tld: t, display: `.${t}`, kind: 'generic', currency: 'USD',
                prices: PRICES.filter((p) => p.tld === t),
                cheapest: { register: 8.75, renew: 12.87, transfer: 12.87, five_year: 60.23 },
                history: [],
            };
        },
        async check(name) {
            checkCalls++;
            return {
                label: String(name).split('.')[0], labelDisplay: String(name).split('.')[0], tld: 'dev', name: String(name), display: String(name),
                status: 'available', registrar: null, created: null, expires: null, server: null, reason: null, cached: false,
                prices: PRICES,
            };
        },
    };
    const tools = {
        async history(domain) { return { ...HISTORY, domain }; },
        async lists() { return LISTS; },
    };
    return {
        host, tools,
        failHost: (value) => { failHost = value; },
        lastList: () => lastList,
        checkCalls: () => checkCalls,
    };
}

(async () => {
    const s = stubs();
    const t = await boot({ host: s.host, tools: s.tools, release: fakeRelease() });
    try {
        await check('GET /: 200, the Frame mount and the endings', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=300/);
            for (const marker of ['id="navbar-mount"', 'OpenVibeNavbar.init', '"service":"domains"', 'id="ov-footer"', '.dev']) {
                assert.ok(r.text.includes(marker), `missing ${marker}`);
            }
            assert.strictEqual(s.lastList().sort, 'popular');
        });

        await check('GET /search?q=sushi truck: 200, noindex, prices', async () => {
            const r = await t.get('/search?q=sushi%20truck');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=120/);
            assert.match(r.text, /<meta name="robots" content="noindex[^"]*">/, 'no noindex meta');
            assert.ok(r.text.includes('sushitruck'), 'name missing');
            assert.ok(/Available to register/.test(r.text), 'status missing');
            assert.ok(r.text.includes('href="/search?q=sushitruck.com"') && r.text.includes('$31.36'), 'price row missing (an ending that checks this name, with its 3-year total)');
        });

        await check('GET /search without a name: 302 to /', async () => {
            const r = await t.get('/search');
            assert.strictEqual(r.status, 302);
            assert.strictEqual(r.headers.get('location'), '/');
            const bad = await t.get('/search?q=-x.com');
            assert.strictEqual(bad.status, 302);
            assert.strictEqual(bad.headers.get('location'), '/');
        });

        await check('GET /tld/dev: 200 with priced rows; /.dev: 301; unknown: 404', async () => {
            const r = await t.get('/tld/dev');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=300/);
            assert.ok(r.text.includes('.dev') && r.text.includes('Porkbun') && r.text.includes('$34.49'), 'priced ending missing');
            const redirect = await t.get('/.dev');
            assert.strictEqual(redirect.status, 301);
            assert.strictEqual(redirect.headers.get('location'), '/tld/dev');
            const missing = await t.get('/tld/notreal');
            assert.strictEqual(missing.status, 404);
            assert.ok(missing.text.includes('Not found'));
        });

        await check('GET /d/example.com: 200 with history and its ending\'s prices; bad domain: 404', async () => {
            const r = await t.get('/d/example.com');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=120/);
            assert.ok(r.text.includes('example.com'));
            assert.ok(r.text.includes('Example Registrar'), 'history missing');
            // A check's price rows are per ending (Host aggregates registrars): the page shows the domain's own ending only.
            assert.ok(r.text.includes('href="/tld/com"') && !r.text.includes('href="/tld/dev"'), 'prices should be the com rows only');
            assert.ok(r.text.includes('$9.20') && r.text.includes('$31.36'), 'the .com totals (first year, 3 years)');
            const bad = await t.get('/d/not-a-domain');
            assert.strictEqual(bad.status, 404);
        });

        await check('any other page: 404', async () => {
            const r = await t.get('/nope');
            assert.strictEqual(r.status, 404);
            assert.ok(r.text.includes('Not found'));
        });

        await check('API search: shape, rows, CORS and the 400 problem', async () => {
            const r = await t.get('/api/v1/search?q=sushitruck');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
            assert.match(r.headers.get('cache-control') || '', /public, max-age=300/);
            const json = r.json();
            assert.strictEqual(json.name.label, 'sushitruck');
            assert.strictEqual(json.status, 'available');
            assert.strictEqual(json.rows.length, 4);
            assert.strictEqual(json.rows[0].tld, 'com');
            assert.strictEqual(json.rows[0].y1, 9.2);
            assert.strictEqual(json.rows[0].y3, 31.36);
            assert.strictEqual(json.rows[3].currency_other, true);
            const bad = await t.get('/api/v1/search?q=');
            assert.strictEqual(bad.status, 400);
            assert.match(bad.headers.get('content-type') || '', /application\/problem\+json/);
            assert.strictEqual(bad.json().code, 'domains.name.invalid');
            assert.strictEqual(bad.headers.get('access-control-allow-origin'), '*');
        });

        await check('API tlds: the host list as is, one ending priced, unknown 404', async () => {
            const list = await t.get('/api/v1/tlds?sort=popular');
            assert.strictEqual(list.status, 200);
            assert.strictEqual(list.headers.get('access-control-allow-origin'), '*');
            assert.strictEqual(list.json().tlds.length, 2);
            assert.strictEqual(s.lastList().sort, 'popular');
            const one = await t.get('/api/v1/tlds/dev');
            assert.strictEqual(one.status, 200);
            assert.strictEqual(one.json().tld.tld, 'dev');
            assert.strictEqual(one.json().tld.prices[0].y3, 34.49);
            const missing = await t.get('/api/v1/tlds/notreal');
            assert.strictEqual(missing.status, 404);
            assert.match(missing.headers.get('content-type') || '', /application\/problem\+json/);
        });

        await check('API domains: name, history, its ending\'s prices; bad name 400', async () => {
            const r = await t.get('/api/v1/domains/example.com');
            assert.strictEqual(r.status, 200);
            const json = r.json();
            assert.strictEqual(json.name.ascii, 'example.com');
            assert.strictEqual(json.history.domain, 'example.com');
            assert.strictEqual(json.prices.length, 1);
            assert.strictEqual(json.prices[0].tld, 'com');
            assert.strictEqual(json.prices[0].y5, 55.4);
            const bad = await t.get('/api/v1/domains/not-a-name');
            assert.strictEqual(bad.status, 400);
            assert.strictEqual(bad.json().code, 'domains.name.invalid');
            const nope = await t.get('/api/v1/nope');
            assert.strictEqual(nope.status, 404);
            assert.strictEqual(nope.json().code, 'route.not_found');
        });

        await check('robots.txt allows all and names the sitemap', async () => {
            const r = await t.get('/robots.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type') || '', /^text\/plain/);
            assert.ok(r.text.includes('Allow: /'));
            assert.ok(r.text.includes('Sitemap: https://openvibe.domains/sitemap.xml'));
            assert.ok(!r.text.includes('Disallow: /'), 'nothing should be disallowed');
        });

        await check('sitemap.xml lists the home page and every ending, lastmod from the release', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type') || '', /^application\/xml/);
            assert.ok(r.text.includes('<loc>https://openvibe.domains/</loc>'));
            assert.ok(r.text.includes('<loc>https://openvibe.domains/tld/dev</loc>'));
            assert.ok(r.text.includes('<loc>https://openvibe.domains/tld/com</loc>'));
            assert.ok(r.text.includes('<lastmod>2026-10-28</lastmod>'));
        });

        await check('llms.txt describes the site and its API', async () => {
            const r = await t.get('/llms.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type') || '', /^text\/plain/);
            assert.ok(r.text.startsWith('# OpenVibe.Domains'));
            assert.ok(r.text.includes('https://openvibe.domains/api/v1/search?q=example.com'));
            assert.ok(r.text.includes('https://openvibe.host/catalog/domains'));
        });

        await check('health is ok; readiness is ready while both upstreams answer', async () => {
            const health = await t.get('/api/health');
            assert.strictEqual(health.status, 200);
            assert.deepStrictEqual(health.json(), { status: 'ok', service: 'openvibe-domains', version: '0.1.0' });
            const ready = await t.get('/api/ready');
            assert.strictEqual(ready.status, 200);
            const json = ready.json();
            assert.strictEqual(json.ready, true);
            assert.strictEqual(json.status, 'ready');
            assert.strictEqual(json.checks.host.status, 'ok');
            assert.strictEqual(json.checks.tools.status, 'ok');
        });

        await check('readiness is degraded, not 503, when Host does not answer', async () => {
            s.failHost(true);
            const r = await t.get('/api/ready');
            s.failHost(false);
            assert.strictEqual(r.status, 200);
            const json = r.json();
            assert.strictEqual(json.ready, true);
            assert.strictEqual(json.status, 'degraded');
            assert.ok(json.degraded.includes('host'));
            assert.strictEqual(json.failed.length, 0);
        });

        await check('release.json is served', async () => {
            const r = await t.get('/release.json');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.json().release, 'abc1234');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
