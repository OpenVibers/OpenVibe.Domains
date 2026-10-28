'use strict';

/**
 * Account export and deletion → Domains (ADR-033; openvibe-sdk/account-data). What Domains holds about a person is
 * their control panel: connections (a provider, a label and the NAME of the Network project secret holding the token,
 * never the token), the zones those connections hold, their proposals and the audit of what was done. The token itself
 * is a secret in the person's own Network project, which Network's own deletion shreds.
 *
 * Erasing goes proposals and audit first, then connections (their zones go with them, ON DELETE CASCADE).
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'domains_proposals', subject: 'subject', file: 'proposals.json', erase: 'delete' },
    { table: 'domains_audit', subject: 'subject', file: 'audit.json', order: 'at', erase: 'delete' },
    { table: 'domains_connections', subject: 'subject', file: 'connections.json', erase: 'delete' },
];

/** The zones the person's connections hold (they have no subject column of their own). */
async function extraExport(db, subject) {
    const zones = await db.many(`SELECT z.connection_id, z.zone_id, z.name, z.status, z.name_servers, z.plan, z.synced_at FROM domains_zones z
        JOIN domains_connections c ON c.id = z.connection_id WHERE c.subject = $1 ORDER BY z.name`, [subject]);
    return zones.length ? [{ name: 'zones.json', content: zones }] : [];
}

function create({ db, log = console } = {}) {
    return createAccountData({
        db,
        service: 'domains',
        tables: TABLES,
        note: 'Provider tokens are not here: they are secrets in your own OpenVibe.Network project.',
        extraExport,
        log,
    });
}

module.exports = { create, TABLES, TOPICS };
