'use strict';
// What openvibe.domains tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the open JSON API under /api/v1 and the developers page that
// documents it. No OpenAPI document or MCP endpoint is published.
module.exports = {
    id: 'domains',
    name: 'OpenVibe.Domains',
    purpose: 'Price a domain name across every ending and registrar, with real one-, three- and five-year totals and the renewal traps in plain sight, plus public registration history.',
    home: 'https://openvibe.domains',
    site: 'openvibe.domains',
    api: '/api/v1',
    docs: '/developers',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '120 API and name-query requests a minute per address; pages are not rate limited',
    },
};
