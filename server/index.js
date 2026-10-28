'use strict';

/**
 * OpenVibe.Domains — process entry. `node server/index.js` listens on PORT (5070) behind nginx
 * (deploy/). Stateless: nothing to close but the HTTP server.
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');

/**
 * The process stop (openvibe-sdk/service): stop taking connections, drain the requests in
 * flight, exit. Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals } = {}) {
    return gracefulStop({
        name: 'OpenVibe.Domains',
        server,
        deadlineExitCode: 0,
        exit,
        signals,
        deadlineMs: 10_000,
        close: [],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;
    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.Domains] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (host ${config.hostUrl}, tools ${config.toolsUrl})`);
    });
    server.keepAliveTimeout = 65_000;
    createLifecycle({ server, ctx });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => {
        console.error('[OpenVibe.Domains] failed to start:', err);
        process.exit(1);
    });
}

module.exports = { start, createLifecycle };
