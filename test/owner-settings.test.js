'use strict';
/**
 * Owner settings (D11) for Domains' registrar keys (server/settings.js, domains.registrars):
 *   - Cloudflare's API token and Porkbun's key pair have plain titles, 30+ character descriptions,
 *     x-owner-input words and a test each;
 *   - /internal/config is loopback only and needs domains.config.manage;
 *   - the secrets are write-only and marked in summaries, registrarKeys() reads the owner's values and
 *     falls back to the environment, and the test hooks never echo or log a key.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { boot, done } = require('./helpers');
const { createSettings } = require('../server/settings');

const CAP = 'domains.config.manage';
const NS = 'domains.registrars';
const USR = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const CF = 'cloudflare-owner-token-sentinel';
const PB = 'porkbun-owner-key-sentinel';
const PBS = 'porkbun-owner-secret-sentinel';

(async () => {
    const t = await boot();
    const bearer = t.network.serviceToken([CAP]);
    const cases = [];
    const check = async (name, fn) => {
        try { await fn(); cases.push(name); console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n${e.stack}`); process.exit(1); }
    };

    await check('the registrar keys have owner words and tests', async () => {
        const r = await t.get(`/internal/config/${NS}`, { bearer });
        assert.strictEqual(r.status, 200, r.text);
        const props = r.json().schema.properties;
        for (const key of ['cloudflare_api_token', 'porkbun_api_key', 'porkbun_secret_api_key']) {
            const f = props[key];
            assert.ok(f, `${key} exists`);
            assert.ok(f.title && f.title.length >= 3);
            assert.ok(f.description && f.description.length >= 30);
            assert.strictEqual(f['x-owner-input'].group, 'domains');
            assert.ok(f['x-owner-input'].unlocks.length > 20);
            assert.ok(/^https:\/\//.test(f['x-owner-input'].get_it_at));
            assert.strictEqual(f['x-owner-input'].test, true);
            assert.ok(f['x-required-for'].endsWith('domains'), `${key} names the feature`);
        }
    });

    await check('the routes are loopback only and need the capability', async () => {
        assert.strictEqual((await t.get(`/internal/config/${NS}`)).status, 401);
        assert.strictEqual((await t.get(`/internal/config/${NS}`, { bearer: t.network.serviceToken(['domains.actions.read']) })).status, 403);
        assert.strictEqual((await t.get(`/internal/config/${NS}`, { bearer, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 404);
    });

    await check('the keys are write-only and the environment is the fallback', async () => {
        const envOnly = createSettings({ db: t.store.db, env: { CLOUDFLARE_API_TOKEN: 'cf-env', PORKBUN_API_KEY: 'pb-env', PORKBUN_SECRET_API_KEY: 'pbs-env' } });
        await envOnly.ready;
        assert.deepStrictEqual(envOnly.registrarKeys(), { cloudflare: { apiToken: 'cf-env' }, porkbun: { apiKey: 'pb-env', secretApiKey: 'pbs-env' } });
        for (const [key, value] of [['cloudflare_api_token', CF], ['porkbun_api_key', PB], ['porkbun_secret_api_key', PBS]]) {
            const put = await t.get(`/internal/config/${NS}/secrets/${key}`, {
                method: 'PUT', json: { value, reason: 'owner test' }, bearer, headers: { 'x-ov-subject': USR, 'x-ov-fresh': '1' },
            });
            assert.strictEqual(put.status, 200, put.text);
            assert.ok(put.json().fingerprint, `${key} returns a marker`);
            assert.ok(!put.text.includes(value));
        }
        const summary = await t.get(`/internal/config/${NS}`, { bearer });
        assert.ok(summary.json().values.porkbun_secret_api_key.redacted);
        assert.ok(!summary.text.includes(PBS));
        assert.deepStrictEqual(t.ctx.settings.registrarKeys(), { cloudflare: { apiToken: CF }, porkbun: { apiKey: PB, secretApiKey: PBS } });
    });

    await check('the test hooks say ok/failed in one line and never echo a key', async () => {
        const logs = [];
        const log = { log: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
        const fake = createSettings({
            db: t.store.db, env: {}, log,
            probes: {
                cloudflare: async ({ apiToken }) => { throw new Error(`refused ${apiToken}`); },
                porkbun: async ({ apiKey, secretApiKey }) => { throw new Error(`refused ${apiKey} / ${secretApiKey}`); },
            },
        });
        await fake.ready;
        const app = express();
        app.use(express.json());
        fake.mount(app, { guard: (_req, _res, next) => next(), log });
        const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            for (const key of ['cloudflare_api_token', 'porkbun_api_key']) {
                const r = await fetch(`http://127.0.0.1:${server.address().port}/internal/config/${NS}/test/${key}`, { method: 'POST' });
                const body = await r.json();
                assert.strictEqual(r.status, 200);
                assert.strictEqual(body.ok, false);
                assert.ok(/^failed — /.test(body.detail), body.detail);
                assert.ok(!body.detail.includes(CF) && !body.detail.includes(PB) && !body.detail.includes(PBS), 'the answer is redacted');
                assert.ok(!body.detail.includes('\n'), 'one line');
            }
        } finally { server.close(); }
        assert.ok(!logs.join('\n').includes(CF) && !logs.join('\n').includes(PB) && !logs.join('\n').includes(PBS), 'no key in a captured log line');
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
