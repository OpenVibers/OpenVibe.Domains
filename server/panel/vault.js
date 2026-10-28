'use strict';

/**
 * Where a connection's credential lives: a Network project secret (ADR-056), never this service's database.
 *
 *   as the person (their own Network token; Network's developer API, server/developer/routes.js):
 *     projectFor(token)                         their "OpenVibe.Domains" project, created the first time
 *     store(token, project, name, value, origin) set the secret, then grant `domains` reveal to `origin` only
 *     remove(token, project, name)              delete it (its grants go with it)
 *   as this service (network.secret.use, a client-credentials token; POST /internal/secrets/use):
 *     reveal(project, name, origin)             the value, for one call to `origin`; never cached, logged or returned
 *
 * Network answers 404 secret.not_found for anything it refuses (a removed secret, a revoked grant, another origin),
 * so a broken connection reads the same whatever the reason.
 */
const { serviceAuth } = require('openvibe-contracts');

const PROJECT_NAME = 'OpenVibe.Domains';
const ENVIRONMENT = 'production';

class VaultError extends Error {
    constructor(status, message, code = 'vault.error') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function createVault({ config, fetchImpl = globalThis.fetch, timeoutMs = 8000, tokens = null } = {}) {
    const base = String(config.networkInternalUrl).replace(/\/+$/, '');
    const serviceTokens = tokens || (config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'network.secret.use', fetchImpl,
    }) : null);

    async function asPerson(token, method, path, body) {
        let res;
        try {
            res = await fetchImpl(`${base}/api/v1/projects${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch {
            throw new VaultError(503, 'OpenVibe.Network did not answer. Try again in a moment.', 'vault.unavailable');
        }
        const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
        if (res.ok) return data;
        const words = (data && (data.detail || data.title)) || `OpenVibe.Network answered ${res.status}.`;
        if (res.status === 401) throw new VaultError(401, 'Your sign-in has ended. Sign in again.', 'vault.signed_out');
        if (res.status === 503 && data && data.code === 'secrets.unavailable') throw new VaultError(503, 'Network\'s secret store is not available right now.', 'vault.unavailable');
        throw new VaultError(res.status >= 500 ? 502 : res.status, String(words).slice(0, 300), 'vault.refused');
    }

    return {
        ENVIRONMENT,
        PROJECT_NAME,
        async projectFor(token) {
            const list = await asPerson(token, 'GET', '/');
            const mine = (Array.isArray(list.projects) ? list.projects : []).find((p) => p && p.name === PROJECT_NAME && p.role === 'owner' && !p.archived_at);
            if (mine) return mine.id;
            const created = await asPerson(token, 'POST', '/', { name: PROJECT_NAME });
            if (!created || !created.id) throw new VaultError(502, 'OpenVibe.Network did not create the project.', 'vault.refused');
            return created.id;
        },
        async store(token, projectId, name, value, origin) {
            const path = `/${encodeURIComponent(projectId)}/secrets/${ENVIRONMENT}/${encodeURIComponent(name)}`;
            await asPerson(token, 'PUT', path, { value });
            await asPerson(token, 'PUT', `${path}/grants/domains`, { purposes: ['reveal'], origins: [origin] });
        },
        async remove(token, projectId, name) {
            try {
                await asPerson(token, 'DELETE', `/${encodeURIComponent(projectId)}/secrets/${ENVIRONMENT}/${encodeURIComponent(name)}`);
            } catch (err) {
                if (err.status !== 404) throw err;   // already gone
            }
        },
        async reveal(projectId, name, origin) {
            if (!serviceTokens) throw new VaultError(503, 'This service has no Network credentials (OV_OAUTH_CLIENT_SECRET).', 'vault.unconfigured');
            let res;
            try {
                res = await fetchImpl(`${base}/internal/secrets/use`, {
                    method: 'POST',
                    headers: { accept: 'application/json', 'content-type': 'application/json', ...(await serviceTokens.authHeaders()) },
                    body: JSON.stringify({ project_id: projectId, environment: ENVIRONMENT, name, purpose: 'reveal', origin }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch {
                throw new VaultError(503, 'OpenVibe.Network did not answer. Try again in a moment.', 'vault.unavailable');
            }
            const data = await res.json().catch(() => ({}));
            if (res.ok && typeof data.value === 'string' && data.value) return data.value;
            if (res.status === 404) throw new VaultError(409, 'This connection\'s token is gone or no longer granted to OpenVibe.Domains. Connect it again.', 'vault.secret_missing');
            throw new VaultError(503, 'Network\'s secret store did not answer. Try again in a moment.', 'vault.unavailable');
        },
    };
}

module.exports = { createVault, VaultError, PROJECT_NAME, ENVIRONMENT };
