'use strict';

/**
 * express.Router() whose get/post handlers may be async: a rejected promise goes to next(err)
 * instead of becoming an unhandled rejection. (The same helper OpenVibe.Help carries.)
 */
const express = require('express');

function asyncRouter() {
    const r = express.Router();
    for (const method of ['get', 'post']) {
        const orig = r[method].bind(r);
        r[method] = (path, ...handlers) => orig(path, ...handlers.map((h) => (h.length === 4 ? h : (req, res, next) => {
            try {
                const out = h(req, res, next);
                if (out && typeof out.catch === 'function') out.catch(next);
            } catch (err) { next(err); }
        })));
    }
    return r;
}

module.exports = { asyncRouter };
