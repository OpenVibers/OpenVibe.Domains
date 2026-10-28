'use strict';

/**
 * Public pages:
 *   /                 the endings and OpenVibe.Tools' public lists
 *   /search?q=        one name: registry status and every registrar's totals (noindex)
 *   /tld/:tld         one ending and every registrar's prices
 *   /.:tld            301 to /tld/:tld
 *   /d/:domain        one domain's public history and its ending's prices
 *
 * Every page is server-rendered, complete without JavaScript and cached for a short public window
 * (five minutes, two for a name query). The views are placeholders; this file builds the model.
 */
const views = require('../views');
const { parseName, parseTld } = require('../names');
const { priceRows } = require('../pricing');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes } = require('./discovery');

const PAGE_CACHE = 'public, max-age=300';
const QUERY_CACHE = 'public, max-age=120';

function createPageRoutes(ctx) {
    const { config, host, tools } = ctx;
    const r = asyncRouter();
    const site = () => String(config.baseUrl).replace(/\/+$/, '');
    const abs = (path) => `${site()}${path}`;
    // The clients never throw; this keeps a misbehaving stand-in from turning a page into a 500.
    const safe = (fn) => Promise.resolve().then(fn).catch(() => null);

    const send = (res, status, body, cache = PAGE_CACHE) => {
        res.status(status).set('Cache-Control', cache).type('html').send(body);
    };
    const notFound = (res) => send(res, 404, views.notFound());

    r.get('/', async (_req, res) => {
        const [endings, lists] = await Promise.all([
            safe(() => host.tlds({ sort: 'popular' })),
            safe(() => tools.lists({ limit: 10 })),
        ]);
        send(res, 200, views.home({ endings, lists, canonical: abs('/') }));
    });

    r.get('/search', async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const name = q ? parseName(q) : null;
        if (!name) return res.redirect(302, '/');
        const check = await safe(() => host.check(name.ascii));
        const rows = check && Array.isArray(check.prices) ? priceRows(check.prices) : [];
        return send(res, 200, views.search({
            name, check, rows,
            available: check ? check.status : 'unknown',
            canonical: abs('/search'),
        }), QUERY_CACHE);
    });

    r.get('/tld/:tld', async (req, res) => {
        const tld = parseTld(req.params.tld);
        if (!tld) return notFound(res);
        const detail = await safe(() => host.tld(tld));
        if (!detail) return notFound(res);
        const priced = { ...detail, prices: priceRows(detail.prices) };
        return send(res, 200, views.tld({ tld: priced, canonical: abs(`/tld/${encodeURIComponent(tld)}`) }));
    });

    r.get('/tld', async (_req, res) => {
        const endings = await host.tlds({ sort: 'renew' });
        send(res, 200, views.endings({ endings, canonical: abs('/tld') }));
    });

    r.get('/developers', (_req, res) => send(res, 200, views.developers({ canonical: abs('/developers') })));

    // A person who types "/.dev" gets the ending page. The ending is normalized in one 301.
    r.get(/^\/\.([^/]+)$/, (req, res) => {
        const tld = parseTld(req.params[0]);
        if (!tld) return notFound(res);
        res.set('Cache-Control', PAGE_CACHE);
        return res.redirect(301, `/tld/${encodeURIComponent(tld)}`);
    });

    r.get('/d/:domain', async (req, res) => {
        const name = parseName(req.params.domain);
        if (!name || !name.tld) return notFound(res);
        const [history, check] = await Promise.all([
            safe(() => tools.history(name.ascii)),
            safe(() => host.check(name.ascii)),
        ]);
        const rows = check && Array.isArray(check.prices) ? check.prices.filter((row) => row && row.tld === name.tld) : [];
        return send(res, 200, views.domain({
            name, history, prices: priceRows(rows), status: check ? check.status : null, check,
            canonical: abs(`/d/${encodeURIComponent(name.ascii)}`),
        }), QUERY_CACHE);
    });

    r.use(createDiscoveryRoutes(ctx));

    r.use((_req, res) => notFound(res));
    return r;
}

module.exports = { createPageRoutes, PAGE_CACHE, QUERY_CACHE };
