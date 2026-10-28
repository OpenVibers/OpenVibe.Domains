#!/usr/bin/env node
'use strict';

/**
 * Runs every test/*.test.js in its own process and fails if any fails. The tests use stub Host and
 * Tools clients; none needs the network or a running site.
 *
 *   npm test                 # everything
 *   npm test -- routes       # only files whose name contains the word
 *   npm test -- --strict     # a skipped test fails the run too
 */
const { run } = require('openvibe-shared/test-runner');

run({ dir: __dirname, timeoutMs: 60_000, pad: 34, parallel: 1 }).then((r) => {
    if (process.env.VERBOSE) {
        for (const t of r.results) console.log(`\n── ${t.file} ──\n${t.output.trimEnd()}`);
        console.log(`\n${r.summary}`);
    }
    process.exit(r.exitCode);
}, (err) => {
    console.error(err);
    process.exit(1);
});
