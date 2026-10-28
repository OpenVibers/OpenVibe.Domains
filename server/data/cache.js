'use strict';

/**
 * The small in-memory cache both data clients use: a Map with an expiry per entry and a hard cap,
 * oldest insertion out. A process restart loses it; nothing here is persisted.
 */
const MAX = 2000;

function createCache({ max = MAX, now = () => Date.now() } = {}) {
    const entries = new Map();
    return {
        get(key) {
            const hit = entries.get(key);
            if (!hit) return undefined;
            if (hit.expires <= now()) {
                entries.delete(key);
                return undefined;
            }
            return hit.value;
        },
        set(key, value, ttlMs) {
            if (entries.has(key)) entries.delete(key);
            else if (entries.size >= max) {
                const oldest = entries.keys().next().value;
                if (oldest !== undefined) entries.delete(oldest);
            }
            entries.set(key, { value, expires: now() + Math.max(0, Number(ttlMs) || 0) });
        },
        get size() { return entries.size; },
        clear() { entries.clear(); },
    };
}

/** GET a JSON document with an 8 s ceiling; throws on a non-2xx, a timeout or malformed JSON. */
async function fetchJson(fetchImpl, url, { timeoutMs = 8000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try { controller.abort(); } catch { /* already gone */ }
            reject(new Error(`timed out after ${timeoutMs} ms`));
        }, timeoutMs);
    });
    try {
        const res = await Promise.race([
            Promise.resolve().then(() => fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })),
            timeout,
        ]);
        if (!res || !res.ok) throw new Error(`HTTP ${res && res.status ? res.status : 'no response'}`);
        let body;
        if (typeof res.text === 'function') {
            const text = await res.text();
            if (text === undefined && typeof res.json === 'function') body = await res.json();
            else body = typeof text === 'string' ? (text ? JSON.parse(text) : null) : text;
        } else if (typeof res.json === 'function') {
            body = await res.json();
        } else {
            throw new Error('the response had no body');
        }
        return body;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { createCache, fetchJson };
