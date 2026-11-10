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
                assert.ok(r.text.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
            }
            // The content of the folds stays in the page.
            assert.match(r.text, /Where do the prices come from\?/);
            assert.match(r.text, /Price a name/);
            assert.ok(r.text.includes('<section class="sc-sec" id="faq"') || r.text.includes('aria-labelledby="sc-questions"'), 'the questions keep their section');
        });

        await check('each fold summary says what it holds, and only its count is hidden on a wide screen', async () => {
            const r = await t.get('/');
            const folds = [...r.text.matchAll(/<details class="hm-fold hm-fold-block" id="([^"]+)"[^>]*>([\s\S]*?)<\/details>/g)];
            assert.ok(folds.length >= 2, 'the home has the questions and API folds');
            for (const [, id, inner] of folds) {
                const summary = /<summary>([\s\S]*?)<\/summary>/.exec(inner);
                assert.ok(summary, `${id} has a summary`);
                assert.match(summary[1], /<span class="hm-fold-n">/, `${id} marks its count, so the stylesheet can hide only the count`);
                const words = summary[1]
                    .replace(/<span class="hm-fold-n">[\s\S]*?<\/span>/g, '')
                    .replace(/<span[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&[^;]+;/g, ' ')
                    .replace(/\s+/g, ' ').trim();
                assert.ok(words.length > 2, `${id} names what it holds in words ("${words}")`);
            }
            // The wide-screen rule hides the count only; a rule for every span would hide the heading's own words.
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'domains.css'), 'utf8');
            assert.ok(!/\.hm-fold-block > summary span\s*\{[^}]*display:\s*none/.test(css), 'no rule hides every span in a fold summary');
            assert.match(css, /\.hm-fold-block > summary \.hm-fold-n\s*\{[^}]*display:\s*none/, 'the wide-screen rule hides the count');
        });

        await check('the hero is one name priced, not sc.room\'s default motif (MOTION-1)', async () => {
            const r = await t.get('/');
            assert.match(r.text, /<div class="dm-motif" aria-hidden="true">/);
            assert.match(r.text, /sushitruck\.dev[\s\S]*?cheapest to keep[\s\S]*?renews high/);
            assert.ok(!/class="sc-room-motif"/.test(r.text), 'no default motif');
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
