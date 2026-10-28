'use strict';

/**
 * Porkbun's official API (v3) for the control panel: one person's API key pair, passed to each call and never kept,
 * logged or returned. Only https://api.porkbun.com is ever called (ORIGIN), the same origin the key pair's Network
 * grant names, so a revealed key pair cannot be sent anywhere else.
 *
 * Porkbun takes every call as a POST whose JSON body carries apikey and secretapikey. The Network secret is that pair
 * as one JSON string; it is parsed here and nowhere else.
 *
 *   const pb = createPorkbun({ fetchImpl });
 *   await pb.verify(token)                       → { ok: true } | { ok: false, reason }
 *   await pb.zones(token)                        → [{ id, name, status, name_servers, plan }] (id is the domain)
 *   await pb.records(token, domain)              → [record]
 *   await pb.record(token, domain, id)           → record | null
 *   await pb.create(token, domain, rec) / update(token, domain, id, rec) / remove(token, domain, id)
 *   await pb.nameservers(token, domain) / setNameservers(token, domain, list)
 *   await pb.dsRecords(token, domain) / createDs(token, domain, rec) / deleteDs(token, domain, id)
 *
 * A record is domains.proposal@1's shape: { id, type, name, content, ttl, proxied, priority, comment }.
 * Porkbun's create and edit calls take a name relative to the domain ('' for the apex); its reads are fully qualified.
 * Both are accepted and normalized to the full name, and a full name is written back as relative.
 *
 * A DS record is the same shape with type DS and content "keyTag alg digestType digest"; its id is the key tag, which
 * is what Porkbun's registry API deletes by.
 */
const ORIGIN = 'https://api.porkbun.com';
const BASE = `${ORIGIN}/api/json/v3`;
const PRIORITY = new Set(['MX', 'SRV']);
const MAX_DOMAIN_PAGES = 20;     // 20 000 domains
const PAGE_SIZE = 1000;          // Porkbun's listAll page size

class ProviderError extends Error {
    constructor(status, message, code = 'provider.error') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const lowerName = (n) => String(n || '').trim().toLowerCase().replace(/\.$/, '');

/** The pair in the Network secret, or a ProviderError that never contains it. */
function keysOf(token) {
    if (typeof token !== 'string' || !token.trim()) throw new ProviderError(401, 'The connection has no Porkbun keys.', 'provider.no_token');
    let data;
    try {
        data = JSON.parse(token);
    } catch {
        throw new ProviderError(401, 'The connection is not a Porkbun key pair. Connect it again.', 'provider.no_token');
    }
    const apikey = data && typeof data.apikey === 'string' ? data.apikey.trim() : '';
    const secretapikey = data && typeof data.secretapikey === 'string' ? data.secretapikey.trim() : '';
    if (!apikey || !secretapikey) throw new ProviderError(401, 'The connection is missing one of its Porkbun keys. Connect it again.', 'provider.no_token');
    return { apikey, secretapikey };
}

function redact(words, keys) {
    let out = String(words);
    for (const key of [keys.apikey, keys.secretapikey]) {
        if (key) out = out.split(key).join('[redacted]');
    }
    return out;
}

/** The provider's record as domains.proposal@1 keeps it, with a relative name made fully qualified. */
function normalize(r, domain = '') {
    if (!r || typeof r !== 'object') return null;
    const zone = lowerName(domain);
    const type = String(r.type || '').toUpperCase();
    let name = lowerName(r.name);
    if (!name || name === '@') name = zone;
    else if (zone && name !== zone && !name.endsWith(`.${zone}`)) name = `${name}.${zone}`;
    const ttl = Number(r.ttl);
    const rawPrio = r.prio == null ? r.priority : r.prio;
    const prio = rawPrio == null || rawPrio === '' ? NaN : Number(rawPrio);
    const notes = typeof r.notes === 'string' ? r.notes : r.comment;
    return {
        id: r.id == null || r.id === '' ? null : String(r.id),
        type,
        name,
        content: String(r.content == null ? '' : r.content),
        ttl: Number.isInteger(ttl) && ttl > 0 ? ttl : 1,
        proxied: null,
        priority: PRIORITY.has(type) && Number.isInteger(prio) ? prio : null,
        comment: typeof notes === 'string' && notes ? notes.slice(0, 100) : null,
    };
}

/** The body Porkbun takes for a create or edit, with a full name written as a subdomain ('' for the apex). */
function bodyOf(rec, domain = '') {
    const zone = lowerName(domain);
    const type = String(rec.type || '').toUpperCase();
    let name = lowerName(rec.name);
    if (!name || name === '@' || (zone && name === zone)) name = '';
    else if (zone && name.endsWith(`.${zone}`)) name = name.slice(0, -(zone.length + 1));
    else if (name.endsWith('.')) name = name.slice(0, -1);
    const ttl = Number(rec.ttl);
    const out = { type, name, content: String(rec.content == null ? '' : rec.content), ttl: Number.isInteger(ttl) && ttl > 1 ? ttl : 0 };
    const prio = Number(rec.priority);
    if (PRIORITY.has(type) && Number.isInteger(prio)) out.prio = prio;
    if (typeof rec.comment === 'string' && rec.comment) out.notes = rec.comment.slice(0, 100);
    return out;
}

/** A DS record's four registry fields, from a record (content) or the registry's own object. */
function dsOf(rec) {
    if (!rec || typeof rec !== 'object') throw new ProviderError(422, 'A DS record needs keyTag, alg, digestType and digest.', 'provider.invalid');
    const parts = typeof rec.content === 'string' ? rec.content.trim().split(/\s+/).filter(Boolean) : [];
    const keyTag = String(rec.keyTag == null ? (rec.key_tag == null ? (rec.keytag == null ? (parts[0] || '') : rec.keytag) : rec.key_tag) : rec.keyTag).trim();
    const alg = String(rec.alg == null ? (rec.algorithm == null ? (parts[1] || '') : rec.algorithm) : rec.alg).trim();
    const digestType = String(rec.digestType == null ? (rec.digest_type == null ? (rec.digesttype == null ? (parts[2] || '') : rec.digesttype) : rec.digest_type) : rec.digestType).trim();
    const digest = String(rec.digest == null ? parts.slice(3).join('') : rec.digest).trim();
    if (!keyTag || !alg || !digestType || !digest) throw new ProviderError(422, 'A DS record needs keyTag, alg, digestType and digest.', 'provider.invalid');
    return { keyTag, alg, digestType, digest };
}

/** A DS record in the same shape as every other record. */
function normalizeDs(record, key, domain) {
    const keyTag = String((record && record.keyTag) == null ? key : record.keyTag).trim();
    const alg = String((record && record.alg) == null ? '' : record.alg).trim();
    const digestType = String((record && record.digestType) == null ? '' : record.digestType).trim();
    const digest = String((record && record.digest) == null ? '' : record.digest).trim();
    return {
        id: keyTag,
        type: 'DS',
        name: lowerName(domain),
        content: `${keyTag} ${alg} ${digestType} ${digest}`.trim(),
        ttl: 1,
        proxied: null,
        priority: null,
        comment: null,
    };
}

function createPorkbun({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    async function call(token, path, body = {}) {
        const keys = keysOf(token);
        let res;
        try {
            res = await fetchImpl(`${BASE}${path}`, {
                method: 'POST',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify({ ...body, apikey: keys.apikey, secretapikey: keys.secretapikey }),
                redirect: 'error',
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
            throw new ProviderError(502, timedOut ? 'Porkbun did not answer in time.' : 'Porkbun could not be reached.', 'provider.unreachable');
        }
        const data = await res.json().catch(() => null);
        const status = data && typeof data.status === 'string' ? data.status.toUpperCase() : '';
        if (res.ok && data && status !== 'ERROR') return data;
        // Porkbun's own words for what went wrong, with any key it might echo removed.
        const words = data && data.message ? redact(data.message, keys).slice(0, 300) : `Porkbun answered ${res.status}.`;
        const code = data && data.code ? String(data.code) : '';
        if (res.status === 401 || res.status === 403 || /INVALID_API_KEY|INVALID_CREDENTIALS|AUTHENTICATION|API_KEY_MISSING/.test(code)
            || /invalid (api )?key|invalid credentials|authentication/i.test(words)) {
            throw new ProviderError(res.status === 403 ? 403 : 401, `Porkbun refused the keys: ${words}`, 'provider.forbidden');
        }
        if (res.status === 404 || /NOT_FOUND|DOMAIN_NOT_FOUND|RECORD_NOT_FOUND/.test(code)) throw new ProviderError(404, words, 'provider.not_found');
        throw new ProviderError(res.status >= 500 ? 502 : 422, words, 'provider.refused');
    }

    async function record(token, domain, id) {
        try {
            const data = await call(token, `/dns/retrieve/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`);
            const list = Array.isArray(data.records) ? data.records : [];
            const one = list.find((r) => String(r.id) === String(id)) || (list.length === 1 && list[0].id == null ? list[0] : null);
            if (one) return normalize(one, domain);
        } catch (err) {
            if (err.code !== 'provider.not_found' && !/not found|does not exist/i.test(err.message)) throw err;
        }
        // Some accounts and stand-ins answer retrieve-by-id with the whole zone: find it there.
        try {
            const data = await call(token, `/dns/retrieve/${encodeURIComponent(domain)}`);
            const found = (Array.isArray(data.records) ? data.records : []).find((r) => String(r.id) === String(id));
            return found ? normalize(found, domain) : null;
        } catch (err) {
            if (err.code === 'provider.not_found' || /not found|does not exist/i.test(err.message)) return null;
            throw err;
        }
    }

    return {
        ORIGIN,
        /** /ping with the pair: Porkbun says whether the keys are valid and for which account. */
        async verify(token) {
            try {
                const data = await call(token, '/ping');
                const valid = data.credentialsValid == null ? true : data.credentialsValid === true;
                return valid ? { ok: true } : { ok: false, reason: 'Porkbun did not confirm these keys.' };
            } catch (err) {
                return { ok: false, reason: err.message };
            }
        },
        /** Every domain in the account, paged. Porkbun has no separate zone id, so the domain is the id. */
        async zones(token) {
            const out = [];
            for (let page = 0, start = 0; page < MAX_DOMAIN_PAGES; page++) {
                const data = await call(token, '/domain/listAll', { start });
                const list = Array.isArray(data.domains) ? data.domains : [];
                out.push(...list);
                if (list.length < PAGE_SIZE) break;
                start += list.length;
            }
            return out.map((d) => ({
                id: lowerName(d.domain), name: lowerName(d.domain), status: d.status ? String(d.status) : null,
                name_servers: [], plan: null,
            })).filter((z) => z.id);
        },
        async records(token, domain) {
            const data = await call(token, `/dns/retrieve/${encodeURIComponent(domain)}`);
            return (Array.isArray(data.records) ? data.records : []).map((r) => normalize(r, domain));
        },
        record,
        async create(token, domain, rec) {
            const body = bodyOf(rec, domain);
            const data = await call(token, `/dns/create/${encodeURIComponent(domain)}`, body);
            const returned = data.record || (Array.isArray(data.records) ? data.records[0] : null);
            const id = data.id == null ? (returned && returned.id) : data.id;
            if (id == null || id === '') throw new ProviderError(502, 'Porkbun did not return the new record id.', 'provider.refused');
            return (await record(token, domain, id)) || normalize(returned || { ...body, id }, domain);
        },
        async update(token, domain, id, rec) {
            const body = bodyOf(rec, domain);
            await call(token, `/dns/edit/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`, body);
            return (await record(token, domain, id)) || normalize({ ...body, id }, domain);
        },
        async remove(token, domain, id) {
            await call(token, `/dns/delete/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`);
            return true;
        },
        async nameservers(token, domain) {
            const data = await call(token, `/domain/getNs/${encodeURIComponent(domain)}`);
            return (Array.isArray(data.ns) ? data.ns : []).map(lowerName).filter(Boolean);
        },
        async setNameservers(token, domain, list) {
            const wanted = Array.isArray(list) ? list : (list && Array.isArray(list.ns) ? list.ns : []);
            const ns = wanted.map(lowerName).filter(Boolean);
            if (!ns.length) throw new ProviderError(422, 'A domain needs at least one name server.', 'provider.invalid');
            await call(token, `/domain/updateNs/${encodeURIComponent(domain)}`, { ns });
            return true;
        },
        async dsRecords(token, domain) {
            const data = await call(token, `/dns/getDnssecRecords/${encodeURIComponent(domain)}`);
            const records = data.records;
            if (Array.isArray(records)) return records.map((r) => normalizeDs(r, r && (r.keyTag || r.id), domain));
            return Object.entries(records && typeof records === 'object' ? records : {}).map(([key, r]) => normalizeDs(r, key, domain));
        },
        async createDs(token, domain, rec) {
            const ds = dsOf(rec);
            await call(token, `/dns/createDnssecRecord/${encodeURIComponent(domain)}`, ds);
            return normalizeDs(ds, ds.keyTag, domain);
        },
        async deleteDs(token, domain, id) {
            const key = id && typeof id === 'object' ? (id.id == null ? dsOf(id).keyTag : id.id) : id;
            await call(token, `/dns/deleteDnssecRecord/${encodeURIComponent(domain)}/${encodeURIComponent(key)}`);
            return true;
        },
    };
}

module.exports = { createPorkbun, normalize, bodyOf, normalizeDs, dsOf, ProviderError, ORIGIN, PRIORITY };
