'use strict';

/**
 * OpenVibe.Host's price catalog (GET /api/v1/catalog/domains, .../check?name=, .../:tld).
 * Read-only, cached briefly in this process, and never allowed to throw into a page: a failure is
 * null and one short log line.
 */
const hostManifest = require('openvibe-contracts/manifests/services/host.json');
const { createCache, fetchJson } = require('./cache');

const DEFAULT_BASE = String(hostManifest.internalOrigin || 'http://127.0.0.1:4910').replace(/\/+$/, '');
const CACHE_MS = {
    list: 10 * 60_000,
    tld: 10 * 60_000,
    check: 2 * 60_000,
};

function createHost(opts = {}) {
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
        try { log.warn(`[domains] Host ${what} failed: ${String((err && err.message) || err).slice(0, 180)}`); } catch { /* logging must not throw */ }
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

    /** GET /api/v1/catalog/domains — the host list as it answers it: { tlds, next_cursor }. */
    async function tlds({ q, kind, sort, page, cursor, fresh = false } = {}) {
        const params = new URLSearchParams();
        if (q != null && q !== '') params.set('q', String(q));
        if (kind != null && kind !== '') params.set('kind', String(kind));
        if (sort != null && sort !== '') params.set('sort', String(sort));
        if (cursor != null && cursor !== '') {
            params.set('cursor', String(cursor));
        } else if (page != null && page !== '' && Number(page) !== 1) {
            const n = Number(page);
            // The host pages by 100 with an opaque cursor; a numeric page maps to its offset.
            params.set('cursor', Number.isSafeInteger(n) && n > 1 ? String((n - 1) * 100) : String(page));
        }
        const query = params.toString();
        return read(`list:${query}`, ttl('list'), `${baseUrl}/api/v1/catalog/domains${query ? `?${query}` : ''}`, 'list', { fresh });
    }

    /** GET /api/v1/catalog/domains/:tld — one ending with every registrar's prices. */
    async function tld(value) {
        if (value == null || value === '') return null;
        const key = `tld:${String(value)}`;
        const body = await read(key, ttl('tld'), `${baseUrl}/api/v1/catalog/domains/${encodeURIComponent(String(value))}`, 'TLD');
        return body && body.tld ? body.tld : null;
    }

    /** GET /api/v1/catalog/domains/check?name= — the registry answer and the popular endings' prices. */
    async function check(name) {
        if (name == null || name === '') return null;
        const params = new URLSearchParams({ name: String(name) });
        const key = `check:${String(name)}`;
        const body = await read(key, ttl('check'), `${baseUrl}/api/v1/catalog/domains/check?${params}`, 'check');
        return body && body.check ? body.check : null;
    }

    return { tlds, tld, check };
}

module.exports = { createHost, CACHE_MS, DEFAULT_BASE };
