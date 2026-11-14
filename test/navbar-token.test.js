'use strict';
/**
 * The shared navbar's token (the owner, 11-14: the menu's Alerts said "Your notifications are on your account" on
 * Domains): the access cookie is HTTP-only, so the navbar asks /auth/navbar-token, same-origin and never cached, and
 * the page tells it where (tokenUrl). Signed out is 401; another site is refused.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers');

(async () => {
    const t = await boot({ host: { tlds: async () => [] }, tools: { lists: async () => [] } });
    const user = t.network.addUser('ada');
    const cookie = t.signIn(user);
    const at = t.network.userToken(user);

    await check('the signed-in person gets their token, same-origin and never cached', async () => {
        const r = await t.get('/auth/navbar-token', { cookie, headers: { 'Sec-Fetch-Site': 'same-origin' } });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json(), { token: at });
        assert.match(r.headers.get('cache-control') || '', /no-store/);
    });

    await check('signed out is 401', async () => {
        const r = await t.get('/auth/navbar-token', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
        assert.strictEqual(r.status, 401);
    });

    await check('another site is refused', async () => {
        const r = await t.get('/auth/navbar-token', { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } });
        assert.strictEqual(r.status, 403);
    });

    await check('the page tells the navbar where to ask', async () => {
        const page = await t.get('/');
        assert.ok(page.text.includes('"tokenUrl":"/auth/navbar-token"'), page.text.slice(0, 400));
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
