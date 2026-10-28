'use strict';

/**
 * OpenVibe.Tools' public domain history (GET /api/v1/domains and /api/v1/domains/:domain): the
 * snapshots of RDAP's public registration facts, what changed and how often a name was looked up.
 * Read-only, cached for ten minutes, and never allowed to throw into a page.
 */
const toolsManifest = require('openvibe-contracts/manifests/services/tools.json');
const { createCache, fetchJson } = require('./cache');

const DEFAULT_BASE = String(toolsManifest.internalOrigin || 'https://openvibe.tools').replace(/\/+$/, '');
const CACHE_MS = { history: 10 * 60_000, lists: 10 * 60_000 };

function createTools(opts = {}) {
    const baseUrl = String(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000;
    const log = opts.log || console;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const cache = createCache({ now, max: opts.maxCacheEntries });
    const ttl = (name) => {
        const configured = opts.cacheMs && Number(opts.cacheMs[name]);
        return configured >= 0 ? configured : CACHE_MS[name];
    };

    const fail = (what, err) => {
        try { log.warn(`[domains] Tools ${what} failed: ${String((err && err.message) || err).slice(0, 180)}`); } catch { /* logging must not throw */ }
    };

    async function read(key, ttlMs, url, what, { fresh = false } = {}) {
        if (!fresh) {
            const hit = cache.get(key);
            if (hit !== undefined) return hit;
        }
        try {
            const data = await fetchJson(fetchImpl, url, { timeoutMs });
            cache.set(key, data, ttlMs);
            return data;
        } catch (err) {
            fail(what, err);
            return null;
        }
    }

    /** GET /api/v1/domains/:domain — snapshots, changes, lookups and first_seen. */
    async function history(domain) {
        if (domain == null || domain === '') return null;
        const name = String(domain).trim().toLowerCase().replace(/\.$/, '');
        if (!name) return null;
        return read(`history:${name}`, ttl('history'), `${baseUrl}/api/v1/domains/${encodeURIComponent(name)}`, 'history');
    }

    /** GET /api/v1/domains/ — the most looked up domains and those expiring within 60 days. */
    async function lists({ limit, fresh = false } = {}) {
        const params = new URLSearchParams();
        const n = Number(limit);
        if (Number.isFinite(n) && n > 0) params.set('limit', String(Math.min(100, Math.floor(n))));
        const query = params.toString();
        return read(`lists:${query}`, ttl('lists'), `${baseUrl}/api/v1/domains/${query ? `?${query}` : ''}`, 'lists', { fresh });
    }

    return { history, lists };
}

module.exports = { createTools, CACHE_MS, DEFAULT_BASE };
