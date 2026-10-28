'use strict';

/**
 * OpenVibe.Domains configuration. Every value comes from the environment (production:
 * /etc/openvibe/domains.env, see .env.example). load(env) is pure so tests can build a config
 * without touching process.env.
 */
require('dotenv').config();

const hostManifest = require('openvibe-contracts/manifests/services/host.json');
const toolsManifest = require('openvibe-contracts/manifests/services/tools.json');

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5070);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.domains' : `http://localhost:${port}`));
    const hostUrl = trim(env.OV_HOST_INTERNAL_URL || hostManifest.internalOrigin || 'http://127.0.0.1:4910');
    const toolsUrl = trim(env.OV_TOOLS_INTERNAL_URL || toolsManifest.internalOrigin || 'https://openvibe.tools');
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'domains',
        name: 'OpenVibe.Domains',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // The two OpenVibe services the price and info pages read: both public data.
        hostUrl,
        toolsUrl,
        // Per-IP budget for /api/v1 and /search (express-rate-limit, one window).
        rateLimitPerMinute: Math.max(1, int(env.DOMAINS_RATE_LIMIT_PER_MIN, 120)),
        timeoutMs: Math.max(100, int(env.DOMAINS_UPSTREAM_TIMEOUT_MS, 8000)),
        drill: env.DOMAINS_DRILL === '1' || env.DOMAINS_DRILL === 'true',

        // The control panel's own state (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner
        // role). In development without DATABASE_URL an embedded PGlite database in data/pglite is used.
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.DOMAINS_PGLITE_DIR || '' },

        // OpenVibe.Network: sign-in (OAuth 2 with PKCE, client `domains`), its JWKS, the person's project secrets and
        // network.secret.use for revealing a connection's token for one call.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        audience: env.DOMAINS_AUDIENCE || 'openvibe.domains',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'domains',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Events → this service: account export and deletion (ADR-033) at POST /internal/events, signed with
        // one of these (comma-separated for rotation, 32+ characters each); unset turns the route off (503). The url is
        // where the two subscriptions are created at boot, off when unset or in a drill.
        events: {
            secrets: String(env.DOMAINS_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter((x) => x.length >= 32),
            url: trim(env.DOMAINS_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.DOMAINS_EVENTS_ENDPOINT || '',
        },
    };
}

module.exports = { load };
