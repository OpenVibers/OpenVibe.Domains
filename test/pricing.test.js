'use strict';

/** Price rows: y1/y3/y5, the five-year fallback, the renewal trap, rounding, USD order. */
const assert = require('assert');
const { priceRows } = require('../server/pricing');
const { check, done } = require('./helpers');

(async () => {
    await check('totals and the five-year fallback', () => {
        const [row] = priceRows([{ register: 10, renew: 20, transfer: 10, five_year: 90, currency: 'USD', tld: 'com', registrar: 'A' }]);
        assert.strictEqual(row.y1, 10);
        assert.strictEqual(row.y3, 50);
        assert.strictEqual(row.y5, 90);
        assert.strictEqual(row.trap, true);
        const [fallback] = priceRows([{ register: 5, renew: 6, currency: 'USD', tld: 'dev' }]);
        assert.strictEqual(fallback.y3, 17);
        assert.strictEqual(fallback.y5, 29);
        assert.strictEqual(fallback.trap, false);
    });

    await check('a missing price makes the total null, never NaN', () => {
        const [row] = priceRows([{ register: 5, currency: 'USD' }]);
        assert.strictEqual(row.y3, null);
        assert.strictEqual(row.y5, null);
        assert.strictEqual(row.trap, false);
    });

    await check('money is rounded to cents', () => {
        const [row] = priceRows([{ register: 1.005, renew: 2.005, five_year: 9.999, currency: 'USD' }]);
        assert.strictEqual(row.y1, 1.01);
        assert.strictEqual(row.y3, 5.02);
        assert.strictEqual(row.y5, 10);
    });

    await check('the renewal trap needs both halves of the rule', () => {
        const rows = priceRows([
            { register: 10, renew: 19, currency: 'USD', id: 'below double' },
            { register: 10, renew: 14.99, currency: 'USD', id: 'not 5 more' },
            { register: 8, renew: 16, currency: 'USD', id: 'exactly both' },
        ]);
        const by = Object.fromEntries(rows.map((r) => [r.id, r.trap]));
        assert.strictEqual(by['below double'], false);
        assert.strictEqual(by['not 5 more'], false);
        assert.strictEqual(by['exactly both'], true);
    });

    await check('sorted by y3 ascending, rows without y3 last', () => {
        const rows = priceRows([
            { register: 10, renew: 20, currency: 'USD', id: '50' },
            { register: 5, renew: 6, currency: 'USD', id: '17' },
            { register: 8, renew: 9, currency: 'USD', id: '26' },
            { register: 8, currency: 'USD', id: 'missing' },
        ]);
        assert.deepStrictEqual(rows.map((r) => r.id), ['17', '26', '50', 'missing']);
    });

    await check('non-USD rows are flagged, stay after every USD row and keep their own order', () => {
        const rows = priceRows([
            { register: 1, renew: 1, currency: 'EUR', id: 'eur-30' },
            { register: 9, renew: 9, currency: 'USD', id: 'usd-27' },
            { register: 20, renew: 20, currency: 'GBP', id: 'gbp-60' },
        ]);
        assert.deepStrictEqual(rows.map((r) => r.id), ['usd-27', 'eur-30', 'gbp-60']);
        assert.strictEqual(rows[0].currency_other, undefined);
        assert.strictEqual(rows[1].currency_other, true);
        assert.strictEqual(rows[2].currency_other, true);
    });

    await check('the input rows are not mutated', () => {
        const input = [{ register: 10, renew: 20, currency: 'USD' }];
        const [row] = priceRows(input);
        assert.strictEqual(input[0].y1, undefined);
        assert.strictEqual(row.register, 10);
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
