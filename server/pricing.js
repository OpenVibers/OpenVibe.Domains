'use strict';

/**
 * Price rows from OpenVibe.Host's catalog (register, renew, transfer, five_year, registrars,
 * currency, checked_at, tld, display, kind) into what a visitor compares:
 *
 *   y1    first year                 = register
 *   y3    three years                = register + 2 * renew
 *   y5    five years                 = the catalog's five_year when it has one,
 *                                      else register + 4 * renew
 *   trap  renew >= 2 * register and renew - register >= 5: the cheap first year whose
 *         renewal is the real price
 *
 * Only USD rows are compared; other currencies are kept after them and flagged
 * `currency_other: true`. Sorted by y3 ascending, rows without a y3 last, stable otherwise.
 * Every money value is rounded to cents.
 */

const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
// A tiny half-cent nudge absorbs binary floating point (1.005 + 2 * 2.005 is 5.014999… in IEEE
// 754, but a registrar's decimal total is 5.015, and money rounds half up).
const cents = (n) => Math.round((n + 1e-9) * 100) / 100;

function priceRows(rows) {
    const list = (Array.isArray(rows) ? rows : []).map((row, index) => {
        const r = row && typeof row === 'object' ? row : {};
        // A price of 0 means the registrar does not sell that ending: treat it as missing.
        const registerRaw = num(r.register);
        const renewRaw = num(r.renew);
        const fiveYearRaw = num(r.five_year);
        const register = registerRaw === 0 ? null : registerRaw;
        const renew = renewRaw === 0 ? null : renewRaw;
        const fiveYear = fiveYearRaw === 0 ? null : fiveYearRaw;
        const y1 = register == null ? null : cents(register);
        const y3 = register == null || renew == null ? null : cents(register + 2 * renew);
        const y5 = fiveYear != null ? cents(fiveYear)
            : (register == null || renew == null ? null : cents(register + 4 * renew));
        const trap = register != null && renew != null && renew >= 2 * register && renew - register >= 5;
        const out = { ...r, y1, y3, y5, trap, _index: index };
        // Only the rows that are not compared carry the flag; a USD row is the normal case.
        if (r.currency !== 'USD') out.currency_other = true;
        return out;
    });

    list.sort((a, b) => {
        // USD first. Only USD rows are compared on y3; other currencies keep the host's order after them.
        if (a.currency_other !== b.currency_other) return a.currency_other ? 1 : -1;
        if (a.currency_other) return a._index - b._index;
        const ay = a.y3 == null ? Infinity : a.y3;
        const by = b.y3 == null ? Infinity : b.y3;
        if (ay !== by) return ay < by ? -1 : 1;
        return a._index - b._index;
    });

    return list.map(({ _index, ...row }) => row);
}

module.exports = { priceRows };
