'use strict';

/**
 * OpenVibe.Domains' own PostgreSQL database (ADR-035, ov_domains): the schema is migrations/NNNN_*.sql, applied at
 * boot. It holds the control panel's connections, synced zones, proposals and their audit. No credential is ever
 * written here: a provider token is a Network project secret (ADR-056), and only its name is kept.
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh domains)');
        const dir = config.db.pgliteDir || DEV_PGLITE;
        log.warn(`[OpenVibe.Domains] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'domains', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'domains-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'domains', registry, log });
}

/** The store every module takes: the db handle, a clock (epoch ms; tests inject one), ids and transactions. */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        iso: () => new Date(now()).toISOString(),
        newId: (prefix) => {
            if (prefix === 'event') return `evt_${require('openvibe-contracts').ids.ulid(now())}`;
            return `${prefix}_${require('openvibe-contracts').ids.ulid(now())}`;
        },
        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

module.exports = { openDb, openStore, createStore, MIGRATIONS };
