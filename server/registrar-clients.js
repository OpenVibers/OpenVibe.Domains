'use strict';

/**
 * One client per registrar (plan §AB.19): each one can list the domains the account holds, and that list is the test
 * of the row. A read is cheap, changes nothing and costs no money.
 *
 * Every client answers with the same shape: a list of domain names. A failure is an Error whose words say what the
 * registrar said; the caller redacts the key before the words reach the owner or a log.
 *
 *   cloudflare   GET  /client/v4/zones                Bearer <token>
 *   porkbun      POST /domain/listAll                 apikey + secretapikey in the body
 *   namecheap    GET  /xml.response?command=namecheap.domains.getList     ApiUser + ApiKey in the query
 *   gandi        GET  /v5/domain/domains              Bearer <personal access token>
 *   dynadot      GET  /restful/v2/domains/list        Bearer <api key> + an X-Signature the secret makes
 *   spaceship    GET  /api/v1/domains                 X-Api-Key + X-Api-Secret headers
 *
 * The answers are read the way each registrar answers (JSON for most, XML for Namecheap and Dynadot). A registrar
 * that answers in a shape we do not know gives an error that says so, never a wrong list.
 */
const crypto = require('crypto');

const TIMEOUT_MS = 10_000;
const MAX_PAGES = 5;

/** An error the owner can act on, with the words the registrar used. */
class RegistrarError extends Error {
    constructor(message, code = 'registrar.refused') {
        super(message);
        this.code = code;
    }
}

/** The names in a JSON answer, whatever shape the registrar used. */
function namesFromJson(data) {
    const list = Array.isArray(data) ? data
        : Array.isArray(data && data.domains) ? data.domains
            : Array.isArray(data && data.items) ? data.items
                : Array.isArray(data && data.result) ? data.result
                    : Array.isArray(data && data.data) ? data.data : null;
    if (!list) return null;
    return list.map((d) => {
        if (typeof d === 'string') return d.trim().toLowerCase();
        if (!d || typeof d !== 'object') return '';
        const name = d.domain || d.name || d.domain_name || (d.domain && d.domain.name) || '';
        return String(name || '').trim().toLowerCase();
    }).filter(Boolean);
}

/**
 * The names in an XML answer. Two shapes are in use: the name is the element's own text (Namecheap's <Domain>),
 * or it sits in a <name> inside the element (Dynadot's <domain><name>). Both are read here.
 */
function namesFromXml(text) {
    const out = [];
    const direct = /<(?:Domain|domainname)>([^<]+)<\/(?:Domain|domainname)>/g;
    let m = direct.exec(text);
    while (m) { out.push(m[1].trim().toLowerCase()); m = direct.exec(text); }
    // A <domain> block carries its name in a <name> element (Dynadot).
    const blocks = /<domain>([\s\S]*?)<\/domain>/g;
    let b = blocks.exec(text);
    while (b) {
        const name = /<name>([^<]+)<\/name>/.exec(b[1]);
        if (name) out.push(name[1].trim().toLowerCase());
        b = blocks.exec(text);
    }
    return out;
}

/** The first error message in an XML answer, if the registrar refused. */
function errorFromXml(text) {
    const m = /<(?:Error1|Error)>([^<]+)<\/(?:Error1|Error)>/.exec(text);
    return m ? m[1].trim() : null;
}

/** A fetch with a timeout that never throws a raw network error at the owner. */
async function get(fetchImpl, url, options = {}) {
    let res;
    try {
        res = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new RegistrarError(timedOut ? 'The registrar did not answer in time.' : 'The registrar could not be reached.', 'registrar.unreachable');
    }
    return res;
}

/** Cloudflare: the zones of the account, as the domain names. */
async function listCloudflare(creds, { fetchImpl }) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await get(fetchImpl, `https://api.cloudflare.com/client/v4/zones?per_page=50&page=${page}`, {
            headers: { authorization: `Bearer ${creds.apiToken}`, accept: 'application/json' },
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || body.success === false) {
            const first = body && Array.isArray(body.errors) && body.errors[0];
            throw new RegistrarError(first && first.message ? String(first.message).slice(0, 200) : `Cloudflare answered ${res.status}.`);
        }
        const list = Array.isArray(body.result) ? body.result : [];
        out.push(...list.map((z) => String(z && z.name ? z.name : '').trim().toLowerCase()).filter(Boolean));
        const info = body.result_info || {};
        if (!list.length || !info.total_pages || page >= info.total_pages) break;
    }
    return out;
}

/** Porkbun: every domain in the account. */
async function listPorkbun(creds, { fetchImpl }) {
    const res = await get(fetchImpl, 'https://api.porkbun.com/api/json/v3/domain/listAll', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ apikey: creds.apiKey, secretapikey: creds.secretApiKey }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || String(body.status || '').toUpperCase() === 'ERROR') {
        throw new RegistrarError(body && body.message ? String(body.message).slice(0, 200) : `Porkbun answered ${res.status}.`);
    }
    const list = Array.isArray(body.domains) ? body.domains : [];
    return list.map((d) => String(d && d.domain ? d.domain : '').trim().toLowerCase()).filter(Boolean);
}

/** Namecheap: the domains of the account, from the XML API. */
async function listNamecheap(creds, { fetchImpl, clientIp }) {
    const query = new URLSearchParams({
        ApiUser: creds.apiUser, ApiKey: creds.apiKey, UserName: creds.apiUser, Command: 'namecheap.domains.getList',
    });
    // Namecheap asks which address is calling; the account only allows the addresses on its list.
    if (clientIp) query.set('ClientIp', String(clientIp));
    const res = await get(fetchImpl, `https://api.namecheap.com/xml.response?${query.toString()}`, { headers: { accept: 'application/xml' } });
    const text = await res.text();
    if (!res.ok) throw new RegistrarError(`Namecheap answered ${res.status}.`);
    if (/<Status>ERROR<\/Status>/.test(text)) {
        const why = errorFromXml(text) || 'Namecheap refused the request.';
        throw new RegistrarError(why.slice(0, 200));
    }
    const names = namesFromXml(text);
    if (!names) throw new RegistrarError('Namecheap answered in a shape we cannot read.');
    return names;
}

/** Gandi: the domains of the organisation the token belongs to. */
async function listGandi(creds, { fetchImpl }) {
    const res = await get(fetchImpl, 'https://api.gandi.net/v5/domain/domains', {
        headers: { authorization: `Bearer ${creds.apiToken}`, accept: 'application/json' },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        const why = body && Array.isArray(body.errors) && body.errors[0] ? body.errors[0].message : null;
        throw new RegistrarError(String(why || `Gandi answered ${res.status}.`).slice(0, 200));
    }
    const names = namesFromJson(body);
    if (!names) throw new RegistrarError('Gandi answered in a shape we cannot read.');
    return names;
}

/** Dynadot: the domains of the account, from the REST API the secret signs. */
async function listDynadot(creds, { fetchImpl }) {
    const path = '/restful/v2/domains/list';
    // The secret signs the request: base64 HMAC-SHA256 over "<apiKey>\n<pathAndQuery>\n\"\"\n<body>".
    const signature = crypto.createHmac('sha256', String(creds.apiSecret || ''))
        .update(`${creds.apiKey}\n${path}\n""\n`, 'utf8').digest('base64');
    const res = await get(fetchImpl, `https://api.dynadot.com${path}`, {
        headers: { authorization: `Bearer ${creds.apiKey}`, 'x-signature': signature, accept: 'application/xml' },
    });
    const text = await res.text();
    if (!res.ok) throw new RegistrarError(`Dynadot answered ${res.status}.`);
    if (/<status>error<\/status>/i.test(text)) {
        const why = errorFromXml(text) || 'Dynadot refused the request.';
        throw new RegistrarError(why.slice(0, 200));
    }
    const names = namesFromXml(text);
    if (!names) throw new RegistrarError('Dynadot answered in a shape we cannot read.');
    return names;
}

/** Spaceship: the domains of the account. */
async function listSpaceship(creds, { fetchImpl }) {
    const res = await get(fetchImpl, 'https://spaceship.dev/api/v1/domains', {
        headers: { 'x-api-key': String(creds.apiKey || ''), 'x-api-secret': String(creds.apiSecret || ''), accept: 'application/json' },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        const why = body && (body.message || body.error || (body.errors && body.errors[0] && body.errors[0].message));
        throw new RegistrarError(String(why || `Spaceship answered ${res.status}.`).slice(0, 200));
    }
    const names = namesFromJson(body);
    if (!names) throw new RegistrarError('Spaceship answered in a shape we cannot read.');
    return names;
}

/** The list function of each registrar, by id. */
const LISTS = {
    cloudflare: listCloudflare,
    porkbun: listPorkbun,
    namecheap: listNamecheap,
    gandi: listGandi,
    dynadot: listDynadot,
    spaceship: listSpaceship,
};

module.exports = { RegistrarError, LISTS, namesFromJson, namesFromXml, errorFromXml };
