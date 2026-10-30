'use strict';
/**
 * Sign-in through openvibe-sdk/sso (0.73.0): the login redirect (PKCE S256, state, client id, redirect URI), the
 * health route (does the Network accept this site's client), /auth/me (a guest, a session, the old cookie) and
 * the readiness check that fails when the Network refuses this site's client.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers');

(async () => {
    const t = await boot({ host: { tlds: async () => [] }, tools: { lists: async () => [] } });
    const user = t.network.addUser('ada');

    await check('login redirects to the Network with state and an S256 code challenge', async () => {
        const r = await t.get('/auth/login?next=/panel');
        assert.strictEqual(r.status, 302);
        const loc = new URL(r.headers.get('location'));
        assert.strictEqual(loc.origin + loc.pathname, t.network.url + '/oauth/authorize');
        assert.strictEqual(loc.searchParams.get('client_id'), 'domains');
        assert.strictEqual(loc.searchParams.get('response_type'), 'code');
        assert.strictEqual(loc.searchParams.get('redirect_uri'), 'https://openvibe.domains/auth/callback');
        assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
        assert.match(loc.searchParams.get('state'), /^[A-Za-z0-9_-]{32}$/);
        assert.match(String(r.headers.get('set-cookie') || ''), /ov_oauth_state=.*Path=\/auth.*HttpOnly/i);
    });

    await check('/auth/health says whether the Network accepts this client', async () => {
        const r = await t.get('/auth/health');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json(), { ok: true, client: 'ok' });
    });

    await check('/auth/me: a guest is signed out; the old cookie is still the session', async () => {
        const guest = await t.get('/auth/me');
        assert.strictEqual(guest.status, 200);
        assert.deepStrictEqual(guest.json(), { user: null });
        const at = t.network.userToken(user);
        const me = await t.get('/auth/me', { cookie: 'dom_at=' + at });
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.json().user.username, 'ada');
        assert.ok(!me.text.includes(at), '/auth/me never returns the token');
    });

    await check('readiness fails when the Network refuses this site OAuth client', async () => {
        const r = await t.get('/api/ready');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json().checks.sso_client.status, 'ok');
        assert.strictEqual(r.json().checks.sso_client.required, true);
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
