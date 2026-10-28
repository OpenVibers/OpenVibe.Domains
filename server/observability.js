'use strict';

/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready). The control panel's database is required: without it
 * the panel cannot serve, so the answer is 503. The two public services the price pages read are optional: if
 * OpenVibe.Host or OpenVibe.Tools does not answer, the pages still say so, and the answer is 200 "degraded".
 */
const { createReadiness } = require('openvibe-shared/ready');

function createServiceReadiness({ host, tools, store = null, release = null }) {
    return createReadiness({
        service: 'domains',
        release,
        checks: [
            ...(store ? [{
                name: 'db',
                required: true,
                check: async () => ((await store.db.value('SELECT 1 AS n')) === 1 ? true : 'the database did not answer'),
            }] : []),
            {
                name: 'host',
                required: false,
                check: async () => {
                    const list = await host.tlds({ sort: 'popular', fresh: true });
                    return list ? true : 'OpenVibe.Host did not answer';
                },
            },
            {
                name: 'tools',
                required: false,
                check: async () => {
                    const lists = await tools.lists({ limit: 1, fresh: true });
                    return lists ? true : 'OpenVibe.Tools did not answer';
                },
            },
        ],
    });
}

module.exports = { createServiceReadiness };
