'use strict';

/**
 * The control panel (plan 2026-10-28 §5.1, DOM-2): a person's connections, the zones they hold, and every DNS change
 * as a proposal (domains.proposal@1) that nothing applies until its person approves it.
 *
 *   connect / remove / sync      a provider account: verified, its token stored in the person's Network project
 *                                (vault.js), its zones cached in domains_zones; a refused token marks it broken
 *   records                      a zone's records, read live from the provider (the provider stays the truth)
 *   propose                      a checked diff (create, update, delete) with why, the risk in words, 7 days to decide;
 *                                a registrar change is an NS list update or a DS create/delete (same proposal, same
 *                                approval, same rollback)
 *   decide                       approve → applied in order; a record or nameserver set that moved since the proposal
 *                                is refused as stale; a failure part-way keeps the rollback of what was applied
 *   rollBack                     the inverse of what was applied, newest first
 *
 * Every step is in domains_audit. The provider token is revealed for one call and dropped; it is never stored, logged
 * or returned. Errors are PanelError(status, code, words a person can act on).
 */
const net = require('net');
const { normalize } = require('./cloudflare');

const PROVIDERS = ['cloudflare', 'porkbun'];
const TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'CAA', 'SRV'];
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME']);
const MAX_CHANGES = 50;
const MAX_NAMESERVERS = 8;
const DECIDE_DAYS = 7;
const PUBLIC_ORIGIN = 'https://openvibe.domains';
const HOST_RE = /^(?=.{1,253}$)(\*\.)?([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i;

class PanelError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
const fail = (status, code, message) => { throw new PanelError(status, code, message); };

const lowerName = (n) => String(n || '').trim().toLowerCase().replace(/\.$/, '');
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const iso = (v) => (v == null ? null : new Date(v).toISOString());

/** Is `name` the zone or inside it? */
function inZone(name, zone) {
    const n = lowerName(name);
    const z = lowerName(zone);
    return n === z || n.endsWith(`.${z}`);
}

/** A record as the person asked for it: checked, normalized, or a PanelError naming what is wrong. */
function cleanRecord(rec, zone, where) {
    if (!rec || typeof rec !== 'object') fail(422, 'proposal.invalid', `${where}: the record is missing.`);
    const type = String(rec.type || '').toUpperCase();
    if (!TYPES.includes(type)) fail(422, 'proposal.invalid', `${where}: ${type || 'that'} records cannot be changed here (${TYPES.join(', ')}).`);
    let name = lowerName(rec.name);
    if (name === '@' || name === '') name = lowerName(zone);
    else if (!inZone(name, zone)) name = `${name}.${lowerName(zone)}`;
    if (!HOST_RE.test(name) || !inZone(name, zone)) fail(422, 'proposal.invalid', `${where}: ${name} is not a name in ${zone}.`);
    const content = String(rec.content == null ? '' : rec.content).trim();
    if (!content || content.length > 2048) fail(422, 'proposal.invalid', `${where}: the value is empty or too long.`);
    if (type === 'A' && net.isIPv4(content) === false) fail(422, 'proposal.invalid', `${where}: an A record holds an IPv4 address (like 192.0.2.10).`);
    if (type === 'AAAA' && net.isIPv6(content) === false) fail(422, 'proposal.invalid', `${where}: an AAAA record holds an IPv6 address.`);
    if (['CNAME', 'NS', 'MX'].includes(type) && !HOST_RE.test(content)) fail(422, 'proposal.invalid', `${where}: a ${type} record points at a host name.`);
    let ttl = rec.ttl == null || rec.ttl === '' ? 1 : Number(rec.ttl);
    if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) fail(422, 'proposal.invalid', `${where}: TTL is automatic (1) or 60 to 86 400 seconds.`);
    const priority = type === 'MX' || type === 'SRV' ? Number(rec.priority == null || rec.priority === '' ? 10 : rec.priority) : null;
    if (priority !== null && (!Number.isInteger(priority) || priority < 0 || priority > 65535)) fail(422, 'proposal.invalid', `${where}: priority is 0 to 65 535.`);
    const comment = typeof rec.comment === 'string' && rec.comment.trim() ? rec.comment.trim().slice(0, 100) : null;
    return { type, name, content, ttl, proxied: PROXIABLE.has(type) ? Boolean(rec.proxied === true || rec.proxied === 'true' || rec.proxied === 'on') : null, priority, comment };
}

/** Do two records say the same thing (ids aside)? Used to refuse a stale change. */
function sameRecord(a, b) {
    if (!a || !b) return false;
    return a.type === b.type && lowerName(a.name) === lowerName(b.name) && String(a.content) === String(b.content)
        && Number(a.ttl) === Number(b.ttl) && (a.proxied ?? null) === (b.proxied ?? null) && (a.priority ?? null) === (b.priority ?? null);
}

/** Two nameserver lists say the same thing (Porkbun's registry may return a different order). */
function sameNameservers(a, b) {
    const x = Array.isArray(a) ? a.map(lowerName).filter(Boolean).sort() : [];
    const y = Array.isArray(b) ? b.map(lowerName).filter(Boolean).sort() : [];
    return x.length === y.length && x.every((n, i) => n === y[i]);
}

/** A registrar change: the domain's nameservers, whose before and after are the lists. */
function isNameserverChange(c) {
    return Boolean(c) && (String(c.type || '').toUpperCase() === 'NS' || Array.isArray(c.after) || Array.isArray(c.before) || Array.isArray(c.nameservers));
}

/** A DS change is a record-shaped DS, applied at the registrar rather than in the DNS zone. */
function isDsChange(c) {
    if (!c) return false;
    if (String(c.type || '').toUpperCase() === 'DS') return true;
    const r = c.after || c.before;
    if (!r || Array.isArray(r)) return false;
    return String(r.type || '').toUpperCase() === 'DS' || r.keyTag != null || r.key_tag != null || r.keytag != null;
}

function sameDs(a, b) {
    if (sameRecord(a, b)) return true;
    return Boolean(a && b && a.type === 'DS' && b.type === 'DS' && lowerName(a.name) === lowerName(b.name)
        && String(a.content).toLowerCase() === String(b.content).toLowerCase());
}

/** The nameservers a person asked for, checked and de-duplicated. */
function cleanNameservers(list, where) {
    const wanted = Array.isArray(list) ? list : (list && Array.isArray(list.ns) ? list.ns : (list && Array.isArray(list.nameservers) ? list.nameservers : null));
    if (!wanted || !wanted.length) fail(422, 'proposal.invalid', `${where}: the new name servers are missing.`);
    const out = [];
    for (const raw of wanted) {
        const ns = lowerName(raw);
        if (!ns || !HOST_RE.test(ns)) fail(422, 'proposal.invalid', `${where}: ${ns || 'that'} is not a name server host name.`);
        if (!out.includes(ns)) out.push(ns);
    }
    if (out.length > MAX_NAMESERVERS) fail(422, 'proposal.invalid', `${where}: at most ${MAX_NAMESERVERS} name servers.`);
    return out;
}

/** A DS record's four registry fields, as domains.proposal@1's record shape. */
function cleanDs(rec, zone, where) {
    if (!rec || typeof rec !== 'object') fail(422, 'proposal.invalid', `${where}: the DS record is missing.`);
    const parts = typeof rec.content === 'string' ? rec.content.trim().split(/\s+/).filter(Boolean) : [];
    const keyTag = String(rec.keyTag ?? rec.key_tag ?? rec.keytag ?? parts[0] ?? '').trim();
    const alg = String(rec.alg ?? rec.algorithm ?? parts[1] ?? '').trim();
    const digestType = String(rec.digestType ?? rec.digest_type ?? rec.digesttype ?? parts[2] ?? '').trim();
    const digest = String(rec.digest ?? parts.slice(3).join('') ?? '').trim();
    if (!/^\d{1,5}$/.test(keyTag) || Number(keyTag) > 65535) fail(422, 'proposal.invalid', `${where}: a DS key tag is 0 to 65 535.`);
    if (!/^\d{1,3}$/.test(alg) || Number(alg) > 255) fail(422, 'proposal.invalid', `${where}: a DS algorithm is 0 to 255.`);
    if (!/^\d{1,3}$/.test(digestType) || Number(digestType) > 255) fail(422, 'proposal.invalid', `${where}: a DS digest type is 0 to 255.`);
    if (!/^[0-9a-f]{4,128}$/i.test(digest)) fail(422, 'proposal.invalid', `${where}: the DS digest is hex, 4 to 128 characters.`);
    let name = lowerName(rec.name);
    if (!name || name === '@') name = lowerName(zone);
    else if (!inZone(name, zone)) name = `${name}.${lowerName(zone)}`;
    if (!inZone(name, zone)) fail(422, 'proposal.invalid', `${where}: ${name} is not a name in ${zone}.`);
    return { type: 'DS', name, content: `${keyTag} ${alg} ${digestType} ${digest}`, ttl: 1, proxied: null, priority: null, comment: null };
}

/** The key tag of a DS record, from its id or the first field of its content. */
function dsKey(record) {
    if (!record) return null;
    if (record.id != null && record.id !== '') return String(record.id);
    const first = String(record.content || '').trim().split(/\s+/)[0];
    return first || null;
}

/** One change in plain words: "Add TXT example.com", "Change A www.example.com: 192.0.2.1 → 192.0.2.7". */
function describe(c) {
    if (isNameserverChange(c)) {
        const list = (v) => (Array.isArray(v) ? v.join(', ') : '?');
        return `Change name servers: ${list(c.before)} → ${list(c.after)}`;
    }
    const r = c.after || c.before || {};
    if (isDsChange(c) || r.type === 'DS') {
        if (c.op === 'delete') return `Remove DS ${r.name} (${r.content})`;
        if (c.op === 'update') return `Change DS ${r.name}: ${c.before ? c.before.content : '?'} → ${c.after ? c.after.content : '?'}`;
        return `Add DS ${r.name} (${r.content})`;
    }
    if (c.op === 'create') return `Add ${r.type} ${r.name} → ${r.content}`;
    if (c.op === 'delete') return `Remove ${r.type} ${r.name} (${r.content})`;
    return `Change ${r.type} ${r.name}: ${c.before ? c.before.content : '?'} → ${c.after ? c.after.content : '?'}`;
}

/** What could break, in words, when the asker did not say. */
function riskOf(changes) {
    const words = new Set();
    for (const c of changes) {
        const r = c.after || c.before || {};
        if (isNameserverChange(c)) words.add('Name servers decide which DNS host answers for the domain: a wrong list makes the domain stop resolving.');
        else if (isDsChange(c) || r.type === 'DS') words.add('A DS record tells validating resolvers which DNSKEY to trust: if it does not match the DNS host\'s DNSKEY, validating resolvers refuse the domain.');
        else if (r.type === 'TXT' || r.type === 'CAA') words.add(c.op === 'delete' && r.type === 'CAA' ? 'Removing a CAA record lets any certificate authority issue for the name.' : 'Low: a TXT record changes no traffic, though a service that checks it (mail, verification) reads the new value.');
        else if (r.type === 'MX') words.add('Mail for the domain goes where the MX records say; a mistake here bounces or loses mail.');
        else if (r.type === 'NS') words.add('NS records delegate the name: a wrong one makes it unreachable.');
        else words.add(c.op === 'delete' ? `${r.name} stops answering at ${r.content}: visitors and services using it lose it.` : `Visitors to ${r.name} reach the new address once caches expire (the record's TTL).`);
    }
    return [...words].join(' ').slice(0, 1000);
}

function toPublic(row) {
    return {
        id: row.id, domain: row.domain, provider: row.provider || 'cloudflare', connection_id: row.connection_id,
        title: row.title, why: row.why || null, risk: row.risk || null, status: row.status,
        changes: parse(row.changes).map((c) => ({ ...(c.type ? { type: c.type } : {}), op: c.op, record_id: c.record_id || null, before: c.before || null, after: c.after || null })),
        created_by: row.created_by, created_at: iso(row.created_at), decided_at: iso(row.decided_at), applied_at: iso(row.applied_at),
        rolled_back_at: iso(row.rolled_back_at), expires_at: iso(row.expires_at), error: row.error || null,
        href: `${PUBLIC_ORIGIN}/panel/p/${row.id}`,
    };
}

const BUCKET = { pending: 'waiting', applying: 'running', applied: 'done', rolled_back: 'done', declined: 'done', failed: 'failed', expired: 'failed' };

/** common.action-item@1 for the Action Center. */
function toActionItem(row) {
    const changes = parse(row.changes);
    const summary = changes.length === 1 ? describe(changes[0]) : `${changes.length} changes to ${row.domain}: ${describe(changes[0])}…`;
    return {
        service: 'domains', id: row.id, kind: 'approval', title: String(row.title).slice(0, 160), summary: summary.slice(0, 400),
        bucket: BUCKET[row.status] || 'failed', state: row.status, agent: String(row.created_by).startsWith('agent:') ? String(row.created_by).slice(6, 86) : null,
        cost_usd: null, steps: changes.length, error: row.error ? String(row.error).slice(0, 400) : null,
        created_at: iso(row.created_at), updated_at: iso(row.rolled_back_at || row.applied_at || row.decided_at || row.created_at),
        next_run_at: null, href: `${PUBLIC_ORIGIN}/panel/p/${row.id}`,
        actions: row.status === 'pending' ? ['approve', 'decline', 'open'] : ['open'],
    };
}

function createPanel({ store, vault, providers, log = console }) {
    const db = store.db;
    const providerOf = (name) => providers[name] || fail(422, 'connection.provider', `${name} is not connected here yet.`);

    async function audit(subject, action, { connectionId = null, proposalId = null, detail = {} } = {}) {
        await db.exec('INSERT INTO domains_audit (subject, action, connection_id, proposal_id, detail, at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)',
            [subject, action, connectionId, proposalId, JSON.stringify(detail), store.iso()]);
    }

    async function connection(subject, id) {
        const row = await db.maybe("SELECT * FROM domains_connections WHERE id = $1 AND subject = $2 AND status <> 'removed'", [id, subject]);
        return row || fail(404, 'connection.not_found', 'No such connection of yours.');
    }

    /** Reveal the connection's token for one call; a refused reveal marks the connection broken. */
    async function withToken(conn, fn) {
        const p = providerOf(conn.provider);
        let token;
        try {
            token = await vault.reveal(conn.project_id, conn.secret_name, p.ORIGIN);
        } catch (err) {
            if (err.code === 'vault.secret_missing') await markBroken(conn, err.message);
            throw new PanelError(err.status || 503, err.code || 'vault.error', err.message);
        }
        try {
            return await fn(p, token);
        } catch (err) {
            if (err.code === 'provider.forbidden') await markBroken(conn, err.message);
            throw err.status ? new PanelError(err.status, err.code || 'provider.error', err.message) : err;
        } finally {
            token = null;
        }
    }

    async function markBroken(conn, words) {
        await db.exec("UPDATE domains_connections SET status = 'broken', last_error = $2, checked_at = $3::timestamptz WHERE id = $1", [conn.id, String(words).slice(0, 300), store.iso()]);
    }

    async function sync(subject, id) {
        const conn = await connection(subject, id);
        const zones = await withToken(conn, (p, token) => p.zones(token));
        await store.tx(async () => {
            await db.exec('DELETE FROM domains_zones WHERE connection_id = $1', [conn.id]);
            for (const z of zones) {
                await db.exec(`INSERT INTO domains_zones (connection_id, zone_id, name, status, name_servers, plan, synced_at)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)`, [conn.id, z.id, z.name, z.status, JSON.stringify(z.name_servers), z.plan, store.iso()]);
            }
            await db.exec("UPDATE domains_connections SET status = 'active', last_error = NULL, checked_at = $2::timestamptz WHERE id = $1", [conn.id, store.iso()]);
        });
        return zones;
    }

    async function connect(person, { provider, label, token }) {
        if (!PROVIDERS.includes(provider)) fail(422, 'connection.provider', 'Cloudflare and Porkbun are the providers you can connect today.');
        const providerName = provider === 'porkbun' ? 'Porkbun' : 'Cloudflare';
        const name = String(label || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || providerName;
        const secret = String(token || '').trim();
        if (provider === 'porkbun') {
            if (secret.length < 20 || secret.length > 800 || /\s/.test(secret)) fail(422, 'connection.token', 'Paste the API key and secret key exactly as Porkbun showed them.');
        } else if (secret.length < 20 || secret.length > 400 || /\s/.test(secret)) {
            fail(422, 'connection.token', 'Paste the API token exactly as Cloudflare showed it.');
        }
        const p = providerOf(provider);
        const verified = await p.verify(secret);
        if (!verified.ok) fail(422, 'connection.token', verified.reason || `${providerName} did not accept these keys.`);
        const count = await db.maybe("SELECT count(*)::int AS n FROM domains_connections WHERE subject = $1 AND status <> 'removed'", [person.subject]);
        if (count && count.n >= 20) fail(409, 'connection.limit', 'You can keep 20 connections. Remove one first.');
        const id = store.newId('dcn');
        const secretName = `${provider}-${id.slice(4).toLowerCase()}`;
        const projectId = await vault.projectFor(person.token);
        await vault.store(person.token, projectId, secretName, secret, p.ORIGIN);
        await db.exec(`INSERT INTO domains_connections (id, subject, provider, label, project_id, environment, secret_name, status, created_at, checked_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8::timestamptz, $8::timestamptz)`, [id, person.subject, provider, name, projectId, vault.ENVIRONMENT, secretName, store.iso()]);
        await audit(person.subject, 'connection.added', { connectionId: id, detail: { provider, label: name } });
        try { await sync(person.subject, id); } catch (err) { log.warn(`[OpenVibe.Domains] first sync of ${id} failed: ${err.code || ''}`); }
        return await connection(person.subject, id);
    }

    async function remove(person, id) {
        const conn = await connection(person.subject, id);
        await vault.remove(person.token, conn.project_id, conn.secret_name);
        await store.tx(async () => {
            await db.exec("UPDATE domains_connections SET status = 'removed', removed_at = $2::timestamptz WHERE id = $1", [conn.id, store.iso()]);
            await db.exec('DELETE FROM domains_zones WHERE connection_id = $1', [conn.id]);
            await db.exec("UPDATE domains_proposals SET status = 'expired', error = 'The connection was removed.' WHERE connection_id = $1 AND status = 'pending'", [conn.id]);
        });
        await audit(person.subject, 'connection.removed', { connectionId: conn.id, detail: { provider: conn.provider } });
    }

    async function connections(subject) {
        return await db.many(`SELECT c.*, (SELECT count(*)::int FROM domains_zones z WHERE z.connection_id = c.id) AS zone_count
            FROM domains_connections c WHERE c.subject = $1 AND c.status <> 'removed' ORDER BY c.created_at`, [subject]);
    }

    async function zones(subject) {
        return await db.many(`SELECT z.*, c.label, c.provider, c.status AS connection_status FROM domains_zones z
            JOIN domains_connections c ON c.id = z.connection_id WHERE c.subject = $1 AND c.status <> 'removed' ORDER BY z.name`, [subject]);
    }

    async function zone(subject, connectionId, zoneId) {
        const conn = await connection(subject, connectionId);
        const z = await db.maybe('SELECT * FROM domains_zones WHERE connection_id = $1 AND zone_id = $2', [conn.id, zoneId]);
        return z ? { conn, zone: z } : fail(404, 'zone.not_found', 'No such zone on this connection. Sync it again if you just added it.');
    }

    async function records(subject, connectionId, zoneId) {
        const { conn } = await zone(subject, connectionId, zoneId);
        const list = await withToken(conn, (p, token) => p.records(token, zoneId));
        return list.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
    }

    /** A checked proposal from the asker's changes; update and delete read the current value as `before`. */
    async function propose(subject, createdBy, { connection_id: connectionId, zone_id: zoneId, title, why, risk, changes }) {
        const { conn, zone: z } = await zone(subject, connectionId, zoneId);
        if (!Array.isArray(changes) || !changes.length) fail(422, 'proposal.invalid', 'A proposal holds at least one change.');
        if (changes.length > MAX_CHANGES) fail(422, 'proposal.invalid', `A proposal holds at most ${MAX_CHANGES} changes.`);
        const kinds = changes.map((c) => (isNameserverChange(c) ? 'ns' : isDsChange(c) ? 'ds' : 'record'));
        const current = await withToken(conn, async (p, token) => {
            const out = { records: [], ns: null, ds: [] };
            if (kinds.includes('record')) out.records = await p.records(token, zoneId);
            if (kinds.includes('ns')) {
                if (typeof p.nameservers !== 'function') throw new PanelError(422, 'proposal.unsupported', `${conn.provider} cannot change name servers here.`);
                out.ns = await p.nameservers(token, z.name);
            }
            if (kinds.includes('ds')) {
                if (typeof p.dsRecords !== 'function') throw new PanelError(422, 'proposal.unsupported', `${conn.provider} cannot change DS records here.`);
                out.ds = await p.dsRecords(token, z.name);
            }
            return out;
        });
        const byId = new Map(current.records.map((r) => [r.id, r]));
        const clean = changes.map((c, i) => {
            const where = `Change ${i + 1}`;
            const op = String(c && c.op || '');
            if (isNameserverChange(c)) {
                if (op !== 'update') fail(422, 'proposal.invalid', `${where}: name servers are changed, not created or removed.`);
                return { type: 'NS', op: 'update', record_id: null, before: current.ns || [], after: cleanNameservers(c.after == null ? c.nameservers : c.after, where) };
            }
            if (isDsChange(c)) {
                if (op === 'create') return { op, record_id: null, before: null, after: cleanDs(c.after, z.name, where) };
                if (op !== 'delete') fail(422, 'proposal.invalid', `${where}: a DS record is created or removed, not changed.`);
                const rawKey = c.record_id == null ? (c.keyTag == null ? (c.key_tag == null ? c.keytag : c.key_tag) : c.keyTag) : c.record_id;
                const wanted = rawKey == null || rawKey === '' ? null : String(rawKey);
                const before = (current.ds || []).find((r) => (wanted && String(r.id) === wanted)
                    || (c.before && sameDs(r, c.before)) || (c.after && sameDs(r, c.after)));
                if (!before) fail(409, 'proposal.stale', `${where}: that DS record is not there any more. Reload the domain.`);
                return { op, record_id: before.id, before, after: null };
            }
            if (op === 'create') return { op, record_id: null, before: null, after: cleanRecord(c.after, z.name, where) };
            if (op !== 'update' && op !== 'delete') fail(422, 'proposal.invalid', `${where}: create, update or delete.`);
            const before = byId.get(String(c.record_id || ''));
            if (!before) fail(409, 'proposal.stale', `${where}: that record is not in ${z.name} any more. Reload the zone.`);
            const { id: _id, ...plain } = before;
            return { op, record_id: before.id, before: plain, after: op === 'update' ? cleanRecord({ ...plain, ...c.after }, z.name, where) : null };
        });
        const noop = clean.find((c) => (c.type === 'NS' ? sameNameservers(c.before, c.after) : c.op === 'update' && sameRecord(c.before, c.after)));
        if (noop) fail(422, 'proposal.invalid', `${describe(noop)} changes nothing.`);
        const id = store.newId('dpr');
        const name = String(title || '').trim().slice(0, 160) || (clean.length === 1 ? describe(clean[0]).slice(0, 160) : `${clean.length} DNS changes to ${z.name}`);
        const at = store.now();
        await db.exec(`INSERT INTO domains_proposals (id, subject, connection_id, zone_id, domain, title, why, risk, changes, status, created_by, created_at, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending', $10, $11::timestamptz, $12::timestamptz)`,
        [id, subject, conn.id, zoneId, z.name, name, why ? String(why).trim().slice(0, 1000) : null, (risk ? String(risk).trim() : riskOf(clean)).slice(0, 1000),
            JSON.stringify(clean), createdBy, new Date(at).toISOString(), new Date(at + DECIDE_DAYS * 86_400_000).toISOString()]);
        await audit(subject, 'proposal.created', { connectionId: conn.id, proposalId: id, detail: { by: createdBy, changes: clean.length, domain: z.name } });
        return await get(subject, id);
    }

    async function get(subject, id) {
        await expire(subject);
        const row = await db.maybe(`SELECT p.*, c.provider FROM domains_proposals p JOIN domains_connections c ON c.id = p.connection_id
            WHERE p.id = $1 AND p.subject = $2`, [id, subject]);
        return row || fail(404, 'proposal.not_found', 'No such proposal of yours.');
    }

    async function list(subject, { since = null, limit = 50 } = {}) {
        await expire(subject);
        return await db.many(`SELECT p.*, c.provider FROM domains_proposals p JOIN domains_connections c ON c.id = p.connection_id
            WHERE p.subject = $1 AND (p.status IN ('pending', 'applying') OR $2::timestamptz IS NULL OR p.created_at >= $2::timestamptz)
            ORDER BY p.created_at DESC LIMIT $3`, [subject, since, Math.min(200, limit)]);
    }

    async function expire(subject) {
        await db.exec("UPDATE domains_proposals SET status = 'expired' WHERE subject = $1 AND status = 'pending' AND expires_at < $2::timestamptz", [subject, store.iso()]);
    }

    /** Run `ops` in order through the provider; returns { done, rollback, error }. Stale records are refused. */
    async function run(conn, zoneId, ops) {
        return await withToken(conn, async (p, token) => {
            const rollback = [];
            let done = 0;
            try {
                for (const c of ops) {
                    if (isNameserverChange(c)) {
                        if (typeof p.nameservers !== 'function' || typeof p.setNameservers !== 'function') throw new PanelError(422, 'proposal.unsupported', `${conn.provider} cannot change name servers here.`);
                        const now = await p.nameservers(token, zoneId);
                        if (!sameNameservers(now, c.before)) throw new PanelError(409, 'proposal.stale', `${describe(c)}: the name servers changed since this was proposed, so nothing more was applied.`);
                        await p.setNameservers(token, zoneId, c.after);
                        rollback.unshift({ type: 'NS', op: 'update', record_id: null, before: c.after, after: c.before });
                    } else if (isDsChange(c)) {
                        if (typeof p.dsRecords !== 'function' || typeof p.createDs !== 'function' || typeof p.deleteDs !== 'function') throw new PanelError(422, 'proposal.unsupported', `${conn.provider} cannot change DS records here.`);
                        if (c.op === 'create') {
                            const made = await p.createDs(token, zoneId, c.after);
                            const record = made && made.type === 'DS' ? made : c.after;
                            rollback.unshift({ op: 'delete', record_id: dsKey(record), before: record, after: null });
                        } else {
                            const list = await p.dsRecords(token, zoneId);
                            const now = list.find((r) => (c.record_id != null && String(r.id) === String(c.record_id)) || sameDs(r, c.before));
                            if (!now || !sameDs(now, c.before)) throw new PanelError(409, 'proposal.stale', `${describe(c)}: the DS record changed since this was proposed, so nothing more was applied.`);
                            await p.deleteDs(token, zoneId, now.id || c.record_id);
                            rollback.unshift({ op: 'create', record_id: null, before: null, after: now });
                        }
                    } else if (c.op === 'create') {
                        const made = await p.create(token, zoneId, c.after);
                        const { id: madeId, ...plain } = made;
                        rollback.unshift({ op: 'delete', record_id: madeId, before: plain, after: null });
                    } else {
                        const now = await p.record(token, zoneId, c.record_id);
                        if (!now || !sameRecord(now, c.before)) throw new PanelError(409, 'proposal.stale', `${describe(c)}: the record changed since this was proposed, so nothing more was applied.`);
                        if (c.op === 'update') {
                            const after = await p.update(token, zoneId, c.record_id, c.after);
                            const { id: _x, ...plain } = after;
                            rollback.unshift({ op: 'update', record_id: c.record_id, before: plain, after: c.before });
                        } else {
                            await p.remove(token, zoneId, c.record_id);
                            rollback.unshift({ op: 'create', record_id: null, before: null, after: c.before });
                        }
                    }
                    done++;
                }
                return { done, rollback, error: null };
            } catch (err) {
                return { done, rollback, error: err };
            }
        });
    }

    async function decide(subject, id, decision, by) {
        const row = await get(subject, id);
        if (row.status !== 'pending') fail(409, 'proposal.decided', `This proposal is ${row.status.replace('_', ' ')} already.`);
        if (decision === 'decline') {
            await db.exec("UPDATE domains_proposals SET status = 'declined', decided_at = $2::timestamptz, decided_by = $3 WHERE id = $1 AND status = 'pending'", [id, store.iso(), by]);
            await audit(subject, 'proposal.declined', { connectionId: row.connection_id, proposalId: id, detail: { by } });
            return await get(subject, id);
        }
        if (decision !== 'approve') fail(422, 'proposal.decision', 'The decision is approve or decline.');
        const claimed = await db.maybe("UPDATE domains_proposals SET status = 'applying', decided_at = $2::timestamptz, decided_by = $3 WHERE id = $1 AND status = 'pending' RETURNING id", [id, store.iso(), by]);
        if (!claimed) fail(409, 'proposal.decided', 'Someone decided this a moment ago.');
        const conn = await connection(subject, row.connection_id).catch(() => null);
        let out;
        try {
            out = conn ? await run(conn, row.zone_id, parse(row.changes)) : { done: 0, rollback: [], error: new PanelError(409, 'connection.not_found', 'The connection was removed.') };
        } catch (err) {
            out = { done: 0, rollback: [], error: err };
        }
        const ok = !out.error;
        await db.exec(`UPDATE domains_proposals SET status = $2, applied_at = $3::timestamptz, rollback = $4::jsonb, result = $5::jsonb, error = $6 WHERE id = $1`,
            [id, ok ? 'applied' : 'failed', ok ? store.iso() : null, JSON.stringify(out.rollback), JSON.stringify({ applied: out.done, of: parse(row.changes).length }), ok ? null : String(out.error.message || 'failed').slice(0, 400)]);
        await audit(subject, ok ? 'proposal.applied' : 'proposal.failed', { connectionId: row.connection_id, proposalId: id, detail: { by, applied: out.done, code: ok ? null : out.error.code || null } });
        return await get(subject, id);
    }

    async function rollBack(subject, id, by) {
        const row = await get(subject, id);
        const steps = parse(row.rollback) || [];
        if (!['applied', 'failed'].includes(row.status) || !steps.length) fail(409, 'proposal.no_rollback', 'There is nothing applied to roll back.');
        const claimed = await db.maybe("UPDATE domains_proposals SET status = 'applying' WHERE id = $1 AND status IN ('applied', 'failed') RETURNING id", [id]);
        if (!claimed) fail(409, 'proposal.decided', 'This proposal is changing right now.');
        const conn = await connection(subject, row.connection_id);
        const out = await run(conn, row.zone_id, steps);
        const ok = !out.error;
        await db.exec(`UPDATE domains_proposals SET status = $2, rolled_back_at = $3::timestamptz, rollback = $4::jsonb, error = $5 WHERE id = $1`,
            [id, ok ? 'rolled_back' : row.status, ok ? store.iso() : null, JSON.stringify(ok ? [] : steps.slice(out.done)), ok ? null : `Roll back stopped: ${String(out.error.message).slice(0, 360)}`]);
        await audit(subject, ok ? 'proposal.rolled_back' : 'proposal.rollback_failed', { connectionId: row.connection_id, proposalId: id, detail: { by, steps: out.done } });
        return await get(subject, id);
    }

    /** At boot: a proposal a stop left mid-apply is failed, with whatever rollback it had, for its person to undo. */
    async function recover() {
        const r = await db.many("UPDATE domains_proposals SET status = 'failed', error = 'OpenVibe.Domains stopped while applying this. Check the zone, then roll back what was applied.' WHERE status = 'applying' RETURNING id");
        return r.length;
    }

    return { connect, remove, sync, connections, zones, zone, records, propose, get, list, decide, rollBack, recover, toPublic, toActionItem, describe };
}

module.exports = { createPanel, PanelError, cleanRecord, cleanNameservers, cleanDs, sameRecord, sameNameservers, sameDs, describe, riskOf, toPublic, toActionItem, inZone, PROVIDERS, TYPES, normalize };
