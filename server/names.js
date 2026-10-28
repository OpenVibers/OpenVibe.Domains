'use strict';

/**
 * Read a name the way a person types it. A name is a label and an optional ending: "sushi truck",
 * "SushiTruck.com", "https://www.sushitruck.co.uk/x" and "münchen.de" all have one.
 *
 * parseName(input) -> { label, tld, ascii, display } | null
 *   label    the first label, ASCII (punycode for IDNs), 1-63 characters of [a-z0-9-]
 *   tld      everything after the first dot ("co.uk" stays "co.uk"), or null
 *   ascii    the full name in ASCII (punycode when needed), or just the label when there is no tld
 *   display  the Unicode form for people
 *
 * parseTld(input) -> the ending without a leading dot (".Dev" -> "dev", "co.uk"), or null.
 */
const url = require('url');

/** Components are 1-63 characters, lower-case ASCII letters, digits and hyphens, no edge hyphen. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validAscii(name) {
    if (!name || name.length > 253) return false;
    const parts = name.split('.');
    if (parts.length < 1 || parts.length > 127) return false;
    return parts.every((p) => p.length >= 1 && p.length <= 63 && LABEL_RE.test(p));
}

/** Drop a scheme, credentials, path, query, fragment, port, a leading www. and a trailing root dot. */
function hostPart(input) {
    if (typeof input !== 'string') return '';
    let s = input.trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    // A user:password@ is not part of a name; leave it to fail validation rather than guessing.
    s = s.split(/[/?#]/, 1)[0];
    s = s.replace(/:\d+$/, '');
    s = s.replace(/^www\./, '');
    s = s.replace(/\.+$/, '');
    return s;
}

function toAscii(name) {
    try {
        return url.domainToASCII(name);
    } catch {
        return '';
    }
}

function parseName(input) {
    const raw = hostPart(input);
    if (!raw) return null;

    const dot = raw.indexOf('.');
    const labelRaw = (dot === -1 ? raw : raw.slice(0, dot)).replace(/[\s_]/g, '');
    const tldRaw = dot === -1 ? '' : raw.slice(dot + 1);

    // Spaces and underscores are removed from the label only; an ending is validated as typed.
    if (!labelRaw) return null;
    const nameRaw = tldRaw ? `${labelRaw}.${tldRaw}` : labelRaw;
    const ascii = toAscii(nameRaw);
    if (!ascii || !validAscii(ascii)) return null;

    const parts = ascii.split('.');
    const tld = parts.length > 1 ? parts.slice(1).join('.') : null;
    const display = url.domainToUnicode(ascii) || ascii;
    return { label: parts[0], tld, ascii, display };
}

function parseTld(input) {
    if (typeof input !== 'string') return null;
    const s = hostPart(input).replace(/^\.+/, '');
    if (!s) return null;
    const ascii = toAscii(s);
    if (!ascii || !validAscii(ascii)) return null;
    return ascii;
}

module.exports = { parseName, parseTld };
