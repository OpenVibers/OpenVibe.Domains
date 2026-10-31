'use strict';

/**
 * OpenVibe.Domains — process entry. `node server/index.js` listens on PORT (5070) behind nginx (deploy/). At boot a
 * proposal a stop left mid-apply is marked failed (panel.recover), the Network keys are warmed after listen, and the two
 * account subscriptions are created at Events when missing (never in a drill). The stop closes them and the store.
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startSubscriptions } = require('openvibe-sdk/account-data');

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
        close: [
            () => { if (ctx && ctx.subscriptions) ctx.subscriptions.stop(); },
            () => { if (ctx && ctx.store) return ctx.store.close(); return undefined; },
        ],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;
    const recovered = await ctx.panel.recover();
    if (recovered) console.warn(`[OpenVibe.Domains] ${recovered} proposal(s) were left applying by the last stop: marked failed for their people to check`);
    // Socket activation (2026-10-31): systemd's .socket unit holds the listener across restarts, so a deploy
    // queues requests in the kernel instead of answering 502. Without the socket unit, the usual listen.
    const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
    const server = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), () => {
        console.log(`[OpenVibe.Domains] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (host ${config.hostUrl}, tools ${config.toolsUrl})`);
        // Warm the Network signing keys once listening, so readiness and the first signed-in page do not wait.
        if (ctx.keys.ensure) ctx.keys.ensure().catch(() => {});
    });
    if (!config.drill && config.events.url && config.events.secrets.length && config.oauth.clientSecret) {
        ctx.subscriptions = startSubscriptions({
            eventsUrl: config.events.url, endpoint: config.events.endpoint || `http://127.0.0.1:${config.port}/internal/events`,
            secret: config.events.secrets[0], networkInternalUrl: config.networkInternalUrl,
            clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        });
    }
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
