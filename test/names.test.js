'use strict';

/** The name reader: the inputs from the brief, IDNs, URLs, and the ones that must be refused. */
const assert = require('assert');
const { parseName, parseTld } = require('../server/names');
const { check, done } = require('./helpers');

(async () => {
    await check('a bare label: spaces go, no ending', () => {
        assert.deepStrictEqual(parseName('sushi truck'), { label: 'sushitruck', tld: null, ascii: 'sushitruck', display: 'sushitruck' });
        assert.deepStrictEqual(parseName('x y z'), { label: 'xyz', tld: null, ascii: 'xyz', display: 'xyz' });
        assert.deepStrictEqual(parseName('Sushi_Truck'), { label: 'sushitruck', tld: null, ascii: 'sushitruck', display: 'sushitruck' });
    });

    await check('a name with .com is lower-cased and keeps its ending', () => {
        assert.deepStrictEqual(parseName('SushiTruck.com'), {
            label: 'sushitruck', tld: 'com', ascii: 'sushitruck.com', display: 'sushitruck.com',
        });
    });

    await check('a URL: scheme, www, path and port are dropped, co.uk stays co.uk', () => {
        assert.deepStrictEqual(parseName('https://www.sushitruck.co.uk/x'), {
            label: 'sushitruck', tld: 'co.uk', ascii: 'sushitruck.co.uk', display: 'sushitruck.co.uk',
        });
        assert.deepStrictEqual(parseName('http://example.com:8080/a?b=1#c'), {
            label: 'example', tld: 'com', ascii: 'example.com', display: 'example.com',
        });
    });

    await check('an IDN is punycode in ascii and Unicode in display', () => {
        assert.deepStrictEqual(parseName('münchen.de'), {
            label: 'xn--mnchen-3ya', tld: 'de', ascii: 'xn--mnchen-3ya.de', display: 'münchen.de',
        });
    });

    await check('bad names are null', () => {
        for (const bad of ['-x.com', 'a..b', `${'a'.repeat(64)}.com`, '', 'http://', 'http:///x', 'x-.com', 'a'.repeat(254)]) {
            assert.strictEqual(parseName(bad), null, `expected null for ${JSON.stringify(bad.slice(0, 30))}`);
        }
    });

    await check('a name may start with a digit and contain an internal hyphen', () => {
        assert.deepStrictEqual(parseName('1-2.dev'), {
            label: '1-2', tld: 'dev', ascii: '1-2.dev', display: '1-2.dev',
        });
    });

    await check('parseTld normalizes a leading dot and keeps a multi-part ending', () => {
        assert.strictEqual(parseTld('.Dev'), 'dev');
        assert.strictEqual(parseTld('co.uk'), 'co.uk');
        assert.strictEqual(parseTld(' .co.uk '), 'co.uk');
        assert.strictEqual(parseTld('https://example.dev/path'), 'example.dev');
    });

    await check('parseTld refuses empty and malformed endings', () => {
        for (const bad of ['', '.', '..', '-x', 'x-', 'a..b', 'a'.repeat(64)]) {
            assert.strictEqual(parseTld(bad), null, `expected null for ${JSON.stringify(bad)}`);
        }
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
