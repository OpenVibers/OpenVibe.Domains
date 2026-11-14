'use strict';
/**
 * The owner's registrar rows (plan §AB.19, 2026-11-13: "each registrar (Cloudflare, Porkbun, Namecheap, Gandi,
 * Dynadot, Spaceship) as one row with its key pair, what it lets OpenVibe do (list, renew, set DNS), and DNSSEC as
 * a guided sub-step with the records shown to copy"):
 *
 *   - every registrar is one row: all of its fields share one x-required-for, so the Setup tab shows it once;
 *   - every field has plain words, a 30+ character description, an https page to get it at, and a test;
 *   - the test of a registrar lists the domains the account holds, from a recorded answer, and never writes;
 *   - the DNSSEC row answers with the DS record to copy at the registrar, computed the way DNSSEC says;
 *   - a secret is write-only, marked in summaries, and never echoed by a test or a log line.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { boot, done } = require('./helpers');
const { createSettings } = require('../server/settings');
const { REGISTRARS } = require('../server/registrars');
const { LISTS } = require('../server/registrar-clients');
const { dnskeysOf, dsRecord, keyTag, parseDnskey } = require('../server/dnssec');

const CAP = 'domains.config.manage';
const NS = 'domains.registrars';
const DNSNS = 'domains.dnssec';
const USR = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';

/** The recorded answers of each registrar, as they came back the day they were taken. */
const RECORDED = {
    cloudflare: {
        url: 'https://api.cloudflare.com/client/v4/zones',
        body: {
            success: true, errors: [], messages: [],
            result: [{ id: 'zone_1', name: 'openvibe.network' }, { id: 'zone_2', name: 'openvibe.email' }],
            result_info: { page: 1, per_page: 50, total_pages: 1, count: 2, total_count: 2 },
        },
    },
    porkbun: {
        url: 'https://api.porkbun.com/api/json/v3/domain/listAll',
        body: {
            status: 'SUCCESS',
            domains: [
                { domain: 'openvibe.network', status: 'ACTIVE' },
                { domain: 'openvibe.email', status: 'ACTIVE' },
                { domain: 'openvibe.email', status: 'ACTIVE' },
            ],
        },
    },
    namecheap: {
        url: 'https://api.namecheap.com/xml.response',
        body: '<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="OK"><Errors/><DomainList>'
            + '<Domain>openvibe.network</Domain><Domain>openvibe.email</Domain></DomainList></ApiResponse>',
    },
    gandi: {
        url: 'https://api.gandi.net/v5/domain/domains',
        body: [{ name: 'openvibe.network' }, { name: 'openvibe.email' }],
    },
    dynadot: {
        url: 'https://api.dynadot.com/restful/v2/domains/list',
        body: '<?xml version="1.0" encoding="utf-8"?><domains><domain><name>openvibe.network</name>'
            + '<expiration>2030-01-01</expiration></domain><domain><name>openvibe.email</name></domain></domains>',
    },
    spaceship: {
        url: 'https://spaceship.dev/api/v1/domains',
        body: { items: [{ domain: 'openvibe.network' }, { domain: 'openvibe.email' }], totalCount: 2 },
    },
};

/** The keys each registrar is given in this test, never a real one. */
const CREDS = {
    cloudflare: { apiToken: 'cf-token-sentinel' },
    porkbun: { apiKey: 'pb-key-sentinel', secretApiKey: 'pb-secret-sentinel' },
    namecheap: { apiUser: 'nc-user-sentinel', apiKey: 'nc-key-sentinel', clientIp: '192.0.2.10' },
    gandi: { apiToken: 'gandi-token-sentinel' },
    dynadot: { apiKey: 'dd-key-sentinel', apiSecret: 'dd-secret-sentinel' },
    spaceship: { apiKey: 'ss-key-sentinel', apiSecret: 'ss-secret-sentinel' },
};

/** A fetch that answers with the recorded answers and refuses anything else. */
function recordedFetch(calls) {
    return async (url, options = {}) => {
        const href = String(url);
        for (const [id, rec] of Object.entries(RECORDED)) {
            if (!href.startsWith(rec.url)) continue;
            calls.push({ id, url: href, method: options.method || 'GET' });
            const text = typeof rec.body === 'string' ? rec.body : JSON.stringify(rec.body);
            return {
                ok: true, status: 200,
                headers: { get: () => 'application/json' },
                async text() { return text; },
                async json() { return JSON.parse(text); },
            };
        }
        throw new Error('no recorded answer for ' + href);
    };
}

(async () => {
    const t = await boot();
    const bearer = t.network.serviceToken([CAP]);
    const cases = [];
    const check = async (name, fn) => {
        try { await fn(); cases.push(name); console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n${e.stack}`); process.exit(1); }
    };

    await check('every registrar is one row with plain words and a test', async () => {
        const r = await t.get(`/internal/config/${NS}`, { bearer });
        assert.strictEqual(r.status, 200, r.text);
        const props = r.json().schema.properties;
        const seen = new Set();
        for (const registrar of REGISTRARS) {
            const required = registrar.keys.map((k) => props[k.name]['x-required-for']);
            assert.strictEqual(new Set(required).size, 1, `${registrar.name}: one row`);
            assert.strictEqual(required[0], `${registrar.name} domains`);
            seen.add(required[0]);
            for (const key of registrar.keys) {
                const f = props[key.name];
                assert.ok(f, `${key.name} exists`);
                assert.ok(f.title && f.title.length >= 3, `${key.name} has a title`);
                assert.ok(f.description && f.description.length >= 30, `${key.name} has a description`);
                assert.strictEqual(f['x-owner-input'].group, 'domains');
                assert.ok(f['x-owner-input'].unlocks.length > 30, `${key.name} says what it unlocks`);
                assert.ok(/^https:\/\//.test(f['x-owner-input'].get_it_at), `${key.name} has an https page`);
                assert.ok(f['x-owner-input'].get_it_how && f['x-owner-input'].get_it_how.length > 20);
                assert.strictEqual(f['x-owner-input'].test, true, `${key.name} has a test`);
            }
        }
        assert.strictEqual(seen.size, REGISTRARS.length, 'one row per registrar');
    });

    await check('the DNSSEC row is a guided row in the domains group', async () => {
        const r = await t.get(`/internal/config/${DNSNS}`, { bearer });
        assert.strictEqual(r.status, 200, r.text);
        const f = r.json().schema.properties.dnssec_domain;
        assert.ok(f, 'the DNSSEC field exists');
        assert.ok(f.title && f.title.length >= 3);
        assert.ok(f.description && f.description.length >= 30);
        assert.strictEqual(f['x-owner-input'].group, 'domains');
        assert.ok(f['x-owner-input'].unlocks.length > 30);
        assert.ok(/^https:\/\//.test(f['x-owner-input'].get_it_at));
        assert.strictEqual(f['x-owner-input'].test, true);
        assert.ok(f['x-required-for'], 'the row names what waits on it');
    });

    await check('the test of a registrar lists its domains from the recorded answer', async () => {
        const calls = [];
        const settings = createSettings({
            db: t.store.db, env: {}, fetchImpl: recordedFetch(calls),
            probes: Object.fromEntries(REGISTRARS.map((r) => [r.id, (creds) => LISTS[r.id](creds, { fetchImpl: recordedFetch(calls) })])),
        });
        await settings.ready;
        for (const registrar of REGISTRARS) {
            const creds = CREDS[registrar.id];
            const names = await LISTS[registrar.id](creds, { fetchImpl: recordedFetch(calls) });
            assert.ok(Array.isArray(names) && names.length, `${registrar.name} lists domains`);
            assert.ok(names.includes('openvibe.network'), `${registrar.name} names the domain`);
            assert.ok(names.every((n) => typeof n === 'string' && n === n.toLowerCase()));
        }
        assert.strictEqual(calls.length, REGISTRARS.length, 'one read per registrar');
    });

    await check('the test route answers ok in one line for every registrar', async () => {
        const calls = [];
        // The keys are put in the vault the way the panel puts them there: the secrets through the write-only
        // route, the plain ones (an allowed address is not a secret) through the normal one.
        for (const registrar of REGISTRARS) {
            const plain = {};
            for (const key of registrar.keys) {
                if (!key.secret) { plain[key.name] = CREDS[registrar.id][key.local]; continue; }
                const put = await t.get(`/internal/config/${NS}/secrets/${key.name}`, {
                    method: 'PUT', json: { value: CREDS[registrar.id][key.local], reason: 'owner test' },
                    bearer, headers: { 'x-ov-subject': USR, 'x-ov-fresh': '1' },
                });
                assert.strictEqual(put.status, 200, put.text);
                assert.ok(!put.text.includes(CREDS[registrar.id][key.local]), 'the value never comes back');
            }
            if (Object.keys(plain).length) {
                const applied = await t.get(`/internal/config/${NS}`, {
                    method: 'POST', json: { values: plain, merge: true, reason: 'owner test' },
                    bearer, headers: { 'x-ov-subject': USR, 'x-ov-fresh': '1' },
                });
                assert.strictEqual(applied.status, 200, applied.text);
            }
        }
        // The store is made after the keys are in the vault, so it reads them.
        const settings = createSettings({ db: t.store.db, env: {}, fetchImpl: recordedFetch(calls) });
        await settings.ready;
        const app = express();
        app.use(express.json());
        settings.mount(app, { guard: (_req, _res, next) => next() });
        const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            for (const registrar of REGISTRARS) {
                const key = registrar.keys.find((k) => k.secret);
                const res = await fetch(`http://127.0.0.1:${server.address().port}/internal/config/${NS}/test/${key.name}`, { method: 'POST' });
                const body = await res.json();
                assert.strictEqual(res.status, 200);
                assert.strictEqual(body.ok, true, `${registrar.name}: ${body.detail}`);
                assert.ok(/^ok — /.test(body.detail), body.detail);
                assert.strictEqual(body.message, body.detail, 'the Setup tab reads the same line under message');
                assert.ok(!body.detail.includes('\n'), 'one line');
                for (const cred of Object.values(CREDS[registrar.id])) assert.ok(!body.detail.includes(cred), 'no key in the answer');
            }
        } finally { server.close(); }
    });

    await check('a refused key answers failed in one line with no key in it', async () => {
        const logs = [];
        const log = { log: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
        const settings = createSettings({
            db: t.store.db, env: {}, log,
            probes: Object.fromEntries(REGISTRARS.map((r) => [r.id, async (creds) => {
                const secret = Object.values(creds).find((v) => typeof v === 'string' && v.length > 4);
                throw new Error(`refused ${secret}`);
            }])),
        });
        await settings.ready;
        const app = express();
        app.use(express.json());
        settings.mount(app, { guard: (_req, _res, next) => next(), log });
        const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            for (const registrar of REGISTRARS) {
                const key = registrar.keys.find((k) => k.secret);
                const res = await fetch(`http://127.0.0.1:${server.address().port}/internal/config/${NS}/test/${key.name}`, { method: 'POST' });
                const body = await res.json();
                assert.strictEqual(res.status, 200);
                assert.strictEqual(body.ok, false, `${registrar.name}`);
                assert.ok(/^failed — /.test(body.detail), body.detail);
                assert.strictEqual(body.message, body.detail, 'the Setup tab reads the same line under message');
                assert.ok(!body.detail.includes('\n'), 'one line');
                for (const cred of Object.values(CREDS[registrar.id])) assert.ok(!body.detail.includes(cred), 'no key in the answer');
            }
        } finally { server.close(); }
        for (const registrar of REGISTRARS) {
            for (const cred of Object.values(CREDS[registrar.id])) {
                assert.ok(!logs.join('\n').includes(cred), 'no key in a captured log line');
            }
        }
    });

    await check('the DNSSEC test shows the DS record to copy', async () => {
        // The root zone's KSK-2017: its published DS record is a known value, so the math is checked against it.
        const rootKsk = '257 3 8 AwEAAaz/tAm8yTn4Mfeh5eyI96WSVexTBAvkMgJzkKTOiW1vkIbzxeF3+/4RgWOq7HrxRixHlFlExOLAJr5emLvN7SWXgnLh4+B5xQlNVz8Og8kvArMtNROxVQuCaSnIDdD5LKyWbRd2n9WGe2R8PzgCmr3EgVLrjyBxWezF0jLHwVN8efS3rCj/EWgvIWgb9tarpVUDK/b58Da+sqqls3eNbuv7pr+eoZG+SrDK6nWeL3c6H5Apxz7LjVc1uTIdsIXxuOLYA4/ilBmSVIzuDWfdRUfhHdY6+cn8HFRm+2hM8AnXGXws9555KrUB5qihylGa8subX2Nn6UwNR1AkUTV74bU=';
        const parsed = parseDnskey(rootKsk);
        assert.ok(parsed, 'the DNSKEY parses');
        assert.strictEqual(keyTag(parsed.rdata, parsed.algorithm), 20326, 'the key tag is the published one');
        assert.strictEqual(
            dsRecord('.', parsed).content,
            '20326 8 2 E06D44B80B8F1D39A95C0B0D7C65D08458E880409BBC683457104237C7F8EC8D',
            'the DS record is the published one',
        );

        // The row itself: the owner names a domain, the test answers with the record to copy.
        const settings = createSettings({
            db: t.store.db, env: {},
            probes: { dnssec: async (domain) => [parseDnskey(rootKsk)] },
        });
        await settings.ready;
        await settings.dnssecStore().apply({ dnssec_domain: 'openvibe.network' }, { merge: true, actor: { type: 'user', id: USR }, reason: 'owner test' });
        const out = await settings.test(DNSNS, 'dnssec_domain');
        assert.strictEqual(out.ok, true, out.detail);
        // The key tag is the published one; the digest is over the owner's own name, so it differs from the root's.
        assert.ok(/20326 8 2 [0-9A-F]{64}/.test(out.detail), out.detail);
        assert.ok(out.detail.startsWith('ok — '), out.detail);
    });

    await check('the DNSSEC test says what to do when the domain has no key yet', async () => {
        const settings = createSettings({
            db: t.store.db, env: {},
            probes: { dnssec: async () => { throw new Error('openvibe.network publishes no DNSKEY, so it has no DS record yet. Turn on DNSSEC at the host that holds its DNS first.'); } },
        });
        await settings.ready;
        await settings.dnssecStore().apply({ dnssec_domain: 'openvibe.network' }, { merge: true, actor: { type: 'user', id: USR }, reason: 'owner test' });
        const out = await settings.test(DNSNS, 'dnssec_domain');
        assert.strictEqual(out.ok, false);
        assert.ok(/^failed — /.test(out.detail), out.detail);
        assert.ok(out.detail.includes('DNSKEY'), out.detail);
    });

    await check('the DNSSEC lookup reads the public DNS and needs no account', async () => {
        const dns = await dnskeysOf('example.com', { fetchImpl: async (url) => ({
            ok: true, status: 200,
            async json() {
                return {
                    Status: 0,
                    Answer: [
                        { name: 'example.com', type: 48, TTL: 2560, data: '256 3 13 MjyZielP0GqniI1+j+wAG/3t0ImDDIlj1CxR0oobkZQHSKH2Fqx6tm2NcYu57POJ83SzCWLkqIjZHS1mh5wbaw==' },
                        { name: 'example.com', type: 48, TTL: 2560, data: '256 3 13 kxipjoIbNZDsWqEKaYaGq6fM/XThrRp1ue6AV9R/n3eWxpGCeCWJb47PEEEj/Q6VAYFW/7UFo5mXoZfxKYZa3A==' },
                    ],
                };
            },
        }) });
        assert.strictEqual(dns.length, 2);
        for (const key of dns) {
            const rec = dsRecord('example.com', key);
            assert.ok(/^\d+ \d+ 2 [0-9A-F]{64}$/.test(rec.content), rec.content);
        }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
