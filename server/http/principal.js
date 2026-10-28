'use strict';

/**
 * Who is calling the control panel's API — req.principal:
 *
 *   { kind: 'user', subject: 'usr_…', username, role, token, viaSession }
 *       a person: their Network user token as a Bearer, or this site's session cookie (dom_at).
 *   { kind: 'service', service: 'network', subject: 'usr_…' }
 *       a first-party service token for audience openvibe.domains holding the route's capability, acting for the
 *       person named in X-OV-Subject (OpenVibe.Network's Action Center: domains.actions.read, domains.proposal.decide).
 *   { kind: 'anonymous' }
 *
 * A request that presents a token is judged on that token alone: a bad one is refused, never downgraded to the session
 * or to anonymous. A change made with the session cookie must come from this site (Sec-Fetch-Site same-origin, or an
 * Origin equal to ours): another site cannot make a signed-in visitor propose, approve or connect anything.
 */
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');

const SERVICE_SUB = /^(svc|app|mod|agent):/;
const CAPABILITIES = ['domains.actions.read', 'domains.proposal.decide'];

function decodePayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** Same-origin for a signed-in write: the browser's fetch metadata, else the Origin header. */
function sameOrigin(req, baseUrl) {
    const site = String(req.get('sec-fetch-site') || '');
    if (site) return site === 'same-origin';
    const origin = req.get('origin');
    if (origin) return origin === baseUrl || origin === `${req.protocol}://${req.get('host')}`;
    return false;
}

function createPrincipal({ config, keys }) {
    async function resolve(req) {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const token = header.slice(7).trim();
            const payload = decodePayload(token);
            if (payload && typeof payload.sub === 'string' && SERVICE_SUB.test(payload.sub)) {
                const publicKey = await keys.pemForToken(token);
                if (!publicKey) return { error: [503, 'identity.unavailable', 'the Network signing key is not loaded yet'] };
                const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkIssuer, audience: config.audience });
                if (!r.ok) return { error: [401, r.code || 'token.invalid', r.reason || 'the token does not verify'] };
                if (!String(r.claims.sub).startsWith('svc:')) return { error: [403, 'capability.denied', 'these routes are for first-party services and people only'] };
                return { principal: { kind: 'service', service: String(r.claims.sub).slice(4), claims: r.claims, subject: null } };
            }
            const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: config.oauth.sessionAudience });
            if (!v.ok) return { error: [401, v.expired ? 'token.expired' : 'token.invalid', v.reason] };
            if (v.claims.typ === 'fedcm' || v.claims.actor_type !== undefined) return { error: [401, 'token.invalid', 'not a person\'s token'] };
            if (!ids.isSubjectId('user', v.claims.subject_id)) return { error: [403, 'identity.no_subject', 'this account has no canonical subject yet; sign in again'] };
            return { principal: { kind: 'user', subject: v.claims.subject_id, role: typeof v.claims.role === 'string' ? v.claims.role : 'user', username: typeof v.claims.username === 'string' ? v.claims.username : null, token, viaSession: false } };
        }
        const viewer = req.viewer;
        if (viewer && viewer.kind === 'user' && ids.isSubjectId('user', viewer.subject)) {
            return { principal: { kind: 'user', subject: viewer.subject, role: viewer.role || 'user', username: viewer.username || null, token: viewer.token, viaSession: true } };
        }
        return { principal: { kind: 'anonymous' } };
    }

    async function middleware(req, res, next) {
        const r = await resolve(req);
        if (r.error) return http.sendProblem(res, r.error[0], r.error[1], { detail: r.error[2], ctx: req.ov });
        req.principal = r.principal;
        return next();
    }

    /** A person acting for themself; a session-cookie change must come from this site. */
    function requirePerson(req, res, next) {
        const p = req.principal;
        if (!p || p.kind === 'anonymous') return http.sendProblem(res, 401, 'token.required', { detail: 'Sign in at openvibe.domains, or send your Network token as a Bearer.', ctx: req.ov });
        if (p.kind !== 'user') return http.sendProblem(res, 403, 'domains.person_required', { detail: 'This route is for a person.', ctx: req.ov });
        if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, config.baseUrl)) return http.sendProblem(res, 403, 'domains.cross_site', { detail: 'A change must come from openvibe.domains.', ctx: req.ov });
        return next();
    }

    /** A first-party service holding `cap`, for the person X-OV-Subject (or ?subject=) names. */
    function requireService(cap) {
        if (!CAPABILITIES.includes(cap)) throw new Error(`requireService(${cap}): not one of OpenVibe.Domains' capabilities`);
        return function guard(req, res, next) {
            const p = req.principal;
            if (!p || p.kind !== 'service') return http.sendProblem(res, 401, 'token.required', { detail: `${cap} needs a Network service token for ${config.audience}.`, ctx: req.ov });
            const decision = capabilities.check(p.claims, cap);
            if (!decision.allowed) return http.sendProblem(res, 403, decision.code || 'capability.denied', { detail: decision.reason || `${cap} is not granted`, ctx: req.ov });
            const subject = String(req.get('x-ov-subject') || req.query.subject || '').trim();
            if (!ids.isSubjectId('user', subject)) return http.sendProblem(res, 400, 'subject.invalid', { detail: 'Name the person: X-OV-Subject (or ?subject=) is a usr_… id.', ctx: req.ov });
            req.subject = subject;
            return next();
        };
    }

    return { middleware, resolve, requirePerson, requireService };
}

module.exports = { createPrincipal, CAPABILITIES, sameOrigin };
