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

    return {
        service: 'domains',
        name: 'OpenVibe.Domains',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // The two OpenVibe services this front reads. Both are read-only, public data.
        hostUrl,
        toolsUrl,
        // Per-IP budget for /api/v1 and /search (express-rate-limit, one window).
        rateLimitPerMinute: Math.max(1, int(env.DOMAINS_RATE_LIMIT_PER_MIN, 120)),
        timeoutMs: Math.max(100, int(env.DOMAINS_UPSTREAM_TIMEOUT_MS, 8000)),
    };
}

module.exports = { load };
