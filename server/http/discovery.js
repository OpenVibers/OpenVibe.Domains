'use strict';

/**
 * Crawl artifacts, built with openvibe-shared/seo: robots.txt (allow everything, name the sitemap),
 * sitemap.xml (the home page and one page per ending in every page of the Host catalog) and
 * llms.txt (what the site is, its pages and its API). The sitemap's lastmod is the release's
 * released_at, never the clock.
 */
const seo = require('openvibe-shared/seo');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Domains';
const TEXT_CACHE = 'public, max-age=3600';
const MAX_PAGES = 60;

function releaseDay(release) {
    try {
        const full = release && typeof release.full === 'function' ? release.full() : release;
        const m = String((full && full.released_at) || '').match(/^(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

/** Every ending the catalog lists, across its cursor pages; a failed page just ends the walk. */
async function everyEnding(host) {
    const seen = new Map();
    let page = 1;
    let cursor = null;
    let lastToken = null;
    for (let walked = 0; walked < MAX_PAGES; walked++) {
        const query = cursor ? { sort: 'popular', cursor }
            : (page > 1 ? { sort: 'popular', page } : { sort: 'popular' });
        let list = null;
        try { list = await host.tlds(query); } catch { break; }
        if (!list || !Array.isArray(list.tlds)) break;
        for (const t of list.tlds) {
            if (t && typeof t.tld === 'string' && t.tld && !seen.has(t.tld)) seen.set(t.tld, t);
        }
        if (!list.next_cursor) break;
        const token = String(list.next_cursor);
        if (token === lastToken) break;
        lastToken = token;
        // The host pages by 100 and answers an offset cursor. A stand-in may answer a page number;
        // both are read here, and anything else is passed straight back as a cursor.
        const next = Number(token);
        if (Number.isSafeInteger(next) && next > 0) {
            if (next <= MAX_PAGES) { page = next; cursor = null; }
            else if (next % 100 === 0) { page = next / 100 + 1; cursor = null; }
            else { cursor = token; page += 1; }
        } else {
            cursor = token;
            page += 1;
        }
    }
    return [...seen.values()];
}

function createDiscoveryRoutes(ctx) {
    const { config, host, release } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (path) => `${site}${path}`;

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT_CACHE).send(seo.robotsTxt({
            sitemaps: [abs('/sitemap.xml')],
            allow: ['/'],
            disallow: [],
        }));
    });

    r.get('/sitemap.xml', async (_req, res) => {
        const lastmod = releaseDay(release);
        const endings = await everyEnding(host);
        const urls = [
            { loc: abs('/'), ...(lastmod ? { lastmod } : {}), changefreq: 'daily', priority: 1.0 },
            ...endings.map((t) => ({ loc: abs(`/tld/${encodeURIComponent(t.tld)}`), ...(lastmod ? { lastmod } : {}), changefreq: 'weekly', priority: 0.8 })),
        ];
        res.type('application/xml').set('Cache-Control', TEXT_CACHE).send(seo.sitemapXml(urls));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT_CACHE).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.Domains is a stateless front over OpenVibe.Host\'s price catalog and OpenVibe.Tools\' public domain history: for a name, whether it is registered and every registrar\'s one-, three- and five-year totals; for an ending, every registrar\'s prices; for a domain, its public registration facts over time.',
            details: 'There is no account, no database and no event stream. Every page is server-rendered and readable without JavaScript. USD is compared; other currencies are kept after it and marked. A renewal trap marks a cheap first year whose renewal is the real price.',
            sections: [
                { title: 'Pages', links: [
                    { title: 'Every ending', url: abs('/'), note: 'the price catalog, popular endings first' },
                    { title: 'Check a name', url: abs('/search?q=example.com'), note: 'registry status and registrar totals; noindex' },
                    { title: 'One ending', url: abs('/tld/dev'), note: 'every registrar\'s first year, three years and five years' },
                    { title: 'One domain', url: abs('/d/example.com'), note: 'public history from OpenVibe.Tools and its ending\'s prices' },
                ] },
                { title: 'API', links: [
                    { title: 'Search a name (JSON)', url: abs('/api/v1/search?q=example.com') },
                    { title: 'Every ending (JSON)', url: abs('/api/v1/tlds?sort=popular') },
                    { title: 'One ending (JSON)', url: abs('/api/v1/tlds/dev') },
                    { title: 'One domain (JSON)', url: abs('/api/v1/domains/example.com') },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Release metadata', url: abs('/release.json') },
                ] },
                { title: 'The data it reads', links: [
                    { title: 'OpenVibe.Host domain prices', url: 'https://openvibe.host/catalog/domains', note: 'the catalog and the registry name check' },
                    { title: 'OpenVibe.Tools domain history', url: 'https://openvibe.tools/network/whois', note: 'RDAP\'s public facts, kept over time' },
                ] },
            ],
        }));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, everyEnding, releaseDay, SITE_NAME };
