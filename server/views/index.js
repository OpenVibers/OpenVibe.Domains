'use strict';
/**
 * The Domains room's pages (plan 2026-10-28 §5.1). Server-rendered and whole without JavaScript; the Frame (navbar,
 * theme, footer) comes from openvibe-shared/shell, the room's front door from sc.room() and its accent from rooms.js.
 * server/http/pages.js builds each model from OpenVibe.Host's price catalog and OpenVibe.Tools' history; nothing here
 * invents a number: a price, a total or a date is shown only when the catalog has it, with where and when it came from.
 *
 *   home({ endings, lists, canonical })              endings: the catalog's list ({ tlds: [...] }) or null
 *   endings({ endings, canonical })                  every ending, cheapest to keep first
 *   search({ name, check, rows, available, canonical })
 *   tld({ tld, canonical })                          tld: the catalog's ending with priced registrar rows
 *   domain({ name, history, prices, status, canonical })
 *   notFound()
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const shell = require('openvibe-shared/shell');
const ovServe = require('openvibe-shared/serve');
const appIcon = require('openvibe-shared/app-icon');
const kit = require('openvibe-shared/kit');
const sc = require('openvibe-shared/showcase');
const rooms = require('openvibe-shared/rooms');
const { priceRows } = require('../pricing');

const NAME = 'OpenVibe.Domains';
const NETWORK = 'https://openvibe.network';
const ROOM = rooms.get('domains');
const esc = kit.esc;
const PUBLIC = path.join(__dirname, '..', '..', 'public');

const hashes = new Map();
function asset(rel) {
    if (!hashes.has(rel)) {
        let v = 'dev';
        try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, rel))).digest('hex').slice(0, 10); } catch { /* missing in a test */ }
        hashes.set(rel, v);
    }
    return `/${rel}?v=${hashes.get(rel)}`;
}

let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

// Money as people read it: $9.20, $1,240; a null is a dash (never 0).
const money = (n, cur = 'USD') => (n == null || !Number.isFinite(Number(n)) ? '—' : cur === 'USD'
    ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${esc(cur)}`);
const day = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''; };
const dot = (tld) => `.${String(tld || '').replace(/^\./, '')}`;
const tldHref = (tld) => `/tld/${encodeURIComponent(String(tld).replace(/^\./, ''))}`;
const latest = (rows) => rows.map((r) => r.checked_at).filter(Boolean).sort().pop() || null;

const NAV = [
    { label: 'Price a name', href: '/', icon: 'fa-magnifying-glass' },
    { label: 'Every ending', href: '/tld', icon: 'fa-list' },
    { label: 'Control panel', href: '/panel', icon: 'fa-server' },
    { label: 'API', href: '/developers', icon: 'fa-code', more: true },
];

/** The page around a body: the shared shell with the room's stylesheets and behaviour. */
function layout({ title, description, canonical, robots = 'index, follow', body, active = '/', jsonLd = [], agentLayer = false }) {
    const navbar = {
        service: 'domains',
        apiBase: NETWORK,
        links: NAV.map((l) => ({ ...l, active: l.href === active })),
        appBar: [{ label: 'Price', href: '/', icon: 'fa-magnifying-glass' }, { label: 'Endings', href: '/tld', icon: 'fa-list' }, { label: 'Panel', href: '/panel', icon: 'fa-server' }],
        // Sign-in with OpenVibe.Network (server/auth/sso.js): the control panel is a person's own.
        silentLogin: '/auth/login?silent=1&next={url}',
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
        search: { page: '/search', label: NAME },
        history: { type: 'page', title: title || NAME },
    };
    const footer = { service: 'domains', variant: 'full', mount: '#ov-footer', brandName: NAME };
    return shell.page({
        name: NAME,
        lang: 'en',
        title: title || `${NAME}: ${ROOM.line}`,
        titleSuffix: title ? ` · ${NAME}` : '',
        siteName: NAME,
        description: description || `${ROOM.line}. Every ending and registrar for a name, with what you will really pay over 1, 3 and 5 years.`,
        canonical,
        agentLayer,
        robots,
        jsonLd,
        home: '/',
        navLinks: NAV,
        navbar,
        footer,
        head: `${appIcon.headTags({ site: 'domains' })}
<link rel="stylesheet" href="${esc(ovServe.url('kit.css'))}">
<link rel="stylesheet" href="${esc(ovServe.url('room.css'))}">
<link rel="stylesheet" href="${esc(ovServe.url('showcase.css'))}">
<link rel="stylesheet" href="${asset('css/domains.css')}">
<script src="${esc(ovServe.url('kit-web.js'))}" defer></script>
<script src="${esc(ovServe.url('motion.js'))}" defer></script>
<meta name="ov-boost" content="domains@${esc(RELEASE)}">`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<main id="main" class="dm ov-room" style="${rooms.style('domains')}">${body}</main>
<script>window.__OV_PAGE = ${JSON.stringify({ navbar, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () { try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* optional */ } });</script>`,
    });
}

/** The box that prices a name (the home's is the room hero's; every other page has this one). */
const searchBox = (value = '') => `<form class="dm-box" role="search" method="get" action="/search"><label class="sc-sr" for="dm-q">A name to price</label>`
    + `<input id="dm-q" type="search" name="q" value="${esc(value)}" placeholder="Price a name, like sushitruck" autocomplete="off" spellcheck="false" enterkeyhint="search" maxlength="253">`
    + `<button type="submit" aria-label="Price it">${kit.icon('forward')}</button></form>`;

/** One ending as a tile on the board: the ending, the first year, what three years really cost, a trap warning. */
function tile(r) {
    return `<li><a class="dm-tile${r.trap ? ' is-trap' : ''}" href="${tldHref(r.tld)}"><span class="dm-tile-tld">${esc(r.display || dot(r.tld))}</span>`
        + `<span class="dm-tile-y3"><b>${money(r.y3, r.currency)}</b><small>3 years</small></span>`
        + `<span class="dm-tile-y1">${money(r.y1, r.currency)} first year</span>`
        + `${r.trap ? `<span class="dm-trap">Renews at ${money(Number(r.renew), r.currency)}</span>` : r.registrars > 1 ? `<span class="dm-tile-n">${Number(r.registrars)} registrars</span>` : ''}</a></li>`;
}

/** A renewal trap drawn: the first year beside each renewal, with the 3-year total (real numbers from the catalog). */
function trapPicture(r) {
    const max = Math.max(Number(r.register), Number(r.renew));
    const bar = (v, label, cls) => `<div class="dm-bar ${cls}"><span style="--h:${Math.max(6, Math.round((Number(v) / max) * 100))}%"></span><b>${money(v, r.currency)}</b><small>${label}</small></div>`;
    return `<figure class="dm-trap-fig" aria-label="${esc(`${r.display || dot(r.tld)}: ${money(r.y1)} the first year, then ${money(Number(r.renew))} a year`)}">`
        + `<div class="dm-bars">${bar(r.register, 'Year 1', 'is-first')}${bar(r.renew, 'Year 2', '')}${bar(r.renew, 'Year 3', '')}</div>`
        + `<figcaption><span class="dm-fig-tld">${esc(r.display || dot(r.tld))}</span> looks like ${money(r.y1, r.currency)}. Three years cost <b>${money(r.y3, r.currency)}</b>.</figcaption></figure>`;
}

/** How a 3-year total is made, with one ending's real prices. */
function totalPicture(r) {
    return `<div class="dm-sum" aria-label="${esc(`How three years of ${r.display || dot(r.tld)} add up`)}">`
        + `<div><small>First year</small><b>${money(r.y1, r.currency)}</b></div><i aria-hidden="true">+</i>`
        + `<div><small>2 renewals</small><b>${money(2 * Number(r.renew), r.currency)}</b></div><i aria-hidden="true">=</i>`
        + `<div class="is-total"><small>${esc(r.display || dot(r.tld))} for 3 years</small><b>${money(r.y3, r.currency)}</b></div></div>`;
}

function home({ endings, lists, canonical } = {}) {
    // The home's board shows the endings people mean (generic and country codes), not second-level ones like
    // augustow.pl or punycode endings, which are on /tld.
    const rows = priceRows((endings && endings.tlds) || []).filter((r) => !r.currency_other && r.y3 != null && !String(r.tld).includes('.') && !/^xn--/.test(String(r.tld)));
    const all = priceRows((endings && endings.tlds) || []);
    const registrars = rows.reduce((m, r) => Math.max(m, Number(r.registrars) || 0), 0);
    const checked = latest(rows);
    const popular = ['com', 'dev', 'ai', 'io', 'app', 'net', 'org', 'co'].map((t) => rows.find((r) => r.tld === t)).filter(Boolean).slice(0, 5);
    const trap = rows.filter((r) => r.trap).sort((a, b) => (Number(b.renew) / Number(b.register)) - (Number(a.renew) / Number(a.register)))[0];
    const com = rows.find((r) => r.tld === 'com') || rows[0];
    const board = rows.length ? `<section class="dm-board-sec" aria-labelledby="dm-board-h"><div class="dm-head-row"><h2 id="dm-board-h">Cheapest to keep</h2><a class="dm-more" href="/tld">Every ending${kit.icon('chevron')}</a></div>`
        + `<p class="dm-fine">Sorted by what three years really cost, not the first-year price.${checked ? ` Prices checked ${esc(day(checked))}.` : ''}</p>`
        + `<ul class="dm-board">${rows.slice(0, 12).map(tile).join('')}</ul></section>` : '';
    const looked = lists && Array.isArray(lists.most_looked_up) ? lists.most_looked_up.slice(0, 8) : [];
    const lookedHTML = looked.length ? `<section class="dm-looked" aria-labelledby="dm-looked-h"><h2 id="dm-looked-h">Looked up most</h2><ul class="dm-chips">${looked.map((d) => `<li><a href="/d/${encodeURIComponent(d.domain || d.name || '')}">${esc(d.domain || d.name || '')}</a></li>`).join('')}</ul></section>` : '';
    const body = sc.room({
        room: 'domains',
        hero: {
            title: ROOM.line,
            lede: 'Type a name. See every ending and every registrar, with what you will really pay over one, three and five years, and the renewal traps flagged.',
            search: { action: '/search', name: 'q', placeholder: 'Price a name, like sushitruck', label: 'A name to price', button: 'Price it', hints: ['sushitruck', 'mybrand.dev', 'cozy cafe', 'pixel.studio'] },
            chips: popular.map((r) => ({ label: r.display || dot(r.tld), href: tldHref(r.tld) })),
        },
        proof: [
            { value: all.length, label: all.length === 1 ? 'ending priced' : 'endings priced', asOf: checked ? day(checked) : null },
            { value: registrars, label: registrars === 1 ? 'registrar compared' : 'registrars compared' },
        ].filter((p) => p.value),
        html: board + lookedHTML,
        scenes: [
            trap ? { title: 'The renewal trap, in plain sight', text: `A cheap first year is how many endings are sold. ${trap.display || dot(trap.tld)} starts at ${money(trap.y1)} and renews at ${money(Number(trap.renew))}: every page here sorts by what you keep paying.`, html: trapPicture(trap), action: { href: tldHref(trap.tld), label: `See ${trap.display || dot(trap.tld)}` } } : null,
            com ? { title: 'One honest number: three years', text: 'The first year plus two renewals, from each registrar\'s own public price list, with the date it was read. Five years is on every page too.', html: totalPicture(com), action: { href: tldHref(com.tld), label: `Every registrar for ${com.display || dot(com.tld)}` } } : null,
        ].filter(Boolean),
        explore: { title: 'More on Domains', items: [
            { title: 'Every ending', text: 'All the endings OpenVibe prices, cheapest to keep first', href: '/tld', icon: 'ov:dns' },
            { title: 'Look up a domain', text: 'Its public record: registrar, dates and how they changed', href: '/d/openvibe.live', icon: 'ov:history' },
            { title: 'Hosting prices', text: 'Servers and plans compared on OpenVibe.Host', href: 'https://openvibe.host/catalog', icon: 'ov:host' },
        ] },
        dev: { title: 'For developers', lede: 'Every price and check is open JSON, readable from any site.', samples: [
            { label: 'Price a name', lang: 'bash', code: 'curl "https://openvibe.domains/api/v1/search?q=sushitruck"' },
            { label: 'One ending, every registrar', lang: 'bash', code: 'curl https://openvibe.domains/api/v1/tlds/dev' },
        ], links: [{ label: 'The API', href: '/developers' }, { label: 'llms.txt', href: '/llms.txt' }] },
        faq: { items: [
            ['Where do the prices come from?', 'From each registrar\'s own public price list, read by OpenVibe and dated on every page. Nothing is sponsored, and no registrar pays to be listed or to be first.'],
            ['Can I register a domain here?', 'Not yet: each price links to the registrar that offers it. Connecting your own registrar accounts to manage your domains in one place comes next.'],
            ['Why three years?', 'Many endings are cheap for one year and much dearer to keep. Three years (the first year and two renewals) is the number that tells you what a name will really cost.'],
            ['Is a name I search for kept?', 'Searches are not tied to you. A domain\'s public history is kept only after it has been looked up five times, and holds public registration facts only.'],
        ] },
    });
    return layout({ agentLayer: true, title: null, canonical, body: `<div class="dm-wrap">${body}</div>`, active: '/', jsonLd: [{ '@context': 'https://schema.org', '@type': 'WebSite', name: NAME, url: 'https://openvibe.domains/', potentialAction: { '@type': 'SearchAction', target: 'https://openvibe.domains/search?q={name}', 'query-input': 'required name=name' } }] });
}

/** A table of priced rows: ending or registrar first, then the year totals, sorted by 3 years. */
function priceTable(rows, { by = 'ending', label = '', check = null } = {}) {
    if (!rows.length) return '';
    const best = rows.length > 1 ? rows.find((r) => !r.currency_other && r.y3 != null) : null;
    const head = by === 'ending' ? 'Ending' : 'Registrar';
    const cell = (r) => {
        if (by === 'ending') return check ? `<a href="/search?q=${encodeURIComponent(`${check}.${r.tld}`)}" title="${esc(`Check ${check}.${r.tld}`)}">${esc(r.display || dot(r.tld))}</a>` : `<a href="${tldHref(r.tld)}">${esc(r.display || dot(r.tld))}</a>`;
        const href = r.affiliate_url || r.homepage_url;
        return href ? `<a href="${esc(href)}" rel="noopener${r.affiliate_url ? ' sponsored' : ''}">${esc(r.registrar)}</a>${r.affiliate_url ? '<small class="dm-aff">Affiliate link</small>' : ''}` : esc(r.registrar || '');
    };
    return `<div class="dm-table" role="table" aria-label="${esc(label || 'Prices')}"><div class="dm-tr dm-th" role="row"><span role="columnheader">${head}</span><span role="columnheader">First year</span><span role="columnheader">Renews at</span><span role="columnheader">3 years</span><span role="columnheader">5 years</span></div>`
        + rows.map((r) => `<div class="dm-tr${r === best ? ' is-best' : ''}${r.trap ? ' is-trap' : ''}" role="row"><span role="cell" class="dm-name">${cell(r)}${r === best ? '<em class="dm-best">Cheapest over 3 years</em>' : ''}${r.trap ? '<em class="dm-trap">Renewal trap</em>' : ''}</span>`
            + `<span role="cell" data-l="First year">${money(r.y1, r.currency)}</span><span role="cell" data-l="Renews at">${money(r.renew == null ? null : Number(r.renew), r.currency)}</span>`
            + `<span role="cell" data-l="3 years" class="dm-y3">${money(r.y3, r.currency)}</span><span role="cell" data-l="5 years">${money(r.y5, r.currency)}</span></div>`).join('')
        + '</div>';
}

const STATUS = {
    available: ['is-free', 'Available to register'],
    registered: ['is-taken', 'Registered'],
    reserved: ['is-taken', 'Reserved by the registry'],
};

function search({ name, check, rows = [], available } = {}) {
    const full = check && check.display ? check.display : name ? (name.display || name.ascii) : '';
    const [cls, said] = STATUS[available] || ['is-unknown', 'The registry did not answer'];
    const facts = check && available === 'registered' ? [check.registrar ? `with ${esc(check.registrar)}` : '', check.expires ? `until ${esc(day(check.expires))}` : ''].filter(Boolean).join(' ') : '';
    const label = name ? name.label : '';
    const body = `<section class="dm-q">${searchBox(name ? (name.display || name.ascii) : '')}</section>
<header class="dm-hit ${cls}"><h1>${esc(full)}</h1><p class="dm-status"><span class="dm-pill">${said}</span>${facts ? ` <span>${facts}</span>` : ''}</p>
${available === 'registered' && check ? `<p class="dm-act"><a class="dm-btn" href="/d/${encodeURIComponent(check.name || name.ascii)}">Its public history</a> <a class="dm-btn is-quiet" href="https://openvibe.watch/watches/new?template=json&amp;url=${encodeURIComponent(`https://openvibe.domains/api/v1/domains/${check.name || name.ascii}`)}&amp;value_path=status&amp;op=changed&amp;name=${encodeURIComponent(`${check.name || name.ascii} comes free`)}">Tell me if it comes free</a></p>` : ''}</header>
${rows.length ? `<section aria-labelledby="dm-all-h"><div class="dm-head-row"><h2 id="dm-all-h">${esc(label)} in every ending</h2></div>
<p class="dm-fine">What each ending costs to register and keep, cheapest over three years first. Availability is checked for <b>${esc(full)}</b>; tap another ending to check it.${latest(rows) ? ` Prices checked ${esc(day(latest(rows)))}.` : ''}</p>
${priceTable(rows, { by: 'ending', label: `${label} in every ending`, check: name ? name.label : null })}</section>` : '<p class="dm-fine">No prices for this name\'s endings yet.</p>'}`;
    return layout({ agentLayer: true, title: `${full}: price and availability`, description: `${full}: whether it is free, and what every ending costs over 1, 3 and 5 years.`, robots: 'noindex, follow', body: `<div class="dm-wrap">${body}</div>`, active: '/' });
}

function endings({ endings: list } = {}) {
    const rows = priceRows((list && list.tlds) || []);
    const body = `<header class="dm-page-h"><h1>Every ending</h1><p class="dm-lede">All the endings OpenVibe prices, cheapest to keep over three years first.${latest(rows) ? ` Prices checked ${esc(day(latest(rows)))}.` : ''}</p>${searchBox()}</header>
${rows.length ? priceTable(rows, { by: 'ending', label: 'Every ending' }) : kit.empty({ title: 'No prices yet', text: 'The price lists are being read. Try again in a few minutes.' })}`;
    return layout({ agentLayer: true, title: 'Every ending, cheapest to keep', description: 'Every domain ending OpenVibe prices, sorted by what three years really cost.', body: `<div class="dm-wrap">${body}</div>`, active: '/tld' });
}

/** A small history chart: each registrar's first-year price over time, as steps (real changes only). */
function historyChart(history, currency) {
    const pts = (history || []).filter((h) => Number.isFinite(Date.parse(h.changed_at || h.at || '')) && h.register != null);
    if (pts.length < 2) return '';
    const xs = pts.map((h) => Date.parse(h.changed_at || h.at)); const ys = pts.map((h) => Number(h.register));
    const x0 = Math.min(...xs), x1 = Math.max(...xs, Date.now()), y0 = 0, y1v = Math.max(...ys) * 1.15;
    const X = (t) => 8 + ((t - x0) / Math.max(1, x1 - x0)) * 584, Y = (v) => 152 - ((v - y0) / Math.max(1, y1v - y0)) * 136;
    const by = new Map(); pts.forEach((h) => { const k = h.provider_name || h.registrar || 'Registrar'; if (!by.has(k)) by.set(k, []); by.get(k).push(h); });
    const lines = [...by.entries()].slice(0, 6).map(([k, hs], i) => {
        const s = hs.sort((a, b) => Date.parse(a.changed_at || a.at) - Date.parse(b.changed_at || b.at));
        let d = ''; s.forEach((h, j) => { const x = X(Date.parse(h.changed_at || h.at)), y = Y(Number(h.register)); d += j ? ` H${x.toFixed(1)} V${y.toFixed(1)}` : `M${x.toFixed(1)} ${y.toFixed(1)}`; });
        d += ` H${X(Date.now()).toFixed(1)}`;
        return `<path d="${d}" class="dm-line s${i}"><title>${esc(k)}</title></path>`;
    }).join('');
    return `<figure class="dm-chart"><svg viewBox="0 0 600 160" role="img" aria-label="First-year price over time">${lines}</svg><figcaption>First-year price over time${currency && currency !== 'USD' ? ` (${esc(currency)})` : ''}, each registrar a line.</figcaption></figure>`;
}

function tld({ tld: t } = {}) {
    const rows = (t && t.prices) || [];
    const name = t ? (t.display || dot(t.tld)) : '';
    const best = rows.find((r) => !r.currency_other && r.y3 != null);
    const first = rows.filter((r) => r.y1 != null).sort((a, b) => a.y1 - b.y1)[0];
    const facts = [
        first ? ['Cheapest first year', money(first.y1, first.currency), first.registrar] : null,
        best ? ['Cheapest to keep 3 years', money(best.y3, best.currency), best.registrar] : null,
        best && best.y5 != null ? ['Five years from', money(best.y5, best.currency), best.registrar] : null,
    ].filter(Boolean);
    const traps = rows.filter((r) => r.trap);
    const chart = historyChart(t && t.history, t && t.currency);
    const body = `<header class="dm-page-h dm-tld-h"><p class="dm-kicker">${esc(t && t.kind ? `${t.kind} ending` : 'Ending')}</p><h1>${esc(name)}</h1>
${facts.length ? `<dl class="dm-facts">${facts.map(([l, v, who]) => `<div><dt>${esc(l)}</dt><dd><b>${v}</b>${who ? `<small>${esc(who)}</small>` : ''}</dd></div>`).join('')}</dl>` : ''}
${traps.length ? `<p class="dm-warn">${kit.icon('alert')}<span>${traps.length === 1 ? `${esc(traps[0].registrar)} sells the first year cheap and renews at ${money(Number(traps[0].renew), traps[0].currency)}.` : `${traps.length} registrars sell the first year cheap and renew much higher.`} The 3-year column is the one to read.</span></p>` : ''}
${searchBox()}</header>
<section aria-labelledby="dm-reg-h"><div class="dm-head-row"><h2 id="dm-reg-h">Every registrar</h2></div>
<p class="dm-fine">From each registrar's own public price list.${latest(rows) ? ` Checked ${esc(day(latest(rows)))}.` : ''} Affiliate links, where there are any, are marked and never change the order.</p>
${rows.length ? priceTable(rows, { by: 'registrar', label: `Registrars for ${name}` }) : '<p class="dm-fine">No registrar prices this ending yet.</p>'}</section>
<section aria-labelledby="dm-hist-h"><h2 id="dm-hist-h">Price history</h2>${chart || `<p class="dm-fine">No price changes recorded${rows.length && rows[0].first_seen_at ? ` since ${esc(day(rows.map((r) => r.first_seen_at).filter(Boolean).sort()[0]))}` : ''}. Every change from now on is kept here.</p>`}</section>`;
    return layout({ agentLayer: true, title: `${name} domain prices: every registrar, 1, 3 and 5 years`, description: `What ${name} costs at every registrar OpenVibe reads: first year, renewal and the real 3- and 5-year totals.`, body: `<div class="dm-wrap">${body}</div>`, active: '/tld' });
}

function domain({ name, history, prices = [], status = null, check = null } = {}) {
    const full = name ? (name.display || name.ascii) : '';
    const h = history || {};
    const snaps = Array.isArray(h.snapshots) ? h.snapshots : [];
    const changes = Array.isArray(h.changes) ? h.changes : [];
    const last = snaps[0] && snaps[0].facts ? snaps[0].facts : null;
    const fact = (k, v) => (v ? `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>` : '');
    const list = (v) => (Array.isArray(v) ? v.join(', ') : v || '');
    const record = last ? `<dl class="dm-facts dm-record">${fact('Registrar', last.registrar)}${fact('Registered', day(last.created))}${fact('Expires', day(last.expires))}${fact('Name servers', list(last.nameservers))}${fact('DNSSEC', last.dnssec == null ? '' : last.dnssec ? 'Signed' : 'Not signed')}${fact('Status', list(last.status))}</dl>`
        + `<p class="dm-fine">Public registration facts from RDAP, seen ${esc(day(snaps[0].last_seen))}${snaps.length > 1 ? `; kept since ${esc(day(h.first_seen))}` : ''}.</p>` : '';
    const LABEL = { registrar: 'Registrar', created: 'Registered', expires: 'Expiry', status: 'Status', nameservers: 'Name servers', dnssec: 'DNSSEC' };
    const shown = (field, v) => (v == null || (Array.isArray(v) && !v.length) ? 'none' : field === 'created' || field === 'expires' ? day(v) : field === 'dnssec' ? (v ? 'signed' : 'not signed') : list(v));
    const timeline = changes.length ? `<ol class="dm-timeline">${changes.slice(0, 30).map((c) => `<li><time datetime="${esc(c.at || '')}">${esc(day(c.at))}</time>`
        + `${(c.changes || []).map((x) => `<span>${esc(LABEL[x.field] || x.field)}: ${esc(shown(x.field, x.before))} → <b>${esc(shown(x.field, x.after))}</b></span>`).join('')}</li>`).join('')}</ol>` : '';
    const watch = `https://openvibe.watch/watches/new?template=json&url=${encodeURIComponent(`https://openvibe.domains/api/v1/domains/${name ? name.ascii : ''}`)}&value_path=status&op=changed&name=${encodeURIComponent(`${full} changes`)}`;
    const body = `<header class="dm-page-h"><p class="dm-kicker">Domain</p><h1>${esc(full)}</h1>
${status ? `<p class="dm-status ${(STATUS[status] || ['is-unknown'])[0]}"><span class="dm-pill">${(STATUS[status] || [null, 'The registry did not answer'])[1]}</span>${status === 'registered' && check ? ` <span>${[check.registrar ? `with ${esc(check.registrar)}` : '', check.expires ? `until ${esc(day(check.expires))}` : ''].filter(Boolean).join(' ')}</span>` : ''}</p>` : ''}
<p class="dm-act"><a class="dm-btn" href="/search?q=${encodeURIComponent(name ? name.ascii : '')}">Every ending for ${esc(name ? name.label : '')}</a> <a class="dm-btn is-quiet" href="${esc(watch)}">Watch it</a></p></header>
<section aria-labelledby="dm-rec-h"><h2 id="dm-rec-h">Public record</h2>${record || `<p class="dm-fine">OpenVibe keeps a domain's history once it has been looked up ${Number(h.min_lookups || 5)} times${h.lookups ? ` (${Number(h.lookups)} so far)` : ''}. <a href="https://whois.openvibe.tools/?q=${encodeURIComponent(name ? name.ascii : '')}">Look it up now on OpenVibe.Tools</a>.</p>`}
${timeline ? `<h3>What changed</h3>${timeline}` : ''}</section>
${prices.length ? `<section aria-labelledby="dm-p-h"><h2 id="dm-p-h">What ${esc(dot(name.tld))} costs</h2>${priceTable(prices, { by: 'ending', label: `${dot(name.tld)} prices` })}</section>` : ''}`;
    return layout({ agentLayer: true, title: `${full}: public record and history`, description: `${full}: its registrar, dates and how they changed, from public records only.`, robots: snaps.length ? 'index, follow' : 'noindex, follow', body: `<div class="dm-wrap">${body}</div>` });
}

/** The API, for people and agents: every endpoint with a call that copies. */
function developers() {
    const rows = [
        ['GET /api/v1/search?q=sushitruck', 'A name: whether it is free (the registry\'s answer) and every ending\'s prices with 1, 3 and 5-year totals, cheapest over three years first.'],
        ['GET /api/v1/tlds?sort=renew', 'Every ending OpenVibe prices (sort popular, tld, register or renew; q, kind and page narrow it).'],
        ['GET /api/v1/tlds/dev', 'One ending: every registrar\'s prices with totals, and the price changes recorded.'],
        ['GET /api/v1/domains/example.com', 'One domain: status, registrar, expiry, its public history and its ending\'s prices.'],
    ];
    const body = `<header class="dm-page-h"><p class="dm-kicker">For developers</p><h1>The Domains API</h1><p class="dm-lede">Open JSON, no key, readable from any site (CORS). Prices come from registrars' public price lists with the date each was read; nothing is sponsored.</p></header>
<section aria-labelledby="dm-ep-h"><h2 id="dm-ep-h">Endpoints</h2><dl class="dm-eps">${rows.map(([ep, what]) => `<div><dt><code>${esc(ep)}</code></dt><dd>${esc(what)}</dd></div>`).join('')}</dl></section>
${sc.code({ title: 'Try it', samples: [{ label: 'Price a name', lang: 'bash', code: 'curl "https://openvibe.domains/api/v1/search?q=sushitruck"' }, { label: 'JavaScript', lang: 'js', code: "const r = await fetch('https://openvibe.domains/api/v1/tlds/dev').then((x) => x.json());\nconsole.log(r.tld.prices[0]);" }] })}
<p class="dm-fine">Limits: 120 requests a minute from one address. Errors are problem+json (RFC 9457). <a href="/llms.txt">llms.txt</a> describes the site for agents.</p>`;
    return layout({ agentLayer: true, title: 'The Domains API', description: 'Open JSON for domain prices, availability and history: every ending and registrar, with 1, 3 and 5-year totals.', body: `<div class="dm-wrap">${body}</div>`, active: '/developers' });
}

function notFound() {
    const body = `<header class="dm-page-h"><h1>Nothing here</h1><p class="dm-lede">That page does not exist. Price a name instead:</p>${searchBox()}</header>`;
    return layout({ title: 'Not found', robots: 'noindex, follow', body: `<div class="dm-wrap">${body}</div>` });
}

module.exports = { home, endings, search, tld, domain, developers, notFound, layout, setRelease, money };
