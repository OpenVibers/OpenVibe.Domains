'use strict';

/**
 * Small test harness (the same check/done shape as OpenVibe.Help's tests): each test file is its own
 * process, catches failures per check and exits nonzero if any failed.
 */
const http = require('http');
const configLib = require('../server/config');
const { createApp } = require('../server/app');
const { createStore, MIGRATIONS } = require('../server/db');
const { createTestDb } = require('openvibe-sdk/testing');

let failures = 0;

async function check(name, fn) {
    try {
        await fn();
        process.stdout.write(`  ✓ ${name}\n`);
    } catch (err) {
        failures++;
        process.stdout.write(`  ✗ ${name}\n      ${(err.stack || String(err)).split('\n').slice(0, 8).join('\n      ')}\n`);
    }
}

function done() {
    process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n');
    process.exit(failures ? 1 : 0);
}

/**
 * Boot the real app on an ephemeral port with injected host/tools clients, a migrated test database (PGlite, or the
 * PostgreSQL containers with DOMAINS_TEST_STORE=pg) and, for the control panel, a Network stand-in and providers.
 *
 *   const t = await boot({ host, tools, network, providers, fetchImpl, now });
 *   await t.get(path, { method, headers, cookie, form, json, bearer, origin })
 */
async function boot({ config, host, tools, release, network = null, providers, fetchImpl, now } = {}) {
    const env = { NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://openvibe.domains', TRUST_PROXY: '1' };
    if (network) Object.assign(env, { OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url, OV_NETWORK_ISSUER: network.url, OV_OAUTH_CLIENT_ID: 'domains', OV_OAUTH_CLIENT_SECRET: 'domains-secret' });
    const cfg = config || configLib.load(env);
    const quiet = { log() {}, info() {}, warn() {}, error() {} };
    const testDb = await createTestDb({ migrations: MIGRATIONS, store: process.env.DOMAINS_TEST_STORE || 'pglite', service: 'domains', max: 4 });
    const store = createStore(testDb.db || testDb, { now });
    const built = await createApp({ config: cfg, host, tools, release, log: quiet, store, providers, fetchImpl });
    const server = await new Promise((resolve) => {
        const s = http.createServer(built.app);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    async function get(path, opts = {}) {
        const headers = { ...(opts.headers || {}) };
        let body;
        if (opts.cookie) headers.cookie = opts.cookie;
        if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
        if (opts.origin !== undefined) { if (opts.origin) headers.origin = opts.origin; } else if (opts.form || opts.json) headers.origin = 'https://openvibe.domains';
        if (opts.form) { body = new URLSearchParams(opts.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers['content-type'] = 'application/json'; }
        const res = await fetch(base + path, { method: opts.method || (body !== undefined ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
        const text = await res.text();
        return { status: res.status, headers: res.headers, text, json() { return JSON.parse(text); } };
    }

    return {
        base, ctx: built.ctx, get, store, network,
        /** A person's session cookie (dom_at), as sign-in sets it. */
        signIn: (user) => `dom_at=${network.userToken(user)}`,
        async close() {
            await new Promise((resolve) => server.close(resolve));
            try { await (testDb.close ? testDb.close() : store.close()); } catch { /* already closed */ }
        },
    };
}

module.exports = { boot, check, done };
