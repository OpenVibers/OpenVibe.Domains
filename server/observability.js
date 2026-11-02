'use strict';

/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready). The control panel's database is required: without it
 * the panel cannot serve, so the answer is 503. The two public services the price pages read are optional: if
 * OpenVibe.Host or OpenVibe.Tools does not answer, the pages still say so, and the answer is 200 "degraded".
 */
const { createReadiness } = require('openvibe-shared/ready');

function createServiceReadiness({ host, tools, store = null, release = null, sso}) {
    return createReadiness({
        service: 'domains',
        release,
        checks: [
            {
                // Does the Network accept this site's OAuth client? 'invalid' means the id or the secret is wrong:
                // the service must not stay ready on a sign-in that cannot work. 'unknown' (the Network did not
                // answer) is left alone: that is the Network's outage, not this site's configuration.
                name: 'sso_client', required: true,
                check: async () => {
                    if (!sso || typeof sso.checkClient !== 'function') return { skipped: 'no SSO client' };
                    const client = await sso.checkClient();
                    if (client === 'invalid') return "the Network refuses this site's OAuth client: check OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET";
                    return true;
                },
            },
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
