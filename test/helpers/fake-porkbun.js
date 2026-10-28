'use strict';
/**
 * A stand-in for Porkbun's API v3 behind createPorkbun(): an in-memory account answering the same paths, so the real
 * client (server/panel/porkbun.js) is what the tests drive. Only https://api.porkbun.com is answered; any other origin
 * is recorded as a leak.
 *
 *   const pb = fakePorkbun({ apikey: 'pk1_…', secretapikey: 'sk1_…', domains: [{ domain: 'example.com' }] });
 *   createPorkbun({ fetchImpl: pb.fetch })
 *   pb.records('example.com') / pb.setRecord(…) / pb.nameservers(…) / pb.setNameservers(…) / pb.dsRecords(…)
 *   pb.revoke() / pb.calls / pb.leaks
 *
 * The fake keeps records fully qualified, as Porkbun's reads return them, and expands the relative names its create and
 * edit calls take.
 */
function fakePorkbun({ apikey, secretapikey, domains = [] } = {}) {
    const st = {
        apikey, secretapikey, revoked: false, domains: [], records: new Map(), ns: new Map(), ds: new Map(),
        nextId: 1, calls: [], leaks: [],
    };
    for (const input of domains) {
        const d = typeof input === 'string' ? { domain: input } : input;
        const domain = String(d.domain).toLowerCase();
        st.domains.push({ domain, status: d.status || 'ACTIVE', apiAccess: d.apiAccess !== false });
        st.records.set(domain, []);
        st.ns.set(domain, (d.nameservers || ['ns1.porkbun.com', 'ns2.porkbun.com']).map((n) => String(n).toLowerCase()));
        st.ds.set(domain, new Map());
    }

    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const ok = (body = {}) => json(200, { status: 'SUCCESS', ...body });
    const err = (status, message, code) => json(status, { status: 'ERROR', message, ...(code ? { code } : {}) });
    const page = (domain, name) => {
        const zone = String(domain).toLowerCase();
        const n = String(name || '').trim().toLowerCase().replace(/\.$/, '');
        if (!n || n === zone || n === '@') return zone;
        return n.endsWith(`.${zone}`) ? n : `${n}.${zone}`;
    };
    const domainOf = (name) => st.domains.find((d) => d.domain === String(name).toLowerCase());

    async function fetchImpl(input, init = {}) {
        const u = new URL(String(input));
        if (u.origin !== 'https://api.porkbun.com') { st.leaks.push(String(input)); return err(400, 'wrong origin'); }
        const method = init.method || 'GET';
        let body = {};
        try { body = init.body ? JSON.parse(init.body) : {}; } catch { return err(400, 'Invalid JSON.'); }
        st.calls.push({ method, path: u.pathname, keys: body.apikey === st.apikey && body.secretapikey === st.secretapikey });
        if (method !== 'POST') return err(405, 'Use POST.');
        if (st.revoked || body.apikey !== st.apikey || body.secretapikey !== st.secretapikey) return err(400, 'Invalid API key', 'INVALID_API_KEY');
        const p = u.pathname.replace('/api/json/v3', '');

        if (p === '/ping') return ok({ credentialsValid: true, account: 'ada' });
        if (p === '/domain/listAll') {
            const start = Number.isInteger(body.start) && body.start > 0 ? body.start : 0;
            const slice = st.domains.slice(start, start + 1000);
            return ok({
                count: slice.length,
                domains: slice.map((d) => ({ domain: d.domain, status: d.status, tld: d.domain.split('.').pop(), apiAccess: d.apiAccess ? 1 : 0 })),
            });
        }

        let m = p.match(/^\/domain\/getNs\/([^/]+)$/);
        if (m) {
            const d = domainOf(decodeURIComponent(m[1]));
            if (!d) return err(400, 'Invalid domain.', 'INVALID_DOMAIN');
            if (!d.apiAccess) return err(400, `API access is not enabled for ${d.domain}.`, 'API_ACCESS_DISABLED');
            return ok({ ns: [...st.ns.get(d.domain)] });
        }
        m = p.match(/^\/domain\/updateNs\/([^/]+)$/);
        if (m) {
            const d = domainOf(decodeURIComponent(m[1]));
            if (!d) return err(400, 'Invalid domain.', 'INVALID_DOMAIN');
            if (!Array.isArray(body.ns) || !body.ns.length) return err(400, 'At least one name server is required.');
            st.ns.set(d.domain, body.ns.map((n) => String(n).toLowerCase()));
            return ok();
        }

        m = p.match(/^\/dns\/retrieve\/([^/]+)$/);
        if (m) {
            const d = domainOf(decodeURIComponent(m[1]));
            if (!d) return err(400, 'Invalid domain.', 'INVALID_DOMAIN');
            if (!d.apiAccess) return err(400, `API access is not enabled for ${d.domain}.`, 'API_ACCESS_DISABLED');
            return ok({ records: st.records.get(d.domain).map((r) => ({ ...r })) });
        }
        m = p.match(/^\/dns\/retrieve\/([^/]+)\/([^/]+)$/);
        if (m) {
            const d = domainOf(decodeURIComponent(m[1]));
            if (!d) return err(400, 'Invalid domain.', 'INVALID_DOMAIN');
            const rec = st.records.get(d.domain).find((r) => r.id === decodeURIComponent(m[2]));
            if (!rec) return err(404, 'Record not found', 'RECORD_NOT_FOUND');
            return ok({ records: [{ ...rec }] });
        }
        m = p.match(/^\/dns\/create\/([^/]+)$/);
        if (m) {
            const d = domainOf(decodeURIComponent(m[1]));
            if (!d) return err(400, 'Invalid domain.', 'INVALID_DOMAIN');
            if (!body.type || body.content == null) return err(400, 'A record needs a type and content.');
            const rec = {
                id: String(st.nextId++), name: page(d.domain, body.name), type: String(body.type).toUpperCase(),
                content: String(body.content), ttl: String(body.ttl == null ? 0 : body.ttl),
                prio: body.prio == null ? null : String(body.prio), notes: body.notes == null ? null : String(body.notes),
            };
            st.records.get(d.domain).push(rec);
            return ok({ id: rec.id });
        }
        m = p.match(/^\/dns\/edit\/([^/]+)\/([^/]+)$/);
        if (m) {
            const d = domainOf(decodeURIComponent(m[1]));
            if (!d) return err(400, 'Invalid domain.', 'INVALID_DOMAIN');
            const rec = st.records.get(d.domain).find((r) => r.id === decodeURIComponent(m[2]));
            if (!rec) return err(404, 'Record not found', 'RECORD_NOT_FOUND');
            if (body.name !== undefined) rec.name = page(d.domain, body.name);
            if (body.type !== undefined) rec.type = String(body.type).toUpperCase();
            if (body.content !== undefined) rec.content = String(body.content);
            if (body.ttl !== undefined) rec.ttl = String(body.ttl);
            if (body.prio !== undefined) rec.prio = body.prio == null ? null : String(body.prio);
            if (body.notes !== undefined) rec.notes = body.notes == null ? null : String(body.notes);
            return ok();
        }
        m = p.match(/^\/dns\/delete\/([^/]+)\/([^/]+)$/);
        if (m) {
            const d = domainOf(decodeURIComponent(m[1]));
            if (!d) return err(400, 'Invalid domain.', 'INVALID_DOMAIN');
            const list = st.records.get(d.domain);
            const at = list.findIndex((r) => r.id === decodeURIComponent(m[2]));
            if (at < 0) return err(404, 'Record not found', 'RECORD_NOT_FOUND');
            list.splice(at, 1);
            return ok();
        }

        m = p.match(/^\/dns\/getDnssecRecords\/([^/]+)$/);
        if (m) {
            const d = domainOf(decodeURIComponent(m[1]));
            if (!d) return err(400, 'Invalid domain.', 'INVALID_DOMAIN');
            return ok({ records: Object.fromEntries([...st.ds.get(d.domain)].map(([key, value]) => [key, { ...value }])) });
        }
        m = p.match(/^\/dns\/createDnssecRecord\/([^/]+)$/);
        if (m) {
            const d = domainOf(decodeURIComponent(m[1]));
            if (!d) return err(400, 'Invalid domain.', 'INVALID_DOMAIN');
            for (const field of ['keyTag', 'alg', 'digestType', 'digest']) {
                if (body[field] == null || body[field] === '') return err(400, `A DNSSEC record needs ${field}.`);
            }
            const rec = {
                keyTag: String(body.keyTag), alg: String(body.alg), digestType: String(body.digestType), digest: String(body.digest),
            };
            st.ds.get(d.domain).set(rec.keyTag, rec);
            return ok();
        }
        m = p.match(/^\/dns\/deleteDnssecRecord\/([^/]+)\/([^/]+)$/);
        if (m) {
            const d = domainOf(decodeURIComponent(m[1]));
            if (!d) return err(400, 'Invalid domain.', 'INVALID_DOMAIN');
            st.ds.get(d.domain).delete(decodeURIComponent(m[2]));
            return ok();
        }
        return err(404, 'not found');
    }

    return {
        fetch: fetchImpl,
        state: st,
        records: (domain) => st.records.get(String(domain).toLowerCase()).map((r) => ({ ...r })),
        addRecord: (domain, r) => {
            const zone = String(domain).toLowerCase();
            const rec = {
                id: String(st.nextId++), ttl: '600', prio: null, notes: null,
                ...r, name: page(zone, r.name), type: String(r.type).toUpperCase(), content: String(r.content),
            };
            st.records.get(zone).push(rec);
            return { ...rec };
        },
        setRecord: (domain, id, patch) => {
            const zone = String(domain).toLowerCase();
            const list = st.records.get(zone);
            const at = list.findIndex((r) => r.id === id);
            if (at < 0) return null;
            list[at] = { ...list[at], ...patch };
            if (patch.name !== undefined) list[at].name = page(zone, patch.name);
            return { ...list[at] };
        },
        nameservers: (domain) => [...st.ns.get(String(domain).toLowerCase())],
        setNameservers: (domain, list) => { st.ns.set(String(domain).toLowerCase(), list.map((n) => String(n).toLowerCase())); },
        dsRecords: (domain) => [...st.ds.get(String(domain).toLowerCase()).values()].map((r) => ({ ...r })),
        addDs: (domain, r) => {
            const rec = { keyTag: String(r.keyTag), alg: String(r.alg), digestType: String(r.digestType), digest: String(r.digest) };
            st.ds.get(String(domain).toLowerCase()).set(rec.keyTag, rec);
            return { ...rec };
        },
        revoke: () => { st.revoked = true; },
        get calls() { return st.calls; },
        get leaks() { return st.leaks; },
    };
}

module.exports = { fakePorkbun };
