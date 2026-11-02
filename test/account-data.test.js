'use strict';
/**
 * ADR-033: every table in Domains with a person column is in the account-data map or exempted with a reason. The
 * module itself is exercised by the panel and API tests; this one is the guard that keeps a new person column from
 * shipping unanswered.
 */
const assert = require('assert');
const { uncovered } = require('openvibe-sdk/account-data');
const { boot, check, done } = require('./helpers');
const { TABLES } = require('../server/identity/account-data');

(async () => {
    await check('every table that names a person is covered or exempted with a reason', async () => {
        const t = await boot();
        try {
            const missing = await uncovered(t.store.db, {
                tables: TABLES,
                exempt: { account_data_events: 'the ledger of requests itself: which export and deletion Domains applied' },
            });
            assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
        } finally { await t.close(); }
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
