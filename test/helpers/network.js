'use strict';
/**
 * An in-process stand-in for OpenVibe.Network for the control panel's tests, with a real RS256 key pair:
 *
 *   JWKS (/api/.well-known/jwks); /oauth/token (client_credentials and authorization_code for client `domains`);
 *   the person's projects and project secrets (/api/v1/projects…, ADR-056, Bearer user token);
 *   POST /internal/secrets/use (a service token): the value for a grant's purpose and origin, else 404, as Network does.
 *
 *   const net = await startNetwork();
 *   const ada = net.addUser('ada');  net.userToken(ada)            a person's session token
 *   net.serviceToken(['domains.actions.read'])                      Network's own token for openvibe.domains
 *   net.state.secrets                                               Map "<project>/<env>/<name>" → { value, grants }
 */
const http = require('http');
const crypto = require('crypto');
const { serviceAuth, ids } = require('openvibe-contracts');

function listen(handler) {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(status === 204 ? '' : JSON.stringify(obj)); };
                Promise.resolve(handler(req, raw, json)).catch((err) => json(500, { error: String(err && err.message) }));
            });
        });
        server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }) }));
    });
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const signJwt = (claims, key) => { const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`; return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`; };

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const st = { users: new Map(), projects: new Map(), secrets: new Map(), requests: [], uses: [], down: false };
    let issuer = null;
    let nextId = 1;

    const addUser = (username) => { const u = { id: nextId++, subject: ids.newId('user'), username, role: 'user' }; st.users.set(u.id, u); return u; };
    const userToken = (u) => { const now = Math.floor(Date.now() / 1000); return signJwt({ iss: issuer, sub: u.id, subject_id: u.subject, username: u.username, display_name: u.username, role: u.role, aud: ['openvibe.network'], iat: now, exp: now + 3600 }, privatePem); };
    const serviceToken = (caps, { aud = 'openvibe.domains', sub = 'svc:network' } = {}) => { const now = Math.floor(Date.now() / 1000); return serviceAuth.signServiceToken({ iss: issuer, sub, actor_type: 'service', aud: [aud], cap: caps, iat: now, exp: now + 300, jti: crypto.randomBytes(8).toString('hex') }, privatePem); };
    const verified = (req) => {
        const h = String(req.headers.authorization || '');
        if (!h.startsWith('Bearer ')) return null;
        const [a, b, c] = h.slice(7).split('.');
        if (!c || !crypto.verify('RSA-SHA256', Buffer.from(`${a}.${b}`), publicPem, Buffer.from(c, 'base64url'))) return null;
        return JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    };

    const srv = await listen(async (req, raw, json) => {
        const url = new URL(req.url, 'http://x');
        const p = url.pathname;
        st.requests.push({ method: req.method, path: p, body: raw });
        if (st.down) return json(503, { code: 'network.down', detail: 'Network is restarting' });
        if (p === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
        if (p === '/oauth/revoke') return json(200, {});
        if (p === '/oauth/token' && req.method === 'POST') {
            const body = Object.fromEntries(new URLSearchParams(raw));
            if (body.client_id !== 'domains' || body.client_secret !== 'domains-secret') return json(401, { error: 'invalid_client' });
            if (body.grant_type === 'client_credentials') {
                const caps = String(body.scope || '').split(/\s+/).filter(Boolean);
                return json(200, { access_token: serviceToken(caps, { aud: body.audience || 'openvibe.network', sub: 'svc:domains' }), token_type: 'Bearer', expires_in: 300, scope: caps.join(' ') });
            }
            return json(400, { error: 'unsupported_grant_type' });
        }

        // The person's projects and their secrets (Bearer user token only).
        if (p.startsWith('/api/v1/projects')) {
            const c = verified(req);
            const u = c && st.users.get(c.sub);
            if (!u) return json(401, { code: 'auth.required', detail: 'sign in' });
            const parts = p.split('/').slice(4).map(decodeURIComponent);   // ['', project?, 'secrets', env, name, 'grants', svc]
            if (parts.length <= 1 || parts[0] === '') {
                if (req.method === 'GET') return json(200, { projects: [...st.projects.values()].filter((x) => x.owner === u.subject).map((x) => ({ id: x.id, name: x.name, role: 'owner', archived_at: null })) });
                if (req.method === 'POST') { const id = ids.newId('project'); const body = JSON.parse(raw || '{}'); st.projects.set(id, { id, name: body.name, owner: u.subject }); return json(201, { id, name: body.name, role: 'owner' }); }
            }
            const [project, kind, env, name, grants, svc] = parts;
            const proj = st.projects.get(project);
            if (!proj || proj.owner !== u.subject || kind !== 'secrets') return json(404, { code: 'project.not_found' });
            const key = `${project}/${env}/${name}`;
            if (!grants && req.method === 'PUT') { const body = JSON.parse(raw || '{}'); const old = st.secrets.get(key); st.secrets.set(key, { value: body.value, grants: old ? old.grants : {}, version: old ? old.version + 1 : 1 }); return json(200, { name, version: st.secrets.get(key).version }); }
            if (!grants && req.method === 'DELETE') { if (!st.secrets.has(key)) return json(404, { code: 'secret.not_found' }); st.secrets.delete(key); return json(204); }
            if (grants === 'grants' && req.method === 'PUT') { const s = st.secrets.get(key); if (!s) return json(404, { code: 'secret.not_found' }); s.grants[svc] = JSON.parse(raw || '{}'); return json(200, { service: svc }); }
            return json(404, { code: 'route.not_found' });
        }

        if (p === '/internal/secrets/use' && req.method === 'POST') {
            const c = verified(req);
            if (!c || !String(c.sub).startsWith('svc:')) return json(401, { code: 'token.invalid' });
            const caps = Array.isArray(c.cap) ? c.cap : [];
            if (!caps.includes('network.secret.use')) return json(403, { code: 'capability.denied' });
            const body = JSON.parse(raw || '{}');
            st.uses.push({ service: c.sub, ...body });
            const s = st.secrets.get(`${body.project_id}/${body.environment}/${body.name}`);
            const g = s && s.grants[String(c.sub).slice(4)];
            if (!g || !g.purposes.includes(body.purpose) || (body.purpose === 'reveal' && !g.origins.includes(body.origin))) return json(404, { code: 'secret.not_found' });
            return json(200, { name: body.name, version: s.version, purpose: body.purpose, value: s.value });
        }
        return json(404, { error: 'not found' });
    });
    issuer = srv.url;
    return { url: srv.url, state: st, addUser, userToken, serviceToken, close: srv.close };
}

module.exports = { startNetwork };
