'use strict';
/**
 * The control panel (DOM-2) end to end, on a migrated test database with a Network stand-in (projects, secrets,
 * network.secret.use) and a stand-in Cloudflare account behind the real client:
 * connect stores the token as the person's Network project secret (granted for reveal to api.cloudflare.com only) and
 * never in this database; a proposal changes nothing until approved; approving applies and keeps the rollback; rolling
 * back undoes it; a record that moved is refused as stale; another site cannot post; Network's Action Center reads and
 * decides with its own capabilities; a revoked token marks the connection broken; removing deletes the secret.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers');
const { startNetwork } = require('./helpers/network');
const { fakeCloudflare } = require('./helpers/fake-cloudflare');
const { createCloudflare } = require('../server/panel/cloudflare');

const CF_TOKEN = 'cf-test-token-0123456789abcdefABCDEF';
const stub = { tlds: async () => ({ tlds: [] }), tld: async () => null, prices: async () => null, lists: async () => ({}), history: async () => null, check: async () => null };

(async () => {
    const network = await startNetwork();
    const cf = fakeCloudflare({ token: CF_TOKEN, zones: [{ id: 'z1', name: 'example.com' }] });
    const www = cf.addRecord('z1', { type: 'A', name: 'www.example.com', content: '192.0.2.1', proxied: true });
    const t = await boot({ host: stub, tools: stub, network, providers: { cloudflare: createCloudflare({ fetchImpl: cf.fetch }) } });
    const ada = network.addUser('ada');
    const bob = network.addUser('bob');
    const cookie = t.signIn(ada);
    const db = t.store.db;
    const locationOf = (r) => r.headers.get('location');
    let conn = null;
    let proposalId = null;

    await check('signed out, /panel says what it is and asks to sign in; never cached', async () => {
        const r = await t.get('/panel');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /Sign in with OpenVibe/);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        const c = await t.get('/panel/connect');
        assert.strictEqual(c.status, 303);
        assert.match(locationOf(c), /^\/auth\/login\?next=%2Fpanel%2Fconnect/);
    });

    await check('a bad token is refused in words, and nothing is stored', async () => {
        const r = await t.get('/panel/connect', { cookie, form: { provider: 'cloudflare', label: 'Main', token: 'cf-wrong-token-0123456789abcdef' } });
        assert.strictEqual(r.status, 422);
        assert.match(r.text, /Cloudflare refused this token/);
        assert.strictEqual(network.state.secrets.size, 0);
        assert.strictEqual(await db.value('SELECT count(*)::int FROM domains_connections'), 0);
    });

    await check('connecting stores the token as the person\'s project secret, granted for api.cloudflare.com only, and syncs the zones', async () => {
        const r = await t.get('/panel/connect', { cookie, form: { provider: 'cloudflare', label: 'Main account', token: CF_TOKEN } });
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual(locationOf(r), '/panel?done=connected');
        conn = await db.maybe('SELECT * FROM domains_connections WHERE subject = $1', [ada.subject]);
        assert.ok(conn && conn.status === 'active');
        const [key, secret] = [...network.state.secrets.entries()][0];
        assert.strictEqual(key, `${conn.project_id}/production/${conn.secret_name}`);
        assert.strictEqual(secret.value, CF_TOKEN);
        assert.deepStrictEqual(secret.grants.domains, { purposes: ['reveal'], origins: ['https://api.cloudflare.com'] });
        // The token is nowhere in this service's database.
        for (const table of ['domains_connections', 'domains_zones', 'domains_proposals', 'domains_audit']) {
            const dump = JSON.stringify(await db.many(`SELECT * FROM ${table}`));
            assert.ok(!dump.includes(CF_TOKEN), `${table} holds the token`);
        }
        const zones = await db.many('SELECT * FROM domains_zones WHERE connection_id = $1', [conn.id]);
        assert.deepStrictEqual(zones.map((z) => z.name), ['example.com']);
        const page = await t.get('/panel?done=connected', { cookie });
        assert.match(page.text, /id="dmp-zone-z1"/);
        assert.match(page.text, /Connected\. Your zones are below\./);
        assert.deepStrictEqual(cf.leaks, []);
    });

    await check('a zone shows its records live; proposing adds nothing until it is approved', async () => {
        const z = await t.get(`/panel/z/${conn.id}/z1`, { cookie });
        assert.strictEqual(z.status, 200);
        assert.match(z.text, /www\.example\.com/);
        const before = cf.records('z1').length;
        const r = await t.get(`/panel/z/${conn.id}/z1/propose`, { cookie, form: { op: 'create', type: 'TXT', name: '@', content: 'openvibe-proof=1', ttl: '1', why: 'Prove the zone is ours' } });
        assert.strictEqual(r.status, 303, r.text);
        proposalId = locationOf(r).split('/').pop();
        assert.match(proposalId, /^dpr_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(cf.records('z1').length, before, 'nothing applied yet');
        const p = await t.get(`/panel/p/${proposalId}`, { cookie });
        assert.match(p.text, /Approve and apply/);
        assert.match(p.text, /Add TXT example\.com|Add/);
        const api = await t.get(`/api/v1/proposals/${proposalId}`, { bearer: network.userToken(ada) });
        const v = contracts.validate('domains.proposal', api.json());
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(api.json().status, 'pending');
    });

    await check('another site cannot approve for a signed-in person', async () => {
        const r = await t.get(`/panel/p/${proposalId}/decide`, { cookie, form: { decision: 'approve' }, origin: 'https://evil.example' });
        assert.strictEqual(r.status, 403);
        const row = await db.maybe('SELECT status FROM domains_proposals WHERE id = $1', [proposalId]);
        assert.strictEqual(row.status, 'pending');
    });

    await check('approving applies it through Cloudflare and keeps the rollback; rolling back undoes it', async () => {
        const r = await t.get(`/panel/p/${proposalId}/decide`, { cookie, form: { decision: 'approve' } });
        assert.strictEqual(r.status, 303);
        const added = cf.records('z1').find((x) => x.type === 'TXT');
        assert.ok(added && added.content === 'openvibe-proof=1' && added.name === 'example.com');
        let row = await db.maybe('SELECT * FROM domains_proposals WHERE id = $1', [proposalId]);
        assert.strictEqual(row.status, 'applied');
        assert.strictEqual(row.rollback.length, 1);
        assert.strictEqual(row.rollback[0].op, 'delete');
        const page = await t.get(`/panel/p/${proposalId}?done=approved`, { cookie });
        assert.match(page.text, /Applied\./);
        const back = await t.get(`/panel/p/${proposalId}/rollback`, { cookie, form: {} });
        assert.strictEqual(back.status, 303);
        assert.ok(!cf.records('z1').some((x) => x.type === 'TXT'), 'the record is gone again');
        row = await db.maybe('SELECT * FROM domains_proposals WHERE id = $1', [proposalId]);
        assert.strictEqual(row.status, 'rolled_back');
        const audit = (await db.many('SELECT action FROM domains_audit WHERE proposal_id = $1 ORDER BY id', [proposalId])).map((x) => x.action);
        assert.deepStrictEqual(audit, ['proposal.created', 'proposal.applied', 'proposal.rolled_back']);
    });

    await check('a record that moved since the proposal is refused as stale, and nothing more is applied', async () => {
        const r = await t.get('/api/v1/proposals', { bearer: network.userToken(ada), json: { connection_id: conn.id, zone_id: 'z1', changes: [{ op: 'update', record_id: www.id, after: { content: '192.0.2.7' } }] } });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json().id;
        assert.strictEqual(r.json().changes[0].before.content, '192.0.2.1');
        cf.setRecord('z1', www.id, { content: '198.51.100.9' });   // someone changed it in Cloudflare meanwhile
        const d = await t.get(`/api/v1/proposals/${id}/decide`, { bearer: network.userToken(ada), json: { decision: 'approve' } });
        assert.strictEqual(d.status, 200, d.text);
        assert.strictEqual(d.json().status, 'failed');
        assert.match(d.json().error, /changed since this was proposed/);
        assert.strictEqual(cf.records('z1').find((x) => x.id === www.id).content, '198.51.100.9', 'left as someone set it');
    });

    await check('a change outside the zone, or one that changes nothing, is refused', async () => {
        const out = await t.get('/api/v1/proposals', { bearer: network.userToken(ada), json: { connection_id: conn.id, zone_id: 'z1', changes: [{ op: 'create', after: { type: 'A', name: 'mail.other.org', content: '192.0.2.5' } }] } });
        assert.strictEqual(out.status, 201, 'a bare name is placed inside the zone');
        assert.strictEqual(out.json().changes[0].after.name, 'mail.other.org.example.com');
        const bad = await t.get('/api/v1/proposals', { bearer: network.userToken(ada), json: { connection_id: conn.id, zone_id: 'z1', changes: [{ op: 'create', after: { type: 'A', name: 'x', content: 'not-an-ip' } }] } });
        assert.strictEqual(bad.status, 422);
        const noop = await t.get('/api/v1/proposals', { bearer: network.userToken(ada), json: { connection_id: conn.id, zone_id: 'z1', changes: [{ op: 'update', record_id: www.id, after: {} }] } });
        assert.strictEqual(noop.status, 422);
        assert.match(noop.json().detail, /changes nothing/);
    });

    await check('another person sees none of it', async () => {
        const r = await t.get(`/api/v1/proposals/${proposalId}`, { bearer: network.userToken(bob) });
        assert.strictEqual(r.status, 404);
        const z = await t.get('/api/v1/panel/zones', { bearer: network.userToken(bob) });
        assert.deepStrictEqual(z.json().zones, []);
    });

    await check('the Action Center reads with domains.actions.read and decides with domains.proposal.decide', async () => {
        const fresh = await t.get('/api/v1/proposals', { bearer: network.userToken(ada), json: { connection_id: conn.id, zone_id: 'z1', title: 'Add a CAA record', changes: [{ op: 'create', after: { type: 'CAA', name: '@', content: '0 issue "letsencrypt.org"' } }] } });
        const id = fresh.json().id;
        const noCap = await t.get(`/api/v1/actions?subject=${ada.subject}`, { bearer: network.serviceToken(['domains.proposal.decide']) });
        assert.strictEqual(noCap.status, 403);
        const asPerson = await t.get(`/api/v1/actions?subject=${ada.subject}`, { bearer: network.userToken(ada) });
        assert.strictEqual(asPerson.status, 401);
        const list = await t.get(`/api/v1/actions?subject=${ada.subject}`, { bearer: network.serviceToken(['domains.actions.read']) });
        assert.strictEqual(list.status, 200, list.text);
        const items = list.json().items;
        for (const item of items) { const v = contracts.validate('common.action-item', item); assert.ok(v.valid, JSON.stringify(v.errors)); }
        const mine = items.find((x) => x.id === id);
        assert.deepStrictEqual([mine.bucket, mine.actions], ['waiting', ['approve', 'decline', 'open']]);
        const bobs = await t.get(`/api/v1/actions?subject=${bob.subject}`, { bearer: network.serviceToken(['domains.actions.read']) });
        assert.deepStrictEqual(bobs.json().items, []);
        const decided = await t.get(`/api/v1/proposals/${id}/decide`, { bearer: network.serviceToken(['domains.proposal.decide']), headers: { 'x-ov-subject': ada.subject }, json: { decision: 'approve' }, origin: '' });
        assert.strictEqual(decided.status, 200, decided.text);
        assert.strictEqual(decided.json().bucket, 'done');
        assert.ok(contracts.validate('common.action-item', decided.json()).valid);
        assert.ok(cf.records('z1').some((x) => x.type === 'CAA'));
        const row = await db.maybe('SELECT decided_by FROM domains_proposals WHERE id = $1', [id]);
        assert.strictEqual(row.decided_by, 'service:network');
    });

    await check('a revoked token marks the connection broken, in words', async () => {
        cf.revoke();
        const r = await t.get(`/panel/c/${conn.id}/sync`, { cookie, form: {} });
        assert.strictEqual(r.status, 303);
        assert.match(locationOf(r), /problem=provider\.forbidden/);
        const row = await db.maybe('SELECT status, last_error FROM domains_connections WHERE id = $1', [conn.id]);
        assert.strictEqual(row.status, 'broken');
        const page = await t.get('/panel', { cookie });
        assert.match(page.text, /is-broken/);
    });

    await check('removing a connection deletes its secret at Network and expires what was waiting', async () => {
        const pending = await db.value("SELECT count(*)::int FROM domains_proposals WHERE connection_id = $1 AND status = 'pending'", [conn.id]);
        assert.ok(pending >= 1);
        const r = await t.get(`/panel/c/${conn.id}/remove`, { cookie, form: {} });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(network.state.secrets.size, 0);
        assert.strictEqual(await db.value("SELECT count(*)::int FROM domains_proposals WHERE connection_id = $1 AND status = 'pending'", [conn.id]), 0);
        const row = await db.maybe('SELECT status FROM domains_connections WHERE id = $1', [conn.id]);
        assert.strictEqual(row.status, 'removed');
    });

    await check('a stop mid-apply is marked failed at boot, for its person to check', async () => {
        await db.exec("UPDATE domains_proposals SET status = 'applying' WHERE id = $1", [proposalId]);
        assert.strictEqual(await t.ctx.panel.recover(), 1);
        const row = await db.maybe('SELECT status, error FROM domains_proposals WHERE id = $1', [proposalId]);
        assert.strictEqual(row.status, 'failed');
        assert.match(row.error, /stopped while applying/);
    });

    await t.close();
    await network.close();
    done();
})();
