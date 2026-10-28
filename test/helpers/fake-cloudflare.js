'use strict';
/**
 * A stand-in for Cloudflare's v4 API behind createCloudflare(): an in-memory account answering the same paths, so the
 * real client (server/panel/cloudflare.js) is what the tests drive. Only https://api.cloudflare.com is answered; any
 * other origin is recorded as a leak.
 *
 *   const cf = fakeCloudflare({ token: 'cf-good-token-…', zones: [{ id: 'z1', name: 'example.com' }] });
 *   createCloudflare({ fetchImpl: cf.fetch })
 *   cf.records('z1') / cf.setRecord('z1', id, patch) / cf.revoke() / cf.calls / cf.leaks
 */
const crypto = require('crypto');

function fakeCloudflare({ token, zones = [] } = {}) {
    const st = { token, revoked: false, zones: zones.map((z) => ({ status: 'active', name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], plan: { name: 'Free Website' }, ...z })), records: new Map(), calls: [], leaks: [] };
    for (const z of st.zones) st.records.set(z.id, []);
    const ok = (result, info) => new Response(JSON.stringify({ success: true, errors: [], result, ...(info ? { result_info: info } : {}) }), { status: 200, headers: { 'content-type': 'application/json' } });
    const err = (status, message) => new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message }], result: null }), { status, headers: { 'content-type': 'application/json' } });

    async function fetchImpl(input, init = {}) {
        const u = new URL(String(input));
        if (u.origin !== 'https://api.cloudflare.com') { st.leaks.push(String(input)); return err(400, 'wrong origin'); }
        const auth = String((init.headers || {}).authorization || '');
        const method = init.method || 'GET';
        st.calls.push({ method, path: u.pathname, auth: auth === `Bearer ${st.token}` });
        if (auth !== `Bearer ${st.token}` || st.revoked) return err(403, 'Invalid API Token');
        const p = u.pathname.replace('/client/v4', '');
        if (p === '/user/tokens/verify') return ok({ id: 'tok1', status: 'active' });
        if (p === '/zones') return ok(st.zones, { page: 1, per_page: 50, total_pages: 1, count: st.zones.length });
        const m = p.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
        if (m) {
            const list = st.records.get(decodeURIComponent(m[1]));
            if (!list) return err(404, 'Zone not found');
            const id = m[2] && decodeURIComponent(m[2]);
            const body = init.body ? JSON.parse(init.body) : null;
            if (!id && method === 'GET') return ok(list.map((r) => ({ ...r })), { page: 1, per_page: 100, total_pages: 1, count: list.length });
            if (!id && method === 'POST') { const r = { id: crypto.randomBytes(16).toString('hex'), ttl: 1, ...body }; list.push(r); return ok({ ...r }); }
            const at = list.findIndex((r) => r.id === id);
            if (at < 0) return err(404, 'Record not found');
            if (method === 'GET') return ok({ ...list[at] });
            if (method === 'PUT') { list[at] = { id, ...body }; return ok({ ...list[at] }); }
            if (method === 'DELETE') { list.splice(at, 1); return ok({ id }); }
        }
        return err(404, 'not found');
    }

    return {
        fetch: fetchImpl,
        state: st,
        records: (zoneId) => st.records.get(zoneId).map((r) => ({ ...r })),
        addRecord: (zoneId, r) => { const rec = { id: crypto.randomBytes(16).toString('hex'), ttl: 1, ...r }; st.records.get(zoneId).push(rec); return rec; },
        setRecord: (zoneId, id, patch) => { const list = st.records.get(zoneId); const at = list.findIndex((r) => r.id === id); list[at] = { ...list[at], ...patch }; },
        revoke: () => { st.revoked = true; },
        get calls() { return st.calls; },
        get leaks() { return st.leaks; },
    };
}

module.exports = { fakeCloudflare };
