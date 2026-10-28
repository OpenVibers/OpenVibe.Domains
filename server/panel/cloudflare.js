'use strict';

/**
 * Cloudflare's official API (v4) for the control panel: one person's API token, passed to each call and never kept,
 * logged or returned. Only https://api.cloudflare.com is ever called (ORIGIN), the same origin the token's Network grant
 * names, so a revealed token cannot be sent anywhere else.
 *
 *   const cf = createCloudflare({ fetchImpl });
 *   await cf.verify(token)                       → { ok: true } | { ok: false, reason }
 *   await cf.zones(token)                        → [{ id, name, status, name_servers, plan }]
 *   await cf.records(token, zoneId)              → [record]
 *   await cf.record(token, zoneId, id)           → record | null
 *   await cf.create(token, zoneId, rec) / update(token, zoneId, id, rec) / remove(token, zoneId, id)
 *
 * A record is domains.proposal@1's shape: { id, type, name, content, ttl, proxied, priority, comment }.
 */
const ORIGIN = 'https://api.cloudflare.com';
const BASE = `${ORIGIN}/client/v4`;
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME']);
const PRIORITY = new Set(['MX', 'SRV']);
const MAX_ZONE_PAGES = 10;      // 500 zones
const MAX_RECORD_PAGES = 20;    // 2 000 records in one zone

class ProviderError extends Error {
    constructor(status, message, code = 'provider.error') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** The provider's record as domains.proposal@1 keeps it. */
function normalize(r) {
    if (!r || typeof r !== 'object') return null;
    const type = String(r.type || '').toUpperCase();
    return {
        id: r.id ? String(r.id) : null,
        type,
        name: String(r.name || ''),
        content: String(r.content == null ? '' : r.content),
        ttl: Number.isInteger(r.ttl) ? r.ttl : 1,
        proxied: PROXIABLE.has(type) ? Boolean(r.proxied) : null,
        priority: PRIORITY.has(type) && Number.isInteger(r.priority) ? r.priority : null,
        comment: typeof r.comment === 'string' && r.comment ? r.comment.slice(0, 100) : null,
    };
}

/** The body Cloudflare takes for a create or a full update. */
function bodyOf(rec) {
    const type = String(rec.type).toUpperCase();
    const out = { type, name: rec.name, content: rec.content, ttl: Number.isInteger(rec.ttl) ? rec.ttl : 1 };
    if (PROXIABLE.has(type)) out.proxied = Boolean(rec.proxied);
    if (PRIORITY.has(type) && Number.isInteger(rec.priority)) out.priority = rec.priority;
    if (typeof rec.comment === 'string' && rec.comment) out.comment = rec.comment.slice(0, 100);
    return out;
}

function createCloudflare({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    async function call(token, method, path, body) {
        if (typeof token !== 'string' || !token) throw new ProviderError(401, 'The connection has no token.', 'provider.no_token');
        let res;
        try {
            res = await fetchImpl(`${BASE}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                redirect: 'error',
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
            throw new ProviderError(502, timedOut ? 'Cloudflare did not answer in time.' : 'Cloudflare could not be reached.', 'provider.unreachable');
        }
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.success !== false) return data;
        // Cloudflare's own words for what went wrong (they never carry the token).
        const first = data && Array.isArray(data.errors) && data.errors[0];
        const words = first && first.message ? String(first.message).slice(0, 300) : `Cloudflare answered ${res.status}.`;
        if (res.status === 401 || res.status === 403) throw new ProviderError(res.status, `Cloudflare refused the token: ${words}`, 'provider.forbidden');
        if (res.status === 404) throw new ProviderError(404, words, 'provider.not_found');
        throw new ProviderError(res.status >= 500 ? 502 : 422, words, 'provider.refused');
    }

    async function pages(token, path, maxPages, perPage) {
        const out = [];
        for (let page = 1; page <= maxPages; page++) {
            const sep = path.includes('?') ? '&' : '?';
            const data = await call(token, 'GET', `${path}${sep}page=${page}&per_page=${perPage}`);
            const list = Array.isArray(data.result) ? data.result : [];
            out.push(...list);
            const info = data.result_info || {};
            if (!list.length || !info.total_pages || page >= info.total_pages) break;
        }
        return out;
    }

    return {
        ORIGIN,
        /** A user token verifies at /user/tokens/verify; an account token does not, so a zone read decides. */
        async verify(token) {
            try {
                const data = await call(token, 'GET', '/user/tokens/verify');
                const status = data.result && data.result.status;
                return status === 'active' ? { ok: true } : { ok: false, reason: `The token is ${status || 'not active'}.` };
            } catch (err) {
                if (err.code === 'provider.unreachable') return { ok: false, reason: err.message };
                try {
                    await call(token, 'GET', '/zones?per_page=1');
                    return { ok: true };
                } catch (err2) {
                    return { ok: false, reason: err2.code === 'provider.forbidden' ? 'Cloudflare refused this token. Check it can read your zones (Zone: Read) and edit DNS (DNS: Edit).' : err2.message };
                }
            }
        },
        async zones(token) {
            return (await pages(token, '/zones', MAX_ZONE_PAGES, 50)).map((z) => ({
                id: String(z.id), name: String(z.name || '').toLowerCase(), status: z.status ? String(z.status) : null,
                name_servers: Array.isArray(z.name_servers) ? z.name_servers.map(String).slice(0, 8) : [],
                plan: z.plan && z.plan.name ? String(z.plan.name) : null,
            }));
        },
        async records(token, zoneId) {
            return (await pages(token, `/zones/${encodeURIComponent(zoneId)}/dns_records`, MAX_RECORD_PAGES, 100)).map(normalize);
        },
        async record(token, zoneId, id) {
            try {
                return normalize((await call(token, 'GET', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`)).result);
            } catch (err) {
                if (err.code === 'provider.not_found') return null;
                throw err;
            }
        },
        async create(token, zoneId, rec) {
            return normalize((await call(token, 'POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, bodyOf(rec))).result);
        },
        async update(token, zoneId, id, rec) {
            return normalize((await call(token, 'PUT', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`, bodyOf(rec))).result);
        },
        async remove(token, zoneId, id) {
            await call(token, 'DELETE', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`);
            return true;
        },
    };
}

module.exports = { createCloudflare, normalize, bodyOf, ProviderError, ORIGIN, PROXIABLE };
