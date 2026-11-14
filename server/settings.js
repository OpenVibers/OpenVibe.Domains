'use strict';

/**
 * Owner settings (D11) for OpenVibe.Domains: the registrar keys in `domains.registrars` and the DNSSEC step in
 * `domains.dnssec`.
 *
 * The registrars Domains works with are Cloudflare, Porkbun, Namecheap, Gandi, Dynadot and Spaceship
 * (server/registrars.js). A person's own connection token is still read from their Network vault for that person's
 * zones; these owner keys are the service-wide fallback, read at the moment a registrar call is made. The admin
 * panel's value wins over the environment (CLOUDFLARE_API_TOKEN, PORKBUN_API_KEY, …). Secrets are sealed by the
 * shared store under OV_CONFIG_KEKS and are write-only through /internal/config/domains.registrars/secrets/:key;
 * summaries, history and logs carry markers. Network's admin proxy reaches these namespaces with
 * `domains.config.manage`, acting for the owner (X-OV-Subject); a secret change needs X-OV-Fresh: 1.
 *
 * The test route makes one cheap authenticated read per registrar and answers ok or failed in one line, never
 * echoing a key: it lists the domains the account holds (server/registrar-clients.js). The DNSSEC test reads the
 * domain's public DNSKEY and answers with the DS record to copy at the registrar (server/dnssec.js).
 */
const { createConfigStore, adminRoutes } = require('openvibe-shared/config');
const { REGISTRARS, requiredFor, registrarOfKey, SECRET_KEYS } = require('./registrars');
const { LISTS } = require('./registrar-clients');
const { dnskeysOf, dsRecord } = require('./dnssec');

const SERVICE = 'domains';
const NAMESPACE = 'domains.registrars';
const DNSSEC_NAMESPACE = 'domains.dnssec';
const BASE_PATH = '/internal/config';
const GROUP = 'Domains';

/**
 * The schema of the registrar namespace, built from the registry (server/registrars.js), so a registrar is
 * described in one place only. Every field of one registrar shares one x-required-for, so the owner's Setup tab
 * shows the registrar once with its fields under it.
 */
const SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Domain registrars',
    description: 'The registrar accounts Domains reads prices and changes DNS with. A registrar with no key is skipped; people can still connect their own account.',
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(REGISTRARS.flatMap((registrar) => registrar.keys.map((key) => [key.name, {
        type: 'string',
        title: key.title,
        description: key.words,
        'x-group': GROUP,
        'x-owner-input': {
            group: 'domains',
            unlocks: registrar.unlocks,
            get_it_at: registrar.get_it_at,
            get_it_how: registrar.get_it_how,
            test: true,
        },
        'x-required-for': requiredFor(registrar),
    }]))),
});

/**
 * The DNSSEC step (plan §AB.19: "DNSSEC as a guided sub-step with the records shown to copy"). The owner names the
 * domain; the test reads its public DNSKEY and answers with the DS record to paste at the registrar. Nothing is
 * stored and nothing is signed from here: the registrar is where a DS record is given.
 */
const DNSSEC_SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'DNSSEC',
    description: 'Signing your domains so nobody can answer for them with a false address. Name a domain here and its test shows the DS record to copy at the registrar.',
    type: 'object',
    additionalProperties: false,
    properties: {
        dnssec_domain: {
            type: 'string',
            title: 'Domain to sign',
            description: 'The domain you want signed, as plain text with no address in front (for example openvibe.network). Its test reads the domain\'s public DNS key and answers with the DS record to copy at the registrar.',
            'x-group': GROUP,
            'x-example': 'openvibe.network',
            'x-owner-input': {
                group: 'domains',
                unlocks: 'Turns on DNSSEC for your domain: the DS record the test shows is what your registrar has to be given.',
                get_it_at: 'https://developers.cloudflare.com/dns/dnssec/',
                get_it_how: 'Turn on DNSSEC for the domain at the host that holds its DNS (Cloudflare: DNS, then Settings), then copy the DS record the test answers into your registrar.',
                test: true,
            },
            'x-required-for': 'DNSSEC signing',
        },
    },
});

const SECRETS = new Set(SECRET_KEYS);
const ACTIVE = { settings: null };

function createSettings({ db, env = process.env, log = console, fetchImpl = globalThis.fetch, probes = null } = {}) {
    let store = null;
    let dnssecStore = null;
    const ready = Promise.all([
        createConfigStore({
            db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA,
            classify: (key) => (SECRETS.has(key) ? 'secret' : 'internal'),
            env, log,
        }),
        createConfigStore({
            db, service: SERVICE, namespace: DNSSEC_NAMESPACE, schema: DNSSEC_SCHEMA,
            classify: () => 'internal',
            env, log,
        }),
    ]).then(([made, dnssec]) => { store = made; dnssecStore = dnssec; return made; });

    const values = () => (store ? store.get() : {});

    function valueOf(key, envName, fallback = '') {
        const v = values()[key];
        if (v !== undefined && v !== null && v !== '') return v;
        const e = envName ? env[envName] : undefined;
        return e !== undefined && e !== null && e !== '' ? e : fallback;
    }

    /** The registrar keys, read when a registrar call is made. */
    function registrarKeys() {
        return {
            cloudflare: { apiToken: valueOf('cloudflare_api_token', 'CLOUDFLARE_API_TOKEN', '') },
            porkbun: {
                apiKey: valueOf('porkbun_api_key', 'PORKBUN_API_KEY', ''),
                secretApiKey: valueOf('porkbun_secret_api_key', 'PORKBUN_SECRET_API_KEY', ''),
            },
        };
    }

    /** The keys of every registrar, read from the vault (the environment is the fallback). */
    function allRegistrarKeys() {
        const out = {};
        for (const registrar of REGISTRARS) {
            const creds = {};
            for (const key of registrar.keys) {
                creds[key.local] = key.secret ? valueOf(key.name, key.env, '') : valueOf(key.name, key.env, '');
            }
            out[registrar.id] = creds;
        }
        return out;
    }

    /** The names of the secret values of a registrar, so a refusal never carries one. */
    function secretsOf(registrar) {
        return registrar.keys.filter((k) => k.secret).map((k) => valueOf(k.name, k.env, '')).filter(Boolean);
    }

    /**
     * The test of a registrar's field: one cheap authenticated read that lists the domains the account holds.
     * It never writes and never spends. A refusal is one line with the registrar's own words and no key in it.
     */
    async function testRegistrar(registrar) {
        const creds = allRegistrarKeys()[registrar.id];
        const missing = registrar.keys.filter((k) => !creds[k.local]);
        if (missing.length) {
            const what = missing.map((k) => k.title).join(' and ');
            return { ok: false, detail: `${registrar.name} is not set up yet: paste the ${what} first.` };
        }
        const probe = probes && probes[registrar.id] ? probes[registrar.id] : LISTS[registrar.id];
        try {
            const names = await probe(creds, { fetchImpl });
            const list = Array.isArray(names) ? names : [];
            const howMany = list.length === 1 ? 'one domain' : `${list.length} domains`;
            return { ok: true, detail: `ok — ${registrar.name} answered: the account holds ${howMany}.` };
        } catch (err) {
            let words = String((err && err.message) || 'the request failed');
            for (const secret of secretsOf(registrar)) words = words.split(secret).join('[redacted]');
            words = words.split(/\s+/).join(' ').slice(0, 160);
            return { ok: false, detail: `failed — ${registrar.name} said: ${words}` };
        }
    }

    /** The test of the DNSSEC field: the DS records of the named domain, to copy at the registrar. */
    async function testDnssec() {
        const domain = String((dnssecStore ? dnssecStore.get() : {}).dnssec_domain || '').trim().replace(/\.$/, '');
        if (!domain) return { ok: false, detail: 'Name the domain to sign first: put it in the field and save.' };
        const read = probes && probes.dnssec ? probes.dnssec : dnskeysOf;
        try {
            const keys = await read(domain, { fetchImpl });
            const records = keys.map((key) => dsRecord(domain, key));
            const first = records[0].content;
            const more = records.length > 1 ? ` (${records.length} keys are published; give the registrar the one it asks for.)` : '';
            return { ok: true, detail: `ok — copy this at the registrar: ${first}${more}` };
        } catch (err) {
            const words = String((err && err.message) || 'the lookup failed').split(/\s+/).join(' ').slice(0, 200);
            return { ok: false, detail: `failed — ${words}` };
        }
    }

    /** The test of any field of these namespaces. */
    async function test(namespace, key) {
        if (namespace === DNSSEC_NAMESPACE) return key === 'dnssec_domain' ? await testDnssec() : { ok: false, detail: 'That setting has no test.' };
        const registrar = registrarOfKey(key);
        if (!registrar) return { ok: false, detail: 'That setting has no test.' };
        return await testRegistrar(registrar);
    }

    function mount(app, { guard, log: appLog = log } = {}) {
        if (!store) throw new Error('createSettings: await ready before mount()');
        const routes = adminRoutes([store, dnssecStore], {
            basePath: BASE_PATH,
            requireAdmin: guard,
            actor: (req) => {
                const id = String(req.get('x-ov-subject') || '').trim();
                return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? { type: 'user', id } : null;
            },
            requireFresh: (req) => String(req.get('x-ov-fresh') || '') === '1',
            log: appLog,
        });
        // The owner's test route is mounted in front of the store's dispatcher: openvibe-shared 4.125.0 gave
        // adminRoutes a test route of its own, and the dispatcher answers it first (it wants an acting subject,
        // this one the service-token capability). 2026-11-07, the openvibe-shared v4.126.0 pin round.
        app.post(`${BASE_PATH}/:namespace/test/:key`, guard, async (req, res) => {
            if (![NAMESPACE, DNSSEC_NAMESPACE].includes(req.params.namespace)) return res.status(404).json({ error: 'no such configuration namespace' });
            let key = String(req.params.key || '');
            try { key = decodeURIComponent(key); } catch { /* keep it as it is */ }
            const schema = req.params.namespace === DNSSEC_NAMESPACE ? DNSSEC_SCHEMA : SCHEMA;
            if (!schema.properties[key]) return res.status(404).json({ error: 'no such setting' });
            try {
                const out = await test(req.params.namespace, key);
                // The Setup tab reads `message` (openvibe-shared's own test hook answers { ok, message }); `detail`
                // stays for anything that wants the same line under its other name.
                const message = String(out.detail || '').replace(/\s+/g, ' ').slice(0, 300);
                return res.status(200).json({ ok: Boolean(out.ok), message, detail: message });
            } catch (err) {
                appLog.warn(`[config] ${req.params.namespace}: the test for ${key} failed: ${String((err && err.message) || err).slice(0, 160)}`);
                return res.status(200).json({ ok: false, detail: 'failed — the test did not finish. The service log has the reason.' });
            }
        });
        app.use(routes.handle);
        return routes;
    }

    return {
        namespace: NAMESPACE, dnssecNamespace: DNSSEC_NAMESPACE, schema: SCHEMA, dnssecSchema: DNSSEC_SCHEMA,
        dnssecStore: () => dnssecStore,
        ready, value: valueOf, get: values, registrarKeys, allRegistrarKeys, test, testRegistrar, testDnssec, mount,
    };
}

function activate(settings) { ACTIVE.settings = settings; return settings; }
function registrarKeys() {
    if (ACTIVE.settings) return ACTIVE.settings.registrarKeys();
    return {
        cloudflare: { apiToken: process.env.CLOUDFLARE_API_TOKEN || '' },
        porkbun: { apiKey: process.env.PORKBUN_API_KEY || '', secretApiKey: process.env.PORKBUN_SECRET_API_KEY || '' },
    };
}

module.exports = {
    SERVICE, NAMESPACE, DNSSEC_NAMESPACE, SCHEMA, DNSSEC_SCHEMA, SECRETS,
    createSettings, activate, registrarKeys,
};
