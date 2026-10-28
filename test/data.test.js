'use strict';

/** The two data clients: URL shapes, cache hit/expiry, the cap, a timeout, and a failure as null + one log line. */
const assert = require('assert');
const { createHost } = require('../server/data/host');
const { createTools } = require('../server/data/tools');
const { check, done } = require('./helpers');

const jsonResponse = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const quiet = { warn: () => {} };

(async () => {
    await check('host.tld: one call inside the TTL, two after it', async () => {
        let now = 1_000;
        let calls = 0;
        const urls = [];
        const host = createHost({
            baseUrl: 'http://host.test',
            fetchImpl: async (url) => { calls++; urls.push(String(url)); return jsonResponse({ tld: { tld: 'dev' } }); },
            now: () => now,
            cacheMs: { tld: 1_000 },
            log: quiet,
        });
        assert.strictEqual((await host.tld('dev')).tld, 'dev');
        assert.strictEqual((await host.tld('dev')).tld, 'dev');
        assert.strictEqual(calls, 1);
        assert.strictEqual(urls[0], 'http://host.test/api/v1/catalog/domains/dev');
        now += 1_001;
        await host.tld('dev');
        assert.strictEqual(calls, 2);
    });

    await check('host.check: a 2-minute TTL by default', async () => {
        let now = 5_000;
        let calls = 0;
        const host = createHost({
            baseUrl: 'http://host.test',
            fetchImpl: async () => { calls++; return jsonResponse({ check: { status: 'available' } }); },
            now: () => now,
            log: quiet,
        });
        await host.check('sushitruck');
        await host.check('sushitruck');
        assert.strictEqual(calls, 1);
        now += 2 * 60_000 + 1;
        await host.check('sushitruck');
        assert.strictEqual(calls, 2);
    });

    await check('host list and check build the documented URLs', async () => {
        const urls = [];
        const host = createHost({
            baseUrl: 'http://host.test/',
            fetchImpl: async (url) => { urls.push(String(url)); return jsonResponse({ tlds: [], next_cursor: null }); },
            log: quiet,
        });
        await host.tlds({ sort: 'popular' });
        await host.tlds({ q: 'dev', kind: 'generic', sort: 'register', page: 2 });
        await host.check('münchen.de');
        assert.strictEqual(urls[0], 'http://host.test/api/v1/catalog/domains?sort=popular');
        assert.strictEqual(urls[1], 'http://host.test/api/v1/catalog/domains?q=dev&kind=generic&sort=register&cursor=100');
        assert.match(urls[2], /\/api\/v1\/catalog\/domains\/check\?name=m%C3%BCnchen\.de$/);
    });

    await check('host: a failure is null, logged once, and not cached', async () => {
        const logs = [];
        let calls = 0;
        const host = createHost({
            baseUrl: 'http://host.test',
            fetchImpl: async () => { calls++; throw new Error('connection refused'); },
            log: { warn: (line) => logs.push(line) },
        });
        assert.strictEqual(await host.check('example.com'), null);
        assert.strictEqual(await host.check('example.com'), null);
        assert.strictEqual(calls, 2);
        assert.strictEqual(logs.length, 2);
        assert.match(logs[0], /^\[domains\] Host check failed: connection refused/);
    });

    await check('host: a timeout answers null quickly', async () => {
        const host = createHost({
            baseUrl: 'http://host.test',
            fetchImpl: () => new Promise(() => {}),
            timeoutMs: 25,
            log: quiet,
        });
        const started = Date.now();
        assert.strictEqual(await host.check('example.com'), null);
        assert.ok(Date.now() - started < 1_000, 'the timeout did not end the wait');
    });

    await check('the cache keeps its cap, oldest insertion out', async () => {
        let calls = 0;
        const host = createHost({
            baseUrl: 'http://host.test',
            fetchImpl: async () => { calls++; return jsonResponse({ check: { status: 'unknown' } }); },
            now: () => 1,
            cacheMs: { check: 60_000 },
            maxCacheEntries: 2,
            log: quiet,
        });
        await host.check('a');
        await host.check('b');
        await host.check('c');
        assert.strictEqual(calls, 3);
        await host.check('a');
        assert.strictEqual(calls, 4, 'the oldest entry should have been evicted');
    });

    await check('tools.history: normalized domain, cached ten minutes, URL encoded', async () => {
        let now = 10_000;
        let calls = 0;
        const urls = [];
        const tools = createTools({
            baseUrl: 'http://tools.test',
            fetchImpl: async (url) => { calls++; urls.push(String(url)); return jsonResponse({ domain: 'example.com', snapshots: [] }); },
            now: () => now,
            log: quiet,
        });
        assert.strictEqual((await tools.history('Example.COM.')).domain, 'example.com');
        await tools.history('example.com');
        assert.strictEqual(calls, 1);
        assert.strictEqual(urls[0], 'http://tools.test/api/v1/domains/example.com');
        now += 10 * 60_000 + 1;
        await tools.history('example.com');
        assert.strictEqual(calls, 2);
    });

    await check('tools.lists: limit is passed and cached', async () => {
        let calls = 0;
        const urls = [];
        const tools = createTools({
            baseUrl: 'http://tools.test',
            fetchImpl: async (url) => { calls++; urls.push(String(url)); return jsonResponse({ most_looked_up: [], expiring_soon: [] }); },
            log: quiet,
        });
        await tools.lists({ limit: 5 });
        await tools.lists({ limit: 5 });
        assert.strictEqual(calls, 1);
        assert.strictEqual(urls[0], 'http://tools.test/api/v1/domains/?limit=5');
    });

    await check('tools: a failure is null and logged', async () => {
        const logs = [];
        const tools = createTools({
            baseUrl: 'http://tools.test',
            fetchImpl: async () => { throw new Error('bad gateway'); },
            log: { warn: (line) => logs.push(line) },
        });
        assert.strictEqual(await tools.history('example.com'), null);
        assert.strictEqual(logs.length, 1);
        assert.match(logs[0], /^\[domains\] Tools history failed: bad gateway/);
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
