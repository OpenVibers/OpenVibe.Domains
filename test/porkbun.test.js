'use strict';
/**
 * Porkbun in the control panel (DOM-2) end to end, on a migrated test database with a Network stand-in and a
 * stand-in Porkbun account behind the real client:
 *
 * connect stores the two keys as one JSON secret granted for reveal to api.porkbun.com only, with no key anywhere in
 * this database; a DNS record is proposed, applied and rolled back; a nameserver list is changed through the registrar
 * and rolled back; a DS record is created through the registrar and rolled back; a nameserver list that moved is
 * refused as stale; the Action Center reads the proposal.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers');
const { startNetwork } = require('./helpers/network');
const { fakePorkbun } = require('./helpers/fake-porkbun');
const { createPorkbun, normalize, bodyOf } = require('../server/panel/porkbun');

const API_KEY = 'pk1_example-not-a-real-key-aaaaaaaa';
const SECRET_KEY = 'sk1_example-not-a-real-key-bbbbbbbb';
const STUB = { tlds: async () => ({ tlds: [] }), tld: async () => null, prices: async () => null, lists: async () => ({}), history: async () => null, check: async () => null };
const sorted = (list) => [...list].sort();

(async () => {
    const network = await startNetwork();
    const pb = fakePorkbun({ apikey: API_KEY, secretapikey: SECRET_KEY, domains: [{ domain: 'example.com' }] });
    pb.addRecord('example.com', { type: 'A', name: 'www', content: '192.0.2.1', ttl: 600 });
    const t = await boot({ host: STUB, tools: STUB, network, providers: { porkbun: createPorkbun({ fetchImpl: pb.fetch }) } });
    const ada = network.addUser('ada');
    const cookie = t.signIn(ada);
    const db = t.store.db;
    const locationOf = (r) => r.headers.get('location');
    let conn = null;

    await check('a relative record name is made fully qualified and a full name is written back relative', async () => {
        const rec = normalize({ id: '1', name: 'www', type: 'A', content: '192.0.2.1', ttl: '600', prio: null }, 'example.com');
        assert.strictEqual(rec.name, 'www.example.com');
        assert.strictEqual(rec.ttl, 600);
        assert.strictEqual(bodyOf({ type: 'A', name: 'www.example.com', content: '192.0.2.1', ttl: 600 }, 'example.com').name, 'www');
        assert.strictEqual(bodyOf({ type: 'A', name: 'example.com', content: '192.0.2.1', ttl: 1 }, 'example.com').name, '');
    });

    await check('bad keys are refused in Porkbun\'s words, and nothing is stored', async () => {
        const r = await t.get('/panel/connect', { cookie, form: { provider: 'porkbun', label: 'Main', apikey: 'pk1_wrong', secretapikey: 'sk1_wrong' } });
        assert.strictEqual(r.status, 422, r.text);
        assert.match(r.text, /Porkbun refused the keys: Invalid API key/);
        assert.strictEqual(network.state.secrets.size, 0);
        assert.strictEqual(await db.value('SELECT count(*)::int FROM domains_connections'), 0);
        assert.deepStrictEqual(pb.leaks, []);
    });

    await check('connecting stores the pair as one JSON secret granted to api.porkbun.com only, and syncs the domains', async () => {
        const r = await t.get('/panel/connect', { cookie, form: { provider: 'porkbun', label: 'Main account', apikey: API_KEY, secretapikey: SECRET_KEY } });
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual(locationOf(r), '/panel?done=connected');
        conn = await db.maybe('SELECT * FROM domains_connections WHERE subject = $1', [ada.subject]);
        assert.ok(conn && conn.status === 'active' && conn.provider === 'porkbun');
        const [key, secret] = [...network.state.secrets.entries()][0];
        assert.strictEqual(key, `${conn.project_id}/production/${conn.secret_name}`);
        assert.strictEqual(secret.value, JSON.stringify({ apikey: API_KEY, secretapikey: SECRET_KEY }));
        assert.deepStrictEqual(secret.grants.domains, { purposes: ['reveal'], origins: ['https://api.porkbun.com'] });
        // Neither key is anywhere in this service's database.
        for (const table of ['domains_connections', 'domains_zones', 'domains_proposals', 'domains_audit']) {
            const dump = JSON.stringify(await db.many(`SELECT * FROM ${table}`));
            assert.ok(!dump.includes(API_KEY), `${table} holds the API key`);
            assert.ok(!dump.includes(SECRET_KEY), `${table} holds the secret key`);
        }
        const zones = await db.many('SELECT * FROM domains_zones WHERE connection_id = $1', [conn.id]);
        assert.deepStrictEqual(zones.map((z) => z.name), ['example.com']);
        const page = await t.get('/panel?done=connected', { cookie });
        assert.match(page.text, /id="dmp-zone-example\.com"/);
        assert.match(page.text, /Porkbun · 1 zone/);
        assert.ok(pb.calls.some((c) => c.path === '/api/json/v3/ping'), 'verify used /ping');
        assert.deepStrictEqual(pb.leaks, []);
    });

    await check('a record proposal changes nothing until approved; approving applies and rolling back undoes it', async () => {
        const r = await t.get('/api/v1/proposals', {
            bearer: network.userToken(ada),
            json: { connection_id: conn.id, zone_id: 'example.com', why: 'Prove the zone is ours', changes: [{ op: 'create', after: { type: 'TXT', name: '@', content: 'openvibe-proof=1' } }] },
        });
        assert.strictEqual(r.status, 201, r.text);
        const pub = r.json();
        assert.ok(contracts.validate('domains.proposal', pub).valid);
        assert.strictEqual(pb.records('example.com').some((x) => x.type === 'TXT'), false, 'nothing applied yet');
        const decided = await t.get(`/api/v1/proposals/${pub.id}/decide`, { bearer: network.userToken(ada), json: { decision: 'approve' } });
        assert.strictEqual(decided.status, 200, decided.text);
        assert.strictEqual(decided.json().status, 'applied');
        const added = pb.records('example.com').find((x) => x.type === 'TXT');
        assert.ok(added && added.name === 'example.com' && added.content === 'openvibe-proof=1');
        const row = await db.maybe('SELECT * FROM domains_proposals WHERE id = $1', [pub.id]);
        assert.strictEqual(row.rollback[0].op, 'delete');
        const back = await t.get(`/api/v1/proposals/${pub.id}/rollback`, { bearer: network.userToken(ada), json: {} });
        assert.strictEqual(back.status, 200, back.text);
        assert.strictEqual(back.json().status, 'rolled_back');
        assert.strictEqual(pb.records('example.com').some((x) => x.type === 'TXT'), false, 'the record is gone again');
    });

    await check('a nameserver change is applied through the registrar and rolls back; its risk is in plain words', async () => {
        const before = pb.nameservers('example.com');
        const after = ['ns1.new.example', 'ns2.new.example'];
        const r = await t.get('/api/v1/proposals', {
            bearer: network.userToken(ada),
            json: { connection_id: conn.id, zone_id: 'example.com', changes: [{ type: 'NS', op: 'update', after }] },
        });
        assert.strictEqual(r.status, 201, r.text);
        const pub = r.json();
        assert.deepStrictEqual(pub.changes[0].before, before);
        assert.deepStrictEqual(pub.changes[0].after, after);
        assert.match(pub.title, /Change name servers/);
        assert.match(pub.risk, /wrong list makes the domain stop resolving/);
        assert.deepStrictEqual(pb.nameservers('example.com'), before, 'nothing applied yet');
        const decided = await t.get(`/api/v1/proposals/${pub.id}/decide`, { bearer: network.userToken(ada), json: { decision: 'approve' } });
        assert.strictEqual(decided.status, 200, decided.text);
        assert.strictEqual(decided.json().status, 'applied');
        assert.deepStrictEqual(sorted(pb.nameservers('example.com')), sorted(after));
        const row = await db.maybe('SELECT * FROM domains_proposals WHERE id = $1', [pub.id]);
        assert.strictEqual(row.rollback[0].type, 'NS');
        const back = await t.get(`/api/v1/proposals/${pub.id}/rollback`, { bearer: network.userToken(ada), json: {} });
        assert.strictEqual(back.status, 200, back.text);
        assert.strictEqual(back.json().status, 'rolled_back');
        assert.deepStrictEqual(sorted(pb.nameservers('example.com')), sorted(before));
    });

    await check('a DS record is created through the registrar and rolls back', async () => {
        const digest = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
        const after = { type: 'DS', name: 'example.com', content: `12345 13 2 ${digest}` };
        const r = await t.get('/api/v1/proposals', {
            bearer: network.userToken(ada),
            json: { connection_id: conn.id, zone_id: 'example.com', changes: [{ op: 'create', after }] },
        });
        assert.strictEqual(r.status, 201, r.text);
        const pub = r.json();
        const valid = contracts.validate('domains.proposal', pub);
        assert.ok(valid.valid, JSON.stringify(valid.errors));
        assert.strictEqual(pb.dsRecords('example.com').length, 0, 'nothing applied yet');
        assert.ok(pb.calls.some((c) => c.path === '/api/json/v3/dns/getDnssecRecords/example.com'));
        assert.match(pub.risk, /does not match the DNS host's DNSKEY/);
        const decided = await t.get(`/api/v1/proposals/${pub.id}/decide`, { bearer: network.userToken(ada), json: { decision: 'approve' } });
        assert.strictEqual(decided.status, 200, decided.text);
        assert.strictEqual(decided.json().status, 'applied');
        const ds = pb.dsRecords('example.com');
        assert.strictEqual(ds.length, 1);
        assert.strictEqual(ds[0].keyTag, '12345');
        assert.strictEqual(ds[0].alg, '13');
        assert.strictEqual(ds[0].digestType, '2');
        assert.ok(pb.calls.some((c) => c.path === '/api/json/v3/dns/createDnssecRecord/example.com'), 'created at the registrar, not in the zone');
        const row = await db.maybe('SELECT * FROM domains_proposals WHERE id = $1', [pub.id]);
        assert.strictEqual(row.rollback[0].op, 'delete');
        assert.strictEqual(row.rollback[0].record_id, '12345');
        const back = await t.get(`/api/v1/proposals/${pub.id}/rollback`, { bearer: network.userToken(ada), json: {} });
        assert.strictEqual(back.status, 200, back.text);
        assert.strictEqual(back.json().status, 'rolled_back');
        assert.strictEqual(pb.dsRecords('example.com').length, 0);
    });

    await check('a DS record is removed through the registrar and rolls back', async () => {
        pb.addDs('example.com', { keyTag: '777', alg: '13', digestType: '2', digest: 'ABCDEF0123456789' });
        const r = await t.get('/api/v1/proposals', {
            bearer: network.userToken(ada),
            json: { connection_id: conn.id, zone_id: 'example.com', changes: [{ type: 'DS', op: 'delete', record_id: '777' }] },
        });
        assert.strictEqual(r.status, 201, r.text);
        const pub = r.json();
        assert.strictEqual(pub.changes[0].before.content, '777 13 2 ABCDEF0123456789');
        assert.strictEqual(pub.changes[0].after, null);
        const decided = await t.get(`/api/v1/proposals/${pub.id}/decide`, { bearer: network.userToken(ada), json: { decision: 'approve' } });
        assert.strictEqual(decided.status, 200, decided.text);
        assert.strictEqual(decided.json().status, 'applied');
        assert.strictEqual(pb.dsRecords('example.com').length, 0);
        const row = await db.maybe('SELECT * FROM domains_proposals WHERE id = $1', [pub.id]);
        assert.strictEqual(row.rollback[0].op, 'create');
        const back = await t.get(`/api/v1/proposals/${pub.id}/rollback`, { bearer: network.userToken(ada), json: {} });
        assert.strictEqual(back.status, 200, back.text);
        assert.strictEqual(back.json().status, 'rolled_back');
        assert.deepStrictEqual(pb.dsRecords('example.com').map((x) => x.keyTag), ['777']);
    });

    await check('a nameserver list that moved since the proposal is refused as stale', async () => {
        const r = await t.get('/api/v1/proposals', {
            bearer: network.userToken(ada),
            json: { connection_id: conn.id, zone_id: 'example.com', changes: [{ type: 'NS', op: 'update', after: ['ns3.new.example', 'ns4.new.example'] }] },
        });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json().id;
        const moved = ['ns9.other.example', 'ns10.other.example'];
        pb.setNameservers('example.com', moved);
        const decided = await t.get(`/api/v1/proposals/${id}/decide`, { bearer: network.userToken(ada), json: { decision: 'approve' } });
        assert.strictEqual(decided.status, 200, decided.text);
        assert.strictEqual(decided.json().status, 'failed');
        assert.match(decided.json().error, /name servers changed since this was proposed/);
        assert.deepStrictEqual(sorted(pb.nameservers('example.com')), sorted(moved), 'left as someone set it');
        const row = await db.maybe('SELECT rollback FROM domains_proposals WHERE id = $1', [id]);
        assert.deepStrictEqual(row.rollback, []);
    });

    await check('the Action Center reads the item with domains.actions.read and declines with domains.proposal.decide', async () => {
        const fresh = await t.get('/api/v1/proposals', {
            bearer: network.userToken(ada),
            json: { connection_id: conn.id, zone_id: 'example.com', title: 'Add a TXT proof', changes: [{ op: 'create', after: { type: 'TXT', name: '@', content: 'action-center=1' } }] },
        });
        assert.strictEqual(fresh.status, 201, fresh.text);
        const id = fresh.json().id;
        const noCap = await t.get(`/api/v1/actions?subject=${ada.subject}`, { bearer: network.serviceToken(['domains.proposal.decide']) });
        assert.strictEqual(noCap.status, 403);
        const list = await t.get(`/api/v1/actions?subject=${ada.subject}`, { bearer: network.serviceToken(['domains.actions.read']) });
        assert.strictEqual(list.status, 200, list.text);
        const item = list.json().items.find((x) => x.id === id);
        assert.ok(item, 'the proposal is in the Action Center');
        assert.ok(contracts.validate('common.action-item', item).valid);
        assert.deepStrictEqual([item.bucket, item.actions], ['waiting', ['approve', 'decline', 'open']]);
        assert.match(item.summary, /Add TXT example\.com/);
        const decided = await t.get(`/api/v1/proposals/${id}/decide`, {
            bearer: network.serviceToken(['domains.proposal.decide']), headers: { 'x-ov-subject': ada.subject }, json: { decision: 'decline' }, origin: '',
        });
        assert.strictEqual(decided.status, 200, decided.text);
        assert.strictEqual(decided.json().state, 'declined');
        assert.ok(contracts.validate('common.action-item', decided.json()).valid);
        assert.ok(!pb.records('example.com').some((x) => x.type === 'TXT' && x.content === 'action-center=1'));
    });

    await check('a revoked key pair marks the connection broken, and removing it deletes the secret', async () => {
        pb.revoke();
        const synced = await t.get(`/panel/c/${conn.id}/sync`, { cookie, form: {} });
        assert.strictEqual(synced.status, 303);
        assert.match(locationOf(synced), /problem=provider\.forbidden/);
        let row = await db.maybe('SELECT status, last_error FROM domains_connections WHERE id = $1', [conn.id]);
        assert.strictEqual(row.status, 'broken');
        assert.match(row.last_error, /Invalid API key/);
        const removed = await t.get(`/panel/c/${conn.id}/remove`, { cookie, form: {} });
        assert.strictEqual(removed.status, 303);
        assert.strictEqual(network.state.secrets.size, 0);
        row = await db.maybe('SELECT status FROM domains_connections WHERE id = $1', [conn.id]);
        assert.strictEqual(row.status, 'removed');
    });

    await t.close();
    await network.close();
    done();
})();
