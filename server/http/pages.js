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
 * renderPublicPage is the one model builder: the HTML routes and the agent layer's Markdown twins both use it.
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

    const send = (res, status, page, cache = PAGE_CACHE) => {
        res.status(status).set('Cache-Control', cache).type('html');
        if (page && page.canonical) res.set('Link', require('openvibe-shared/agent-layer').linkHeaderTags(page.canonical).header);
        res.send(typeof page === 'string' ? page : page.html);
    };
    const notFound = (res) => send(res, 404, views.notFound());

    /** The public model behind a path, for the HTML routes and the agent layer. null means no public page. */
    async function renderPublicPage(rawPath, { query } = {}) {
        const p = String(rawPath || '/').replace(/\/+$/, '') || '/';
        const q = query instanceof URLSearchParams ? query : new URLSearchParams();

        if (p === '/') {
            const [endings, lists] = await Promise.all([
                safe(() => host.tlds({ sort: 'popular' })),
                safe(() => tools.lists({ limit: 10 })),
            ]);
            return { html: views.home({ endings, lists, canonical: abs('/') }), title: null, canonical: abs('/') };
        }

        if (p === '/search') {
            const raw = typeof q.get('q') === 'string' ? q.get('q').trim() : '';
            const name = raw ? parseName(raw) : null;
            if (!name) return null;
            const check = await safe(() => host.check(name.ascii));
            const rows = check && Array.isArray(check.prices) ? priceRows(check.prices) : [];
            return {
                html: views.search({ name, check, rows, available: check ? check.status : 'unknown', canonical: abs('/search') }),
                title: `${name.display || name.ascii}: price and availability`,
                canonical: abs('/search'),
            };
        }

        if (p === '/tld') {
            const endings = await host.tlds({ sort: 'renew' });
            return { html: views.endings({ endings, canonical: abs('/tld') }), title: 'Every ending, cheapest to keep', canonical: abs('/tld') };
        }

        const tldMatch = p.match(/^\/tld\/([^/]+)$/);
        if (tldMatch) {
            let tld;
            try { tld = parseTld(decodeURIComponent(tldMatch[1])); } catch { tld = null; }
            if (!tld) return null;
            const detail = await safe(() => host.tld(tld));
            if (!detail) return null;
            const priced = { ...detail, prices: priceRows(detail.prices) };
            const name = priced.display || `.${priced.tld}`;
            return {
                html: views.tld({ tld: priced, canonical: abs(`/tld/${encodeURIComponent(tld)}`) }),
                title: `${name} domain prices: every registrar, 1, 3 and 5 years`,
                canonical: abs(`/tld/${encodeURIComponent(tld)}`),
            };
        }

        if (p === '/developers') {
            return { html: views.developers({ canonical: abs('/developers') }), title: 'The Domains API', canonical: abs('/developers') };
        }

        const domainMatch = p.match(/^\/d\/([^/]+)$/);
        if (domainMatch) {
            let name;
            try { name = parseName(decodeURIComponent(domainMatch[1])); } catch { name = null; }
            if (!name || !name.tld) return null;
            const [history, check] = await Promise.all([
                safe(() => tools.history(name.ascii)),
                safe(() => host.check(name.ascii)),
            ]);
            const rows = check && Array.isArray(check.prices) ? check.prices.filter((row) => row && row.tld === name.tld) : [];
            const canonical = abs(`/d/${encodeURIComponent(name.ascii)}`);
            return {
                html: views.domain({ name, history, prices: priceRows(rows), status: check ? check.status : null, check, canonical }),
                title: `${name.display || name.ascii}: public record and history`,
                canonical,
            };
        }

        return null;
    }

    r.get('/', async (_req, res) => {
        send(res, 200, await renderPublicPage('/'));
    });

    r.get('/search', async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const page = await renderPublicPage('/search', { query: new URLSearchParams({ q }) });
        if (!page) return res.redirect(302, '/');
        return send(res, 200, page, QUERY_CACHE);
    });

    r.get('/tld/:tld', async (req, res) => {
        const page = await renderPublicPage(`/tld/${encodeURIComponent(req.params.tld)}`);
        return page ? send(res, 200, page) : notFound(res);
    });

    r.get('/tld', async (_req, res) => {
        send(res, 200, await renderPublicPage('/tld'));
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
        const page = await renderPublicPage(`/d/${encodeURIComponent(req.params.domain)}`);
        return page ? send(res, 200, page, QUERY_CACHE) : notFound(res);
    });

    r.use(createDiscoveryRoutes(ctx));

    r.use((_req, res) => notFound(res));
    r.renderPublicPage = renderPublicPage;
    return r;
}

module.exports = { createPageRoutes, PAGE_CACHE, QUERY_CACHE };
