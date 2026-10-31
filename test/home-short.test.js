'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the questions and the API samples are folds, closed
 * on a phone and open where there is room, and the endings are one sideways row. Everything stays in the page for the
 * crawlers.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers');

(async () => {
    const t = await boot();
    try {
        await check('the questions and the API samples are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            for (const id of ['faq-fold', 'dev-fold']) {
                assert.ok(r.text.includes(`<details class="hm-fold hm-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(!r.text.includes(`document.getElementById("${id}")`), `${id} is never closed by script`);
            }
            // The content of the folds stays in the page.
            assert.match(r.text, /Where do the prices come from\?/);
            assert.match(r.text, /Price a name/);
            assert.ok(r.text.includes('<section class="sc-sec" id="faq"') || r.text.includes('aria-labelledby="sc-questions"'), 'the questions keep their section');
        });

        await check('the CSS guard: the folds are closed on a phone only, and the endings are one row', async () => {
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'domains.css'), 'utf8');
            assert.match(css, /\.hm-fold-block > summary \{[^}]*min-height: 44px/, 'a fold is a 44 px target');
            assert.match(css, /@media \(max-width: 599px\) \{\s*\.dm-board \{ display: flex; overflow-x: auto;/, 'the endings are one sideways row on a phone');
            assert.match(css, /\.dm-board > li \{ flex: 0 0/, 'every ending keeps its place in the row');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
