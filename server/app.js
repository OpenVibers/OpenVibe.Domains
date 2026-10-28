'use strict';

/**
 * OpenVibe.Domains — Express app factory.
 *
 *   /, /search, /tld/:tld, /d/:domain     the pages (http/pages.js)
 *   /api/v1/*                             the read-only JSON API (http/api.js)
 *   /api/health, /api/ready               liveness and truthful readiness
 *   /release.json, /release-metrics       the release manifest (openvibe-shared/release)
 *   /robots.txt, /sitemap.xml, /llms.txt  crawl artifacts (http/discovery.js)
 *   /shared/*                             this service's own pinned Frame files
 *
 * No database, no sign-in, no Events: every request reads two public OpenVibe services through
 * the cached clients in server/data/. The app factory takes them as options so tests can pass
 * stubs instead of the network.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const serve = require('openvibe-shared/serve');
const releaseLib = require('openvibe-shared/release');
const metricsLib = require('openvibe-shared/metrics');

const configLib = require('./config');
const { createHost } = require('./data/host');
const { createTools } = require('./data/tools');
const { createApi } = require('./http/api');
const { createPageRoutes } = require('./http/pages');
const { createServiceReadiness } = require('./observability');

const VERSION = require('../package.json').version;

/**
 * opts: config, host, tools, fetchImpl, log, release
 * `host` and `tools` are the two data clients; a test passes objects with the same methods.
 */
function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const host = opts.host || createHost({ baseUrl: config.hostUrl, fetchImpl, log, timeoutMs: config.timeoutMs });
    const tools = opts.tools || createTools({ baseUrl: config.toolsUrl, fetchImpl, log, timeoutMs: config.timeoutMs });

    const release = opts.release || releaseLib.createRelease({ service: 'domains', root: path.join(__dirname, '..') });
    const ctx = { config, host, tools, log, release };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    app.locals.ctx = ctx;

    // Golden-signal metrics on loopback, and the release manifest/collector. No telemetry sink:
    // Help's request telemetry writes to its database, and this service has none.
    const metrics = metricsLib.instrument(app, { service: 'domains', release: release.release });
    app.locals.metrics = metrics.registry;
    release.mount(app, { registry: metrics.registry });

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-domains', version: VERSION }));
    const readiness = createServiceReadiness({ host, tools, release: release.release });
    app.get('/api/ready', readiness.handler);

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));

    // This service's own pinned copy of the Frame, and its stylesheet (content-hashed by the views: kept a year).
    app.use('/shared', serve.handler());
    app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css'), { maxAge: '365d', immutable: true, fallthrough: false }));
    require('./views').setRelease(release.release);

    // One per-IP budget for the API and for a name query (120/min). The pages themselves are not limited here.
    const limiter = rateLimit({
        windowMs: 60_000,
        limit: config.rateLimitPerMinute || 120,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'no-store');
            return contracts.http.sendProblem(res, 429, 'rate_limited', {
                detail: 'too many requests from this address; retry shortly',
                ctx: req.ov,
            });
        },
    });
    app.use('/api/v1', limiter);
    app.use('/search', limiter);

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => {
        res.set('Cache-Control', 'no-store');
        contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route.', ctx: req.ov });
    });

    // ── Pages ───────────────────────────────────────────────
    app.use(createPageRoutes(ctx));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        // Never log request bodies.
        log.error('[OpenVibe.Domains]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', 'no-store');
        if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        return res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
