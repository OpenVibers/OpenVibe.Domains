'use strict';

/**
 * Owner settings (D11) for OpenVibe.Domains: the registrar keys in `domains.registrars`.
 *
 * The registrars Domains works with are Cloudflare and Porkbun (server/panel/panel.js). A person's
 * own connection token is still read from their Network vault for that person's zones; these owner
 * keys are the service-wide fallback, read through registrarKeys() at the moment a registrar call is
 * made. The admin panel's value wins over CLOUDFLARE_API_TOKEN / PORKBUN_API_KEY /
 * PORKBUN_SECRET_API_KEY. Secrets are sealed by the shared store under OV_CONFIG_KEKS and are
 * write-only through /internal/config/domains.registrars/secrets/:key; summaries, history and logs
 * carry markers. Network's admin proxy reaches this namespace with `domains.config.manage`, acting
 * for the owner (X-OV-Subject); a secret change needs X-OV-Fresh: 1. The test route makes one cheap
 * authenticated read per registrar and answers ok or failed in one line, never echoing a key.
 */
const { createConfigStore, adminRoutes } = require('openvibe-shared/config');

const SERVICE = 'domains';
const NAMESPACE = 'domains.registrars';
const BASE_PATH = '/internal/config';
const GROUP = 'Domains';

const SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Domain registrars',
    description: 'The registrar accounts Domains reads prices and changes DNS with. A registrar with no key is skipped; people can still connect their own account.',
    type: 'object',
    additionalProperties: false,
    properties: {
        cloudflare_api_token: {
            type: 'string', title: 'Cloudflare API token', 'x-group': GROUP,
            description: 'A Cloudflare API token that may list and edit the zones Domains manages. It lets the service read zones for people who connected Cloudflare; without it only a person\'s own connection works.',
            'x-owner-input': {
                group: 'domains',
                unlocks: 'Cloudflare zones and DNS records can be read and changed with the service-wide account.',
                get_it_at: 'https://dash.cloudflare.com/profile/api-tokens',
                get_it_how: 'Create a token with Zone:Read and DNS:Edit, then paste it here.',
                test: true,
            },
            'x-required-for': 'Cloudflare domains',
        },
        porkbun_api_key: {
            type: 'string', title: 'Porkbun API key', 'x-group': GROUP,
            description: 'The Porkbun API key from your account\'s API page. Together with its secret it lets Domains read and change Porkbun DNS; the key alone does nothing.',
            'x-owner-input': {
                group: 'domains',
                unlocks: 'Porkbun domains and DNS records can be read and changed with the service-wide account.',
                get_it_at: 'https://porkbun.com/account/api',
                get_it_how: 'Enable the API, create a key pair, and paste the API key and its secret key here.',
                test: true,
            },
            'x-required-for': 'Porkbun domains',
        },
        porkbun_secret_api_key: {
            type: 'string', title: 'Porkbun secret API key', 'x-group': GROUP,
            description: 'The secret half of the Porkbun API key pair. It is locked when saved and never shown again; make a new pair at Porkbun if it is lost.',
            'x-owner-input': {
                group: 'domains',
                unlocks: 'Porkbun accepts Domains\' requests: the secret signs every call.',
                get_it_at: 'https://porkbun.com/account/api',
                get_it_how: 'It is shown next to the API key when the pair is made. Copy it then; Porkbun cannot show it again.',
                test: true,
            },
            'x-required-for': 'Porkbun domains',
        },
    },
});

const SECRETS = new Set(['cloudflare_api_token', 'porkbun_api_key', 'porkbun_secret_api_key']);
const ACTIVE = { settings: null };

function createSettings({ db, env = process.env, log = console, fetchImpl = globalThis.fetch, probes = null } = {}) {
    let store = null;
    const ready = createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA,
        classify: (key) => (SECRETS.has(key) ? 'secret' : 'internal'),
        env, log,
    }).then((s) => { store = s; return s; });

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

    async function probeCloudflare(apiToken) {
        const r = await fetchImpl('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { accept: 'application/json', authorization: `Bearer ${apiToken}` } });
        let body = {};
        try { body = await r.json(); } catch { /* not JSON */ }
        if (!r.ok || !body.success) throw new Error((body.errors && body.errors[0] && body.errors[0].message) || `HTTP ${r.status}`);
    }

    async function probePorkbun(apiKey, secretApiKey) {
        const r = await fetchImpl('https://api.porkbun.com/api/json/v3/ping', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apikey: apiKey, secretapikey: secretApiKey }),
        });
        let body = {};
        try { body = await r.json(); } catch { /* not JSON */ }
        if (!r.ok || body.status !== 'SUCCESS') throw new Error(body && body.message ? body.message : `HTTP ${r.status}`);
    }

    async function test(key) {
        if (!['cloudflare_api_token', 'porkbun_api_key', 'porkbun_secret_api_key'].includes(key)) return { ok: false, detail: 'That setting has no test.' };
        const keys = registrarKeys();
        if (key === 'cloudflare_api_token') {
            if (!keys.cloudflare.apiToken) return { ok: false, detail: 'Cloudflare is not configured: paste the API token first.' };
            const probe = probes && probes.cloudflare ? probes.cloudflare : ({ apiToken }) => probeCloudflare(apiToken);
            try {
                await probe({ apiToken: keys.cloudflare.apiToken });
                return { ok: true, detail: 'ok — Cloudflare verified the token.' };
            } catch (err) {
                const words = String((err && err.message) || 'the request failed').split(/\s+/).join(' ').slice(0, 160);
                return { ok: false, detail: `failed — Cloudflare said: ${words.split(keys.cloudflare.apiToken).join('[redacted]')}` };
            }
        }
        const { apiKey, secretApiKey } = keys.porkbun;
        if (!apiKey || !secretApiKey) return { ok: false, detail: 'Porkbun is not configured: both the API key and its secret key are needed.' };
        const probe = probes && probes.porkbun ? probes.porkbun : ({ apiKey: a, secretApiKey: s }) => probePorkbun(a, s);
        try {
            await probe({ apiKey, secretApiKey });
            return { ok: true, detail: 'ok — Porkbun answered the ping with this key pair.' };
        } catch (err) {
            let words = String((err && err.message) || 'the request failed');
            for (const secret of [apiKey, secretApiKey]) words = words.split(secret).join('[redacted]');
            return { ok: false, detail: `failed — Porkbun said: ${words.split(/\s+/).join(' ').slice(0, 160)}` };
        }
    }

    function mount(app, { guard, log: appLog = log } = {}) {
        if (!store) throw new Error('createSettings: await ready before mount()');
        const routes = adminRoutes([store], {
            basePath: BASE_PATH,
            requireAdmin: guard,
            actor: (req) => {
                const id = String(req.get('x-ov-subject') || '').trim();
                return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? { type: 'user', id } : null;
            },
            requireFresh: (req) => String(req.get('x-ov-fresh') || '') === '1',
            log: appLog,
        });
        app.use(routes.handle);
        app.post(`${BASE_PATH}/:namespace/test/:key`, guard, async (req, res) => {
            if (req.params.namespace !== NAMESPACE) return res.status(404).json({ error: 'no such configuration namespace' });
            let key = String(req.params.key || '');
            try { key = decodeURIComponent(key); } catch { /* keep it as it is */ }
            if (!SCHEMA.properties[key]) return res.status(404).json({ error: 'no such setting' });
            try {
                const out = await test(key);
                return res.status(200).json({ ok: Boolean(out.ok), detail: String(out.detail).replace(/\s+/g, ' ').slice(0, 200) });
            } catch (err) {
                appLog.warn(`[config] ${NAMESPACE}: the test for ${key} failed: ${String((err && err.message) || err).slice(0, 160)}`);
                return res.status(200).json({ ok: false, detail: 'failed — the test did not finish. The service log has the reason.' });
            }
        });
        return routes;
    }

    return { namespace: NAMESPACE, schema: SCHEMA, ready, value: valueOf, get: values, registrarKeys, test, mount };
}

function activate(settings) { ACTIVE.settings = settings; return settings; }
function registrarKeys() {
    if (ACTIVE.settings) return ACTIVE.settings.registrarKeys();
    return {
        cloudflare: { apiToken: process.env.CLOUDFLARE_API_TOKEN || '' },
        porkbun: { apiKey: process.env.PORKBUN_API_KEY || '', secretApiKey: process.env.PORKBUN_SECRET_API_KEY || '' },
    };
}

module.exports = { SERVICE, NAMESPACE, SCHEMA, SECRETS, createSettings, activate, registrarKeys };
