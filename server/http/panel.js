'use strict';

/**
 * The control panel's routes (DOM-2). Pages are a signed-in person's own (private, no-store); every change is a form
 * POST from this site. The API serves the same person with their Network token, and OpenVibe.Network's Action Center
 * with a service token (domains.actions.read, domains.proposal.decide) for the person X-OV-Subject names.
 *
 *   GET  /panel                         connections, zones, waiting proposals, recent changes
 *   GET  /panel/connect, POST           connect Cloudflare (verified, then stored in the person's Network project)
 *   POST /panel/c/:id/sync | /remove
 *   GET  /panel/z/:conn/:zone           a zone's records, live; POST …/propose (create | update | delete)
 *   GET  /panel/p/:id                   a proposal; POST …/decide (approve | decline), POST …/rollback
 *
 *   GET  /api/v1/panel/connections | /api/v1/panel/zones | /api/v1/panel/zones/:conn/:zone/records   (person)
 *   GET  /api/v1/proposals, /api/v1/proposals/:id, POST /api/v1/proposals                          (person)
 *   POST /api/v1/proposals/:id/decide   person, or a service with domains.proposal.decide (→ common.action-item@1)
 *   POST /api/v1/proposals/:id/rollback (person)
 *   GET  /api/v1/actions?subject=       a service with domains.actions.read → common.action-list-result@1
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const views = require('../views/panel');
const { sameOrigin } = require('./principal');

const NOTICES = {
    connected: 'Connected. Your zones are below.',
    synced: 'Synced with Cloudflare.',
    removed: 'Removed. Its token was deleted from your OpenVibe project.',
    declined: 'Declined. Nothing changed.',
    rolled_back: 'Rolled back.',
};
const PROBLEMS = {
    'vault.secret_missing': 'That connection\'s token is gone or no longer granted. Remove it and connect again.',
    'provider.forbidden': 'Cloudflare refused the token. Check it in Cloudflare, then connect again.',
    'provider.unreachable': 'Cloudflare did not answer. Try again in a moment.',
    'vault.unavailable': 'OpenVibe.Network did not answer. Try again in a moment.',
    'vault.signed_out': 'Your sign-in ended. Sign in again.',
};

function createPanelRoutes({ config, panel, principal, log = console }) {
    const pages = asyncRouter();
    const form = express.urlencoded({ extended: false, limit: '16kb' });
    const privateHtml = (res, status, htmlText) => res.status(status).set('Cache-Control', 'private, no-store').type('html').send(htmlText);
    const person = (req) => (req.viewer && req.viewer.kind === 'user' && req.viewer.token ? { subject: req.viewer.subject, token: req.viewer.token } : null);
    const toLogin = (req, res) => res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl.split('?')[0])}`);
    const crossSite = (req, res) => res.status(403).set('Cache-Control', 'no-store').type('text/plain').send('A change must come from openvibe.domains.');
    const notice = (req) => NOTICES[String(req.query.done || '')] || PROBLEMS[String(req.query.problem || '')] || null;
    const back = (res, path, err) => res.redirect(303, `${path}?problem=${encodeURIComponent(err && err.code ? err.code : 'error')}`);

    /** A form POST: signed in and from this site, else nothing happens. */
    const post = (path, handler) => pages.post(path, form, async (req, res) => {
        const p = person(req);
        if (!p) return toLogin(req, res);
        if (!sameOrigin(req, config.baseUrl)) return crossSite(req, res);
        return handler(req, res, p);
    });

    pages.get('/panel', async (req, res) => {
        const p = person(req);
        if (!p) return privateHtml(res, 200, views.signedOut());
        const [connections, zones, list] = await Promise.all([panel.connections(p.subject), panel.zones(p.subject), panel.list(p.subject, { since: new Date(Date.now() - 30 * 86_400_000).toISOString(), limit: 40 })]);
        const all = list.map(panel.toPublic);
        return privateHtml(res, 200, views.home({ connections, zones, waiting: all.filter((x) => x.status === 'pending'), recent: all.filter((x) => x.status !== 'pending').slice(0, 10), notice: notice(req) }));
    });

    pages.get('/panel/connect', (req, res) => (person(req) ? privateHtml(res, 200, views.connect()) : toLogin(req, res)));
    post('/panel/connect', async (req, res, p) => {
        try {
            await panel.connect(p, { provider: req.body.provider || 'cloudflare', label: req.body.label, token: req.body.token });
            return res.redirect(303, '/panel?done=connected');
        } catch (err) {
            if (!err.status || err.status >= 500) log.warn('[OpenVibe.Domains] connect failed:', err.code || err.message);
            return privateHtml(res, err.status && err.status < 500 ? 422 : 503, views.connect({ error: err.status ? err.message : 'That did not work. Try again in a moment.', values: { label: req.body.label } }));
        }
    });
    post('/panel/c/:id/sync', async (req, res, p) => {
        try { await panel.sync(p.subject, req.params.id); return res.redirect(303, '/panel?done=synced'); } catch (err) { return back(res, '/panel', err); }
    });
    post('/panel/c/:id/remove', async (req, res, p) => {
        try { await panel.remove(p, req.params.id); return res.redirect(303, '/panel?done=removed'); } catch (err) { return back(res, '/panel', err); }
    });

    pages.get('/panel/z/:conn/:zone', async (req, res) => {
        const p = person(req);
        if (!p) return toLogin(req, res);
        try {
            const { conn, zone } = await panel.zone(p.subject, req.params.conn, req.params.zone);
            const records = await panel.records(p.subject, conn.id, zone.zone_id);
            return privateHtml(res, 200, views.zone({ conn, zone, records }));
        } catch (err) {
            if (err.status === 404) return res.redirect(303, '/panel');
            return back(res, '/panel', err);
        }
    });
    post('/panel/z/:conn/:zone/propose', async (req, res, p) => {
        const b = req.body;
        const rec = { type: b.type, name: b.name, content: b.content, ttl: b.ttl, priority: b.priority, proxied: b.proxied === 'on' };
        const change = b.op === 'create' ? { op: 'create', after: rec } : b.op === 'update' ? { op: 'update', record_id: b.record_id, after: rec } : { op: 'delete', record_id: b.record_id };
        try {
            const row = await panel.propose(p.subject, `user:${p.subject}`, { connection_id: req.params.conn, zone_id: req.params.zone, why: b.why, changes: [change] });
            return res.redirect(303, `/panel/p/${row.id}`);
        } catch (err) {
            if (!err.status || err.status >= 500 || err.status === 404) return back(res, `/panel/z/${encodeURIComponent(req.params.conn)}/${encodeURIComponent(req.params.zone)}`, err);
            const { conn, zone } = await panel.zone(p.subject, req.params.conn, req.params.zone);
            const records = await panel.records(p.subject, conn.id, zone.zone_id).catch(() => []);
            return privateHtml(res, 422, views.zone({ conn, zone, records, error: err.message, values: b.op === 'create' ? { ...rec, why: b.why } : {} }));
        }
    });

    pages.get('/panel/p/:id', async (req, res) => {
        const p = person(req);
        if (!p) return toLogin(req, res);
        try {
            const row = await panel.get(p.subject, req.params.id);
            const pub = { ...panel.toPublic(row), can_roll_back: Array.isArray(row.rollback) ? row.rollback.length > 0 : JSON.parse(row.rollback || '[]').length > 0 };
            const done = String(req.query.done || '');
            const words = done === 'approved' ? (pub.status === 'applied' ? 'Applied. Cloudflare has the change; caches catch up within the TTL.' : 'Approved, but it did not apply. See why below.') : notice(req);
            return privateHtml(res, 200, views.proposal({ p: pub, notice: words }));
        } catch (err) {
            if (err.status === 404) return res.redirect(303, '/panel');
            throw err;
        }
    });
    post('/panel/p/:id/decide', async (req, res, p) => {
        const decision = req.body.decision === 'approve' ? 'approve' : 'decline';
        try { await panel.decide(p.subject, req.params.id, decision, `user:${p.subject}`); } catch (err) { return back(res, `/panel/p/${encodeURIComponent(req.params.id)}`, err); }
        return res.redirect(303, `/panel/p/${encodeURIComponent(req.params.id)}?done=${decision === 'approve' ? 'approved' : 'declined'}`);
    });
    post('/panel/p/:id/rollback', async (req, res, p) => {
        try { await panel.rollBack(p.subject, req.params.id, `user:${p.subject}`); } catch (err) { return back(res, `/panel/p/${encodeURIComponent(req.params.id)}`, err); }
        return res.redirect(303, `/panel/p/${encodeURIComponent(req.params.id)}?done=rolled_back`);
    });

    // ── API ─────────────────────────────────────────────────
    const api = asyncRouter();
    api.use(express.json({ limit: '64kb' }));
    api.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    api.use(principal.middleware);
    const problem = (req, res, err) => {
        if (err && err.status && err.status < 500) return http.sendProblem(res, err.status, err.code || 'domains.error', { detail: err.message, ctx: req.ov });
        if (err && err.status === 503) return http.sendProblem(res, 503, err.code || 'domains.unavailable', { detail: err.message, ctx: req.ov });
        log.error('[OpenVibe.Domains] panel API:', err && err.message ? err.message.slice(0, 200) : err);
        return http.sendProblem(res, 502, 'domains.upstream', { detail: 'A provider or OpenVibe.Network did not answer as expected.', ctx: req.ov });
    };
    const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { problem(req, res, err); } };
    const me = principal.requirePerson;

    api.get('/panel/connections', me, wrap(async (req, res) => {
        const rows = await panel.connections(req.principal.subject);
        res.json({ connections: rows.map((c) => ({ id: c.id, provider: c.provider, label: c.label, status: c.status, zones: c.zone_count, last_error: c.last_error || null, created_at: new Date(c.created_at).toISOString(), checked_at: c.checked_at ? new Date(c.checked_at).toISOString() : null })) });
    }));
    api.get('/panel/zones', me, wrap(async (req, res) => {
        const rows = await panel.zones(req.principal.subject);
        res.json({ zones: rows.map((z) => ({ connection_id: z.connection_id, zone_id: z.zone_id, name: z.name, status: z.status, name_servers: z.name_servers, provider: z.provider, synced_at: new Date(z.synced_at).toISOString() })) });
    }));
    api.get('/panel/zones/:conn/:zone/records', me, wrap(async (req, res) => {
        res.json({ records: await panel.records(req.principal.subject, req.params.conn, req.params.zone) });
    }));
    api.get('/proposals', me, wrap(async (req, res) => {
        res.json({ proposals: (await panel.list(req.principal.subject, { limit: 100 })).map(panel.toPublic) });
    }));
    api.get('/proposals/:id', me, wrap(async (req, res) => {
        res.json(panel.toPublic(await panel.get(req.principal.subject, req.params.id)));
    }));
    api.post('/proposals', me, wrap(async (req, res) => {
        const b = req.body || {};
        const row = await panel.propose(req.principal.subject, `user:${req.principal.subject}`, b);
        res.status(201).set('Location', `/api/v1/proposals/${row.id}`).json(panel.toPublic(row));
    }));
    api.post('/proposals/:id/rollback', me, wrap(async (req, res) => {
        res.json(panel.toPublic(await panel.rollBack(req.principal.subject, req.params.id, `user:${req.principal.subject}`)));
    }));
    api.post('/proposals/:id/decide', wrap(async (req, res, next) => {
        const decision = String((req.body || {}).decision || '');
        if (req.principal.kind === 'service') {
            return principal.requireService('domains.proposal.decide')(req, res, async () => {
                try {
                    const row = await panel.decide(req.subject, req.params.id, decision, `service:${req.principal.service}`);
                    res.json(panel.toActionItem(row));
                } catch (err) { problem(req, res, err); }
            });
        }
        return me(req, res, async () => {
            try { res.json(panel.toPublic(await panel.decide(req.principal.subject, req.params.id, decision, `user:${req.principal.subject}`))); } catch (err) { problem(req, res, err); }
        });
    }));
    api.get('/actions', principal.requireService('domains.actions.read'), wrap(async (req, res) => {
        const rows = await panel.list(req.subject, { since: new Date(Date.now() - 30 * 86_400_000).toISOString(), limit: 50 });
        res.json({ items: rows.map(panel.toActionItem) });
    }));

    return { pages, api };
}

module.exports = { createPanelRoutes };
