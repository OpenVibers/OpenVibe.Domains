'use strict';

/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready). There is no database and no
 * session store: the only dependencies are the two public services this front reads.
 *
 * Both checks are optional. If OpenVibe.Host or OpenVibe.Tools does not answer, the process is
 * still serving (there is a page, even if it says the upstream failed), so the answer is 200 with
 * status "degraded" — never 503. A failed check is named in `degraded`.
 */
const { createReadiness } = require('openvibe-shared/ready');

function createServiceReadiness({ host, tools, release = null }) {
    return createReadiness({
        service: 'domains',
        release,
        checks: [
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
