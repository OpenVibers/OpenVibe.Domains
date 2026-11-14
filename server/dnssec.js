'use strict';

/**
 * The DS record a domain needs at its registrar (plan §AB.19: "DNSSEC as a guided sub-step with the records shown to
 * copy"). The record is not made up: it is the DNSKEY the domain publishes, hashed the way DNSSEC says
 * (RFC 4034 §5.1.4 and RFC 4509).
 *
 *   DS = key tag (RFC 4034 app B) + algorithm + digest type 2 (SHA-256) + SHA-256 of the owner name and the key
 *
 * The DNSKEY is read from the public DNS (DNS over HTTPS, Cloudflare's resolver), so no account is needed and no
 * key is read to learn it. The same value is what the DNS host shows the owner to paste at the registrar.
 */
const crypto = require('crypto');

/** The name in the wire form DNSSEC hashes: lowercase labels, each with its length, then the zero byte. */
function canonicalName(name) {
    const out = [];
    const clean = String(name || '').trim().toLowerCase().replace(/\.$/, '');
    if (clean) {
        for (const label of clean.split('.')) {
            const bytes = Buffer.from(label, 'utf8');
            out.push(Buffer.from([bytes.length]), bytes);
        }
    }
    out.push(Buffer.from([0]));
    return Buffer.concat(out);
}

/**
 * The key tag of a DNSKEY (RFC 4034, appendix B.1): the sum of the 16-bit words of the key material. RSAMD5 (the
 * old algorithm 1) is the exception: its tag is the sum over the first three octets of the public key.
 */
function keyTag(rdata, algorithm) {
    const key = algorithm === 1 ? rdata.subarray(5, 8) : rdata;
    let sum = 0;
    for (let i = 0; i < key.length; i += 2) {
        sum += (key[i] << 8) + (i + 1 < key.length ? key[i + 1] : 0);
    }
    sum += (sum >> 16) & 0xffff;
    return sum & 0xffff;
}

/** A DNSKEY in the presentation form "flags protocol algorithm base64key" → its fields. */
function parseDnskey(text) {
    const parts = String(text || '').trim().split(/\s+/);
    if (parts.length < 4) return null;
    const flags = Number(parts[0]);
    const protocol = Number(parts[1]);
    const algorithm = Number(parts[2]);
    if (!Number.isInteger(flags) || !Number.isInteger(protocol) || !Number.isInteger(algorithm)) return null;
    let publicKey;
    try { publicKey = Buffer.from(parts.slice(3).join(''), 'base64'); } catch { return null; }
    if (!publicKey.length) return null;
    const head = Buffer.from([(flags >> 8) & 0xff, flags & 0xff, protocol & 0xff, algorithm & 0xff]);
    return { flags, protocol, algorithm, publicKey, rdata: Buffer.concat([head, publicKey]) };
}

/** The DS record of one DNSKEY: "key tag algorithm digest type digest", the way a registrar wants it. */
function dsRecord(owner, dnskey) {
    const digest = crypto.createHash('sha256').update(Buffer.concat([canonicalName(owner), dnskey.rdata])).digest('hex').toUpperCase();
    return {
        key_tag: keyTag(dnskey.rdata, dnskey.algorithm),
        algorithm: dnskey.algorithm,
        digest_type: 2,
        digest,
        content: `${keyTag(dnskey.rdata, dnskey.algorithm)} ${dnskey.algorithm} 2 ${digest}`,
    };
}

/** The DS records of a domain, one per DNSKEY the zone publishes. */
function dsRecordsFor(owner, dnskeys) {
    return dnskeys.map((k) => dsRecord(owner, k));
}

/**
 * The DNSKEYs of a domain, read over DNS over HTTPS (Cloudflare's resolver answers JSON). One read, no account.
 */
async function dnskeysOf(domain, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    const name = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
    if (!name) return [];
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=DNSKEY`;
    let res;
    try {
        res = await fetchImpl(url, { headers: { accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new Error(timedOut ? 'The DNS lookup did not answer in time.' : 'The DNS lookup could not be reached.');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) throw new Error(`The DNS lookup answered ${res.status}.`);
    const answers = Array.isArray(body.Answer) ? body.Answer : [];
    const keys = answers
        .filter((a) => a && Number(a.type) === 48)
        .map((a) => parseDnskey(a.data))
        .filter(Boolean);
    if (!keys.length) throw new Error(`${name} publishes no DNSKEY, so it has no DS record yet. Turn on DNSSEC at the host that holds its DNS first.`);
    return keys;
}

module.exports = { canonicalName, keyTag, parseDnskey, dsRecord, dsRecordsFor, dnskeysOf };
