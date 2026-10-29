'use strict';

/** The agent layer: the manifest and the Markdown twins of the public pages, through the same model builder. */
const assert = require('assert');
const { boot, check, done } = require('./helpers');

const LIST = [
    { tld: 'com', display: '.com', kind: 'generic', currency: 'USD', register: 9.2, renew: 11.08, transfer: 9.2, five_year: 55.4, registrars: 2, checked_at: '2026-10-22T15:16:02.303Z' },
    { tld: 'dev', display: '.dev', kind: 'generic', currency: 'USD', register: 8.75, renew: 12.87, transfer: 12.87, five_year: 60.23, registrars: 2, checked_at: '2026-10-22T15:16:02.303Z' },
];
const PRICES = [
    { registrar: 'Porkbun', registrar_slug: 'porkbun', tld: 'dev', display: '.dev', kind: 'generic', currency: 'USD', register: 8.75, renew: 12.87, transfer: 12.87, five_year: 60.23, checked_at: '2026-10-22T15:16:02.303Z' },
];
const host = {
    async tlds() { return { tlds: LIST, next_cursor: null }; },
    async tld(t) {
        return { tld: t, display: `.${t}`, kind: 'generic', currency: 'USD', prices: PRICES.filter((p) => p.tld === t), history: [] };
    },
    async check(name) {
        return { label: String(name).split('.')[0], name, tld: 'dev', status: 'available', prices: PRICES };
    },
};
const tools = {
    async history(domain) { return { domain, snapshots: [], changes: [], lookups: 0 }; },
    async lists() { return { most_looked_up: [] }; },
};

(async () => {
    const t = await boot({ host, tools });
    try {
        await check('manifest is JSON with only the endpoints Domains really serves', async () => {
            const r = await t.get('/.well-known/agent.json');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /application\/json/);
            const m = r.json();
            assert.strictEqual(m.id, 'domains');
            assert.strictEqual(m.home, 'https://openvibe.domains');
            assert.strictEqual(m.api, 'https://openvibe.domains/api/v1');
            assert.strictEqual(m.docs, 'https://openvibe.domains/developers');
            assert.deepStrictEqual(m.policy.auth, ['none', 'Network OIDC']);
            assert.strictEqual(m.openapi, undefined);
            assert.strictEqual(m.mcp, undefined);
        });

        await check('the home names its twin in the head and the Link header', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('<link rel="alternate" type="text/markdown" href="https://openvibe.domains/index.md">'));
            assert.match(r.headers.get('link'), /https:\/\/openvibe\.domains\/index\.md>; rel="alternate"; type="text\/markdown"/);
        });

        await check('/index.md and /tld/dev.md are Markdown of the same pages; unknown twins are 404', async () => {
            const home = await t.get('/index.md');
            assert.strictEqual(home.status, 200);
            assert.match(home.headers.get('content-type'), /text\/markdown/);
            assert.ok(home.text.startsWith('---\ntitle:'));
            assert.ok(home.text.includes('.dev') && home.text.includes('$34.49'));
            const tld = await t.get('/tld/dev.md');
            assert.strictEqual(tld.status, 200);
            assert.ok(tld.text.includes('# .dev domain prices: every registrar, 1, 3 and 5 years'));
            assert.ok(tld.text.includes('Porkbun'));
            assert.strictEqual((await t.get('/no-such-page.md')).status, 404);
            assert.strictEqual((await t.get('/panel.md')).status, 404);
        });

        await check('/.well-known/security.txt is not swallowed by the layer, and robots names the manifest', async () => {
            const sec = await t.get('/.well-known/security.txt');
            assert.strictEqual(sec.status, 404);
            assert.doesNotMatch(sec.headers.get('content-type') || '', /application\/json/);
            const robots = await t.get('/robots.txt');
            assert.strictEqual(robots.status, 200);
            assert.ok(robots.text.includes('# Agent manifest: https://openvibe.domains/.well-known/agent.json'));
        });
    } finally {
        await t.close();
        done();
    }
})();
