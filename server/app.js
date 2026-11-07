'use strict';

/**
 * OpenVibe.Domains — Express app factory.
 *
 *   /, /search, /tld/:tld, /d/:domain     the pages (http/pages.js)
 *   /panel/*                              the control panel: connections, zones, proposals (http/panel.js)
 *   /auth/*                               sign-in with OpenVibe.Network, OAuth client `domains` (auth/sso.js)
 *   /api/v1/*                             the JSON API (http/api.js; the panel's in http/panel.js)
 *   /internal/events                      account export and deletion from OpenVibe.Events (loopback only)
 *   /api/health, /api/ready               liveness and truthful readiness
 *   /release.json, /release-metrics       the release manifest (openvibe-shared/release)
 *   /robots.txt, /sitemap.xml, /llms.txt  crawl artifacts (http/discovery.js)
 *   /shared/*                             this service's own pinned Frame files
 *
 * The price and info pages read two public OpenVibe services through the cached clients in server/data/. The control
 * panel keeps its own state in ov_domains (server/db.js) and its credentials in the person's Network project
 * (panel/vault.js). The factory takes every client as an option so tests can pass stubs instead of the network.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
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
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createPrincipal } = require('./http/principal');
const settingsLib = require('./settings');
const { createVault } = require('./panel/vault');
const { createCloudflare } = require('./panel/cloudflare');
const { createPorkbun } = require('./panel/porkbun');
const { createPanel } = require('./panel/panel');
const { createPanelRoutes } = require('./http/panel');
const accountDataLib = require('./identity/account-data');
const { createNetworkSender } = require('openvibe-sdk/account-data');

const VERSION = require('../package.json').version;

/**
 * opts: config, host, tools, fetchImpl, log, release, store, vault, providers, accountSend
 * `host`, `tools`, `vault` and `providers` are clients; a test passes objects with the same methods.
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const host = opts.host || createHost({ baseUrl: config.hostUrl, fetchImpl, log, timeoutMs: config.timeoutMs });
    const tools = opts.tools || createTools({ baseUrl: config.toolsUrl, fetchImpl, log, timeoutMs: config.timeoutMs });

    const release = opts.release || releaseLib.createRelease({ service: 'domains', root: path.join(__dirname, '..') });
    const store = opts.store || await openStore(config, { log });
    const keys = createKeyStore({ config, fetchImpl, log });
    const sso = createSso({ config, keys, fetchImpl, now: store.now, log });
    const principal = createPrincipal({ config, keys });
    // D11 owner settings (domains.registrars): created before the app mounts /internal/config. A failure leaves
    // Domains serving (the registrar keys fall back to the environment) and says why in the log.
    let settings = null;
    if (opts.settings) settings = opts.settings;
    else {
        try {
            const made = settingsLib.createSettings({ db: store.db, env: opts.env || process.env, log });
            await made.ready;
            settings = settingsLib.activate(made);
        } catch (err) {
            log.warn('[OpenVibe.Domains] owner settings unavailable, the registrar keys fall back to the environment:', err && err.message);
        }
    }
    const vault = opts.vault || createVault({ config, fetchImpl });
    const providers = opts.providers || { cloudflare: createCloudflare({ fetchImpl }), porkbun: createPorkbun({ fetchImpl }) };
    const panel = createPanel({ store, vault, providers, log });
    const accountData = accountDataLib.create({ db: store.db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl }) : null);
    const ctx = { config, host, tools, log, release, store, keys, sso, principal, settings, vault, panel, accountData };

    const app = express();
    // GET /openapi.json (SEO-3): this service's public API as OpenAPI 3.1, generated from the contracts
    // (openvibe-contracts); the operations they mark internal-only are left out.
    app.get('/openapi.json', (_req, res) => {
        const doc = require('openvibe-contracts').openapi.document('domains');
        if (!doc) return res.status(404).type('text/plain').send('No API document.');
        const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
        const paths = {};
        for (const [p, item] of Object.entries(doc.paths || {})) {
            const kept = {};
            for (const [k, op] of Object.entries(item || {})) {
                if (!METHODS.has(k)) { kept[k] = op; continue; }
                const vis = [].concat((op && op['x-openvibe-visibility']) || []);
                if (vis.length && vis.every((v) => v === 'internal')) continue;
                kept[k] = op;
            }
            if (Object.keys(kept).some((k) => METHODS.has(k))) paths[p] = kept;
        }
        res.set('Cache-Control', 'public, max-age=3600').set('Access-Control-Allow-Origin', '*').json({ ...doc, paths });
    });
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    app.locals.ctx = ctx;

    // Golden-signal metrics on loopback, and the release manifest/collector. No telemetry sink:
    // Help's request telemetry writes to its database, and this service has none.
    const metrics = metricsLib.instrument(app, { service: 'domains', release: release.release });
    app.locals.metrics = metrics.registry;
    release.mount(app, { registry: metrics.registry });

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-domains', version: VERSION }));
    const readiness = createServiceReadiness({ host, tools, store, release: release.release, sso});
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
                // Sign-in goes through Network's authorize page; a form never posts anywhere else.
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));

    app.use(cookieParser());

    // ── OpenVibe.Events → this service (loopback only; nginx answers 404 for /internal/). The consumer reads the raw
    // body itself, so it is mounted before any body parser.
    app.use('/internal/events', accountData.consumer({ secrets: config.events.secrets, send: accountSend }));

    // ── D11 owner settings (openvibe-shared/config): Network's admin proxy, acting for the owner, reads and
    // writes domains.registrars (the Cloudflare and Porkbun keys). Loopback only, guarded by
    // domains.config.manage; a secret change needs X-OV-Fresh: 1.
    if (settings) {
        const internalOnly = (req, res, next) => {
            if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) {
                return res.status(404).json({ code: 'domains.not_found', error: 'no such route' });
            }
            return next();
        };
        const configCapability = (req, res, next) => {
            const p = req.principal;
            if (!p || p.kind !== 'service') return res.status(401).json({ code: 'token.required', error: 'a Network service token with domains.config.manage is required' });
            const contracts = require('openvibe-contracts');
            const decision = contracts.capabilities.check(p.claims, 'domains.config.manage');
            const granted = decision.allowed || contracts.capabilities.grants(p.claims.cap, 'domains.config.manage');
            if (!granted) return res.status(403).json({ code: 'capability.denied', error: 'domains.config.manage is not granted' });
            return next();
        };
        app.use('/internal/config', express.json({ limit: '64kb' }));
        settings.mount(app, { guard: [internalOnly, principal.middleware, configCapability], log });
    }

    // ── Who is asking (the session cookie, verified offline) and sign-in ──
    app.use(sso.middleware());
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());

    // This service's own pinned copy of the Frame, and its stylesheet (content-hashed by the views: kept a year).
    app.use('/shared', serve.handler());
    // Terms, Privacy and DMCA in this site's own words (openvibe-shared/legal, profile 'public'; 11-03: the footer's
    // legal links answered 404 here). The facts must match the code: change both together.
    const legal = require('openvibe-shared/legal');
    app.get(legal.PATHS, legal.handler({
        "host": "openvibe.domains",
        "name": "OpenVibe.Domains",
        "id": "domains",
        "service": "domains",
        "profile": "public",
        "what": "Every ending and every registrar for a name, with what you will really pay over 1, 3 and 5 years, the renewal traps flagged, and each domain's public history."
    }));
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
    const panelRoutes = createPanelRoutes({ config, panel, principal, log });
    app.use('/api/v1', panelRoutes.api);
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => {
        res.set('Cache-Control', 'no-store');
        contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route.', ctx: req.ov });
    });

    // ── Pages ───────────────────────────────────────────────
    const pages = createPageRoutes(ctx);
    app.use(panelRoutes.pages);
    // ── Agent layer (openvibe-shared/agent-layer) ───────────
    // The manifest and the Markdown twins of the public pages. Gated to twin requests only, so a browser always
    // reaches the site's own route (and the panel's signed-in pages are never rendered signed out).
    {
        const agentLayer = require('openvibe-shared/agent-layer');
        const agent = express.Router();
        agent.use((req, _res, next) => {
            const twinPath = req.path.endsWith('.md');
            const twinFormat = req.query.format === 'markdown';
            const twinAccept = !!(req.headers.accept && req.accepts(['html', 'text/markdown']) === 'text/markdown');
            if (req.path === '/.well-known/agent.json' || twinPath || twinFormat || twinAccept) return next();
            return next('router');
        });
        agentLayer.mount(agent, { descriptor: require('./agent-descriptor'), render: pages.renderPublicPage });
        app.use(agent);
    }
    app.use(pages);

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
