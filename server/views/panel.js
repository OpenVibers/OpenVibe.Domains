'use strict';
/**
 * The control panel's pages (plan 2026-10-28 §5.1, DOM-2): a person's connections, zones and proposals. Server-rendered
 * and whole without JavaScript (every action is a form); always a person's own, so never cached. server/http/panel.js
 * builds each model; nothing here ever sees a provider token.
 *
 *   signedOut()                                   what the panel is, and Sign in
 *   home({ connections, zones, waiting, recent, notice })
 *   connect({ error, values })
 *   zone({ conn, zone, records, error, values })
 *   proposal({ p, notice })
 */
const kit = require('openvibe-shared/kit');
const { layout } = require('./index');
const { describe } = require('../panel/panel');

const esc = kit.esc;
const TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'CAA', 'SRV'];
const when = (v) => {
    const t = Date.parse(v || '');
    return Number.isFinite(t) ? `<time datetime="${esc(new Date(t).toISOString())}">${esc(new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }))} UTC</time>` : '';
};
const STATUS_WORDS = { pending: 'Waiting for you', applying: 'Applying', applied: 'Applied', declined: 'Declined', failed: 'Failed', rolled_back: 'Rolled back', expired: 'Expired' };
const pill = (status) => `<span class="dm-pill dmp-st dmp-st--${esc(status)}">${esc(STATUS_WORDS[status] || status)}</span>`;
const OP_WORDS = { create: 'Add', update: 'Change', delete: 'Remove' };

function page(title, body, { notice = null } = {}) {
    const flash = notice ? `<p class="dmp-notice" role="status">${kit.icon('check')}<span>${esc(notice)}</span></p>` : '';
    // A form with data-dmp-confirm asks first (remove a connection, roll back); without JavaScript it simply submits.
    const confirmJs = '<script>document.addEventListener("submit",function(e){var f=e.target;if(f&&f.dataset&&f.dataset.dmpConfirm&&!window.confirm(f.dataset.dmpConfirm))e.preventDefault();});</script>';
    return layout({ title, robots: 'noindex, nofollow', body: `<div class="dm-wrap dmp">${flash}${body}</div>${confirmJs}`, active: '/panel' });
}

function head(kicker, h1, lede = '') {
    return `<header class="dm-page-h"><p class="dm-kicker">${kicker}</p><h1>${esc(h1)}</h1>${lede ? `<p class="dm-lede">${lede}</p>` : ''}</header>`;
}

function signedOut() {
    const steps = [
        ['link', 'Connect', 'Paste a Cloudflare API token. It is kept as a secret in your own OpenVibe project and only ever sent to Cloudflare.'],
        ['spark', 'Propose', 'Every DNS change, yours or an agent\'s, becomes a proposal: the exact records, why, and what could break.'],
        ['check', 'Approve', 'Nothing changes until you approve it, here or in the Action Center. Applied changes roll back in one tap.'],
    ];
    return page('Control panel', `${head('Control panel', 'Run every domain you own from one place', 'Connect your DNS once and see every zone together. Changes wait for your approval, and each one can be undone.')}
<ol class="dmp-steps">${steps.map(([icon, t, d], i) => `<li><span class="dmp-step-ic">${kit.icon(icon)}</span><b>${i + 1}. ${esc(t)}</b><span>${esc(d)}</span></li>`).join('')}</ol>
<p class="dmp-actions"><a class="dm-btn" href="/auth/login?next=%2Fpanel">Sign in with OpenVibe</a></p>
<p class="dm-fine">Cloudflare today; Porkbun, Namecheap and Spaceship follow. OpenVibe never stores your token in its own database and never shows it again.</p>`);
}

function connectionRow(c) {
    const broken = c.status === 'broken';
    return `<li class="dmp-conn${broken ? ' is-broken' : ''}" id="dmp-conn-${esc(c.id)}">
<div class="dmp-conn-main"><b>${esc(c.label)}</b><span class="dmp-sub">Cloudflare · ${c.zone_count} zone${c.zone_count === 1 ? '' : 's'}${c.checked_at ? ` · checked ${when(c.checked_at)}` : ''}</span>
${broken ? `<span class="dmp-err">${kit.icon('alert')}${esc(c.last_error || 'The token stopped working.')}</span>` : ''}</div>
<div class="dmp-conn-act">
<form method="post" action="/panel/c/${esc(c.id)}/sync"><button class="dmp-btn" type="submit">Sync</button></form>
<form method="post" action="/panel/c/${esc(c.id)}/remove" data-dmp-confirm="Remove ${esc(c.label)}? Its token is deleted from your OpenVibe project and waiting proposals expire."><button class="dmp-btn dmp-btn--quiet" type="submit">Remove</button></form>
</div></li>`;
}

function proposalCard(p) {
    return `<li class="dmp-prop" id="dmp-prop-${esc(p.id)}"><a href="/panel/p/${esc(p.id)}">
<span class="dmp-prop-top">${pill(p.status)}<span class="dmp-sub">${esc(p.domain)} · ${when(p.created_at)}</span></span>
<b>${esc(p.title)}</b>
<span class="dmp-sub">${p.changes.length} change${p.changes.length === 1 ? '' : 's'}${String(p.created_by).startsWith('agent:') ? ` · asked by ${esc(String(p.created_by).slice(6))}` : ''}</span>
</a></li>`;
}

function home({ connections = [], zones = [], waiting = [], recent = [], notice = null } = {}) {
    if (!connections.length) {
        return page('Control panel', `${head('Control panel', 'Connect your first account', 'Domains reads your zones through the provider\'s own API. Every change is proposed to you first.')}
<p class="dmp-actions"><a class="dm-btn" href="/panel/connect">${kit.icon('plus')}Connect Cloudflare</a></p>`, { notice });
    }
    const facts = `<dl class="dm-facts"><div><dt>Zones</dt><dd><b>${zones.length}</b></dd></div><div><dt>Waiting for you</dt><dd><b>${waiting.length}</b></dd></div><div><dt>Connections</dt><dd><b>${connections.length}</b>${connections.some((c) => c.status === 'broken') ? '<small>one needs attention</small>' : ''}</dd></div></dl>`;
    const zoneRows = zones.map((z) => `<a class="dm-tr dmp-zone" id="dmp-zone-${esc(z.zone_id)}" href="/panel/z/${esc(z.connection_id)}/${esc(z.zone_id)}">
<span class="dmp-zone-name">${kit.icon('globe')}<b>${esc(z.name)}</b></span><span>${esc(z.label)}</span><span>${esc(z.status || '')}</span><span class="dmp-ns">${(z.name_servers || []).slice(0, 2).map(esc).join('<br>')}</span><span class="dmp-open">Open${kit.icon('chevron')}</span></a>`).join('');
    return page('Control panel', `${head('Control panel', 'Your domains')}
${facts}
${waiting.length ? `<section aria-labelledby="dmp-wait-h"><h2 id="dmp-wait-h">Waiting for you</h2><ul class="dmp-props">${waiting.map(proposalCard).join('')}</ul></section>` : ''}
<section aria-labelledby="dmp-zones-h"><div class="dm-head-row"><h2 id="dmp-zones-h">Zones</h2><a class="dm-more" href="/panel/connect">Connect another account${kit.icon('chevron')}</a></div>
${zones.length ? `<div class="dm-table dmp-zones" role="table"><div class="dm-tr dm-th" role="row"><span>Domain</span><span>Account</span><span>Status</span><span>Name servers</span><span></span></div>${zoneRows}</div>` : '<p class="dm-fine">No zones yet. Sync a connection, or check its token can read zones.</p>'}</section>
<section aria-labelledby="dmp-conn-h"><h2 id="dmp-conn-h">Connections</h2><ul class="dmp-conns">${connections.map(connectionRow).join('')}</ul></section>
${recent.length ? `<section aria-labelledby="dmp-recent-h"><h2 id="dmp-recent-h">Recent changes</h2><ul class="dmp-props">${recent.map(proposalCard).join('')}</ul></section>` : ''}`, { notice });
}

function connect({ error = null, values = {} } = {}) {
    return page('Connect Cloudflare', `${head('<a href="/panel">Control panel</a>', 'Connect Cloudflare')}
<div class="dmp-split">
<form class="dmp-form" method="post" action="/panel/connect" id="dmp-connect" autocomplete="off">
${error ? `<p class="dm-warn" role="alert">${kit.icon('alert')}<span>${esc(error)}</span></p>` : ''}
<input type="hidden" name="provider" value="cloudflare">
<label class="dmp-field"><span>A name for it</span><input name="label" maxlength="60" value="${esc(values.label || 'Cloudflare')}" required></label>
<label class="dmp-field"><span>API token</span><input name="token" type="password" minlength="20" maxlength="400" required spellcheck="false" autocomplete="off" placeholder="Paste the token Cloudflare showed you"></label>
<p class="dmp-actions"><button class="dm-btn" type="submit">${kit.icon('lock')}Connect</button><a class="dmp-btn dmp-btn--quiet" href="/panel">Cancel</a></p>
</form>
<aside class="dmp-help" aria-labelledby="dmp-help-h"><h2 id="dmp-help-h">Make a token that can do only this</h2>
<ol><li>Open <a href="https://dash.cloudflare.com/profile/api-tokens" rel="noopener noreferrer" target="_blank">API tokens</a> in Cloudflare and choose <b>Create token</b>.</li>
<li>Start from <b>Edit zone DNS</b>. Add <b>Zone · Zone · Read</b> so Domains can list your zones.</li>
<li>Under <b>Zone resources</b>, pick the zones you want here (or all of them).</li>
<li>Create it and paste it on the left. Cloudflare shows it once.</li></ol>
<p class="dmp-where">${kit.icon('shield')}<span>The token is stored as a secret in your own OpenVibe project, granted to OpenVibe.Domains only for calls to <b>api.cloudflare.com</b>. Domains keeps its name, never its value. Remove the connection and the secret goes with it.</span></p>
</aside></div>`);
}

function recordFields(r = {}, { prefix = '' } = {}) {
    const type = r.type || 'A';
    return `<label class="dmp-field dmp-field--type"><span>Type</span><select name="${prefix}type">${TYPES.map((t) => `<option${t === type ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
<label class="dmp-field"><span>Name</span><input name="${prefix}name" value="${esc(r.name || '')}" placeholder="@ or www" required></label>
<label class="dmp-field dmp-field--wide"><span>Value</span><input name="${prefix}content" value="${esc(r.content || '')}" required spellcheck="false"></label>
<label class="dmp-field dmp-field--ttl"><span>TTL</span><input name="${prefix}ttl" inputmode="numeric" value="${esc(r.ttl == null ? 1 : r.ttl)}" title="1 is automatic; else 60 to 86 400 seconds"></label>
<label class="dmp-field dmp-field--pri"><span>Priority</span><input name="${prefix}priority" inputmode="numeric" value="${esc(r.priority == null ? '' : r.priority)}" placeholder="MX, SRV"></label>
<label class="dmp-check"><input type="checkbox" name="${prefix}proxied"${r.proxied ? ' checked' : ''}><span>Proxied</span></label>`;
}

function zone({ conn, zone: z, records = [], error = null, values = {} } = {}) {
    const action = `/panel/z/${esc(conn.id)}/${esc(z.zone_id)}/propose`;
    const rows = records.map((r) => `<li class="dmp-rec" id="dmp-rec-${esc(r.id)}">
<div class="dmp-rec-main"><span class="dmp-type">${esc(r.type)}</span><b class="dmp-rec-name">${esc(r.name)}</b><code class="dmp-rec-val">${esc(r.content)}</code>
<span class="dmp-sub">${r.ttl === 1 ? 'Auto TTL' : `TTL ${esc(r.ttl)}`}${r.priority != null ? ` · priority ${esc(r.priority)}` : ''}${r.proxied ? ' · proxied' : ''}</span></div>
<div class="dmp-rec-act">
<details class="dmp-edit"><summary class="dmp-btn">Change</summary>
<form class="dmp-form dmp-form--row" method="post" action="${action}"><input type="hidden" name="op" value="update"><input type="hidden" name="record_id" value="${esc(r.id)}">
${recordFields(r)}<label class="dmp-field dmp-field--wide"><span>Why (optional)</span><input name="why" maxlength="300"></label>
<p class="dmp-actions"><button class="dm-btn" type="submit">Propose this change</button></p></form></details>
<form method="post" action="${action}"><input type="hidden" name="op" value="delete"><input type="hidden" name="record_id" value="${esc(r.id)}"><button class="dmp-btn dmp-btn--quiet" type="submit">Remove</button></form>
</div></li>`).join('');
    return page(z.name, `${head(`<a href="/panel">Control panel</a> · ${esc(conn.label)}`, z.name)}
<dl class="dm-facts"><div><dt>Records</dt><dd><b>${records.length}</b></dd></div><div><dt>Status</dt><dd>${esc(z.status || '—')}</dd></div><div><dt>Name servers</dt><dd class="dmp-ns">${(Array.isArray(z.name_servers) ? z.name_servers : []).map(esc).join('<br>') || '—'}</dd></div></dl>
<section aria-labelledby="dmp-add-h"><h2 id="dmp-add-h">Add a record</h2>
<p class="dm-fine">Nothing changes yet: this makes a proposal you approve on the next page.</p>
${error ? `<p class="dm-warn" role="alert">${kit.icon('alert')}<span>${esc(error)}</span></p>` : ''}
<form class="dmp-form dmp-form--row" method="post" action="${action}" id="dmp-add"><input type="hidden" name="op" value="create">
${recordFields(values)}<label class="dmp-field dmp-field--wide"><span>Why (optional)</span><input name="why" maxlength="300" value="${esc(values.why || '')}"></label>
<p class="dmp-actions"><button class="dm-btn" type="submit">${kit.icon('plus')}Propose</button></p></form></section>
<section aria-labelledby="dmp-recs-h"><h2 id="dmp-recs-h">Records</h2>
${records.length ? `<ul class="dmp-recs">${rows}</ul>` : '<p class="dm-fine">This zone has no records Cloudflare showed us.</p>'}</section>`);
}

function changeCard(c) {
    const b = c.before;
    const a = c.after;
    const r = a || b || {};
    const val = (x) => (x ? `<code>${esc(x.content)}</code><span class="dmp-sub">${x.ttl === 1 ? 'Auto TTL' : `TTL ${esc(x.ttl)}`}${x.priority != null ? ` · priority ${esc(x.priority)}` : ''}${x.proxied ? ' · proxied' : ''}</span>` : '');
    return `<li class="dmp-change dmp-change--${esc(c.op)}"><span class="dmp-op">${esc(OP_WORDS[c.op] || c.op)}</span>
<div class="dmp-change-main"><p class="dmp-change-rec"><span class="dmp-type">${esc(r.type)}</span><b>${esc(r.name)}</b></p>
<div class="dmp-diff">${b ? `<div class="dmp-before"><span class="dmp-sub">Now</span>${val(b)}</div>` : ''}${a ? `<div class="dmp-after"><span class="dmp-sub">${b ? 'After' : 'New'}</span>${val(a)}</div>` : '<div class="dmp-after"><span class="dmp-sub">After</span><em>Removed</em></div>'}</div></div></li>`;
}

function proposal({ p, notice = null } = {}) {
    const rolledBackable = (p.status === 'applied' || p.status === 'failed') && p.can_roll_back;
    const actions = p.status === 'pending'
        ? `<form method="post" action="/panel/p/${esc(p.id)}/decide"><input type="hidden" name="decision" value="approve"><button class="dm-btn" type="submit">${kit.icon('check')}Approve and apply</button></form>
<form method="post" action="/panel/p/${esc(p.id)}/decide"><input type="hidden" name="decision" value="decline"><button class="dmp-btn dmp-btn--quiet" type="submit">Decline</button></form>`
        : rolledBackable ? `<form method="post" action="/panel/p/${esc(p.id)}/rollback" data-dmp-confirm="Undo what this applied?"><button class="dm-btn" type="submit">Roll back</button></form>` : '';
    const by = String(p.created_by || '');
    return page(p.title, `${head(`<a href="/panel">Control panel</a> · ${esc(p.domain)}`, p.title)}
<p class="dm-status">${pill(p.status)}<span>${by.startsWith('agent:') ? `Asked by ${esc(by.slice(6))}` : 'You asked'} · ${when(p.created_at)}${p.status === 'pending' && p.expires_at ? ` · decide by ${when(p.expires_at)}` : ''}${p.applied_at ? ` · applied ${when(p.applied_at)}` : ''}${p.rolled_back_at ? ` · rolled back ${when(p.rolled_back_at)}` : ''}</span></p>
${p.error ? `<p class="dm-warn" role="alert">${kit.icon('alert')}<span>${esc(p.error)}</span></p>` : ''}
<section aria-labelledby="dmp-ch-h"><h2 id="dmp-ch-h">${p.changes.length === 1 ? 'The change' : `${p.changes.length} changes, in this order`}</h2><ol class="dmp-changes">${p.changes.map(changeCard).join('')}</ol></section>
${p.why ? `<section aria-labelledby="dmp-why-h"><h2 id="dmp-why-h">Why</h2><p class="dmp-text">${esc(p.why)}</p></section>` : ''}
${p.risk ? `<section aria-labelledby="dmp-risk-h"><h2 id="dmp-risk-h">What could break</h2><p class="dmp-text">${esc(p.risk)}</p></section>` : ''}
${actions ? `<div class="dmp-decide">${actions}</div>` : ''}
<p class="dm-fine">${p.status === 'pending' ? 'Approving applies the changes through Cloudflare\'s API, one by one. If a record changed since this was proposed, nothing more is applied and you can roll back what was.' : 'Every step is kept in your panel\'s audit.'}</p>`, { notice });
}

module.exports = { signedOut, home, connect, zone, proposal, describe };
