'use strict';

/**
 * /api/v1 — the read-only JSON face of OpenVibe.Domains.
 *
 *   GET /search?q=              one name: { name, status, rows }
 *   GET /tlds?q=&kind=&sort=&page=   OpenVibe.Host's list, as it answers it
 *   GET /tlds/:tld              one ending: { tld }, rows priced like the page
 *   GET /domains/:domain        { name, status, registrar, expires, history, prices }
 *
 * A bad name is 400 problem+json; an ending the catalog does not know is 404. Every GET is
 * CORS-open and cached publicly for five minutes. No route writes anything.
 */
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { parseName, parseTld } = require('../names');
const { priceRows } = require('../pricing');

const API_CACHE = 'public, max-age=300';

function createApi(ctx) {
    const { host, tools } = ctx;
    const r = asyncRouter();
    // The clients never throw; a stand-in that does answers like an upstream failure.
    const safe = (fn) => Promise.resolve().then(fn).catch(() => null);

    const problem = (req, res, status, code, detail) => {
        res.set('Cache-Control', 'no-store');
        return contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    };

    r.use((req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Cache-Control', API_CACHE);
        }
        next();
    });

    r.get('/search', async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const name = q ? parseName(q) : null;
        if (!name) return problem(req, res, 400, 'domains.name.invalid', 'Type a domain name, such as sushi truck, example.com or münchen.de.');
        const check = await safe(() => host.check(name.ascii));
        const rows = check && Array.isArray(check.prices) ? priceRows(check.prices) : [];
        return res.json({ name, status: check ? check.status : 'unknown', rows });
    });

    r.get('/tlds', async (req, res) => {
        const query = {};
        for (const key of ['q', 'kind', 'sort', 'page']) {
            if (typeof req.query[key] === 'string' && req.query[key] !== '') query[key] = req.query[key];
        }
        const list = await safe(() => host.tlds(query));
        if (!list) return problem(req, res, 502, 'domains.upstream.failed', 'OpenVibe.Host did not answer the price catalog.');
        return res.json(list);
    });

    r.get('/tlds/:tld', async (req, res) => {
        const tld = parseTld(req.params.tld);
        if (!tld) return problem(req, res, 404, 'domains.tld.not_found', 'No such domain ending.');
        const detail = await safe(() => host.tld(tld));
        if (!detail) return problem(req, res, 404, 'domains.tld.not_found', `No registrar price is listed for .${tld}.`);
        return res.json({ tld: { ...detail, prices: priceRows(detail.prices) } });
    });

    r.get('/domains/:domain', async (req, res) => {
        const name = parseName(req.params.domain);
        if (!name || !name.tld) return problem(req, res, 400, 'domains.name.invalid', 'Use a full domain name with an ending, such as example.com.');
        const [history, check] = await Promise.all([safe(() => tools.history(name.ascii)), safe(() => host.check(name.ascii))]);
        const rows = check && Array.isArray(check.prices) ? check.prices.filter((row) => row && row.tld === name.tld) : [];
        // status, registrar and expires sit at the top so a watch can follow one field (OpenVibe.Watch's value_path=status).
        return res.json({
            name, status: check ? check.status : 'unknown', registrar: check && check.registrar ? check.registrar : null,
            expires: check && check.expires ? check.expires : null, history, prices: priceRows(rows),
        });
    });

    r.use((req, res) => problem(req, res, 404, 'route.not_found', 'No such API route.'));
    return r;
}

module.exports = { createApi, API_CACHE };
