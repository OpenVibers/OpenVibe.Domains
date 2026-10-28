'use strict';

/**
 * Small test harness (the same check/done shape as OpenVibe.Help's tests): each test file is its own
 * process, catches failures per check and exits nonzero if any failed.
 */
const http = require('http');
const configLib = require('../server/config');
const { createApp } = require('../server/app');

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

/** Boot the real app on an ephemeral port with injected host/tools clients. */
async function boot({ config, host, tools, release } = {}) {
    const cfg = config || configLib.load({
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://openvibe.domains', TRUST_PROXY: '1',
    });
    const quiet = { log() {}, info() {}, warn() {}, error() {} };
    const built = createApp({ config: cfg, host, tools, release, log: quiet });
    const server = await new Promise((resolve) => {
        const s = http.createServer(built.app);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    async function get(path, opts = {}) {
        const res = await fetch(base + path, { method: opts.method || 'GET', headers: opts.headers, redirect: 'manual' });
        const text = await res.text();
        return { status: res.status, headers: res.headers, text, json() { return JSON.parse(text); } };
    }

    return {
        base, ctx: built.ctx, get,
        async close() { await new Promise((resolve) => server.close(resolve)); },
    };
}

module.exports = { boot, check, done };
