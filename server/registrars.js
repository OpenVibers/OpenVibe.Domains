'use strict';

/**
 * The domain registrars OpenVibe.Domains works with (plan §AB.19, 2026-11-13: "each registrar (Cloudflare, Porkbun,
 * Namecheap, Gandi, Dynadot, Spaceship) as one row with its key pair, what it lets OpenVibe do (list, renew, set DNS)").
 *
 * One registrar is one row of the owner's Setup tab: its keys, and only its keys, share one x-required-for, so the
 * guide shows the registrar once with its fields under it. A registrar with no key is skipped; a registrar whose key
 * is refused is reported as not working.
 *
 * Every registrar here can do the same three things with its key: list the domains the account holds, renew them and
 * set their DNS. Each one is reached with its own API and its own authentication:
 *
 *   cloudflare   one API token (Cloudflare issues a single token that carries both rights)
 *                GET  https://api.cloudflare.com/client/v4/zones                 Bearer <token>
 *   porkbun      an API key and its secret, sent as apikey/secretapikey in a POST body
 *                POST https://api.porkbun.com/api/json/v3/domain/listAll
 *   namecheap    an API user and an API key, sent as ApiUser/ApiKey in a query, with the address the account allows
 *                GET  https://api.namecheap.com/xml.response?command=namecheap.domains.getList
 *   gandi        a personal access token, sent as a Bearer token
 *                GET  https://api.gandi.net/v5/domain/domains
 *   dynadot      an API key and an API secret; the secret signs the request (base64 HMAC-SHA256 over
 *                "<apiKey>\n<pathAndQuery>\n\"\"\n<body>", keyed by the secret)
 *                GET  https://api.dynadot.com/restful/v2/domains/list
 *   spaceship    an API key and an API secret, sent as X-Api-Key/X-Api-Secret headers
 *                GET  https://spaceship.dev/api/v1/domains
 *
 * The list of domains is the test of a row: one cheap authenticated read, never a write, never money. The reads live
 * in server/registrar-clients.js; a person's own connected account still speaks its own panel client.
 */

/**
 * The words a registrar's key buys, in plain words. One sentence, no jargon: what the owner gets for pasting it.
 * The first one (Cloudflare, Porkbun) already has its panel client, so its DNS changes work today; the other four
 * can be listed today and their renewal and DNS work waits on the same row.
 */
const unlocksOf = (registrar) => registrar.unlocks;

/** Every registrar, in the order the owner's Setup tab shows them. */
const REGISTRARS = [
    {
        id: 'cloudflare',
        name: 'Cloudflare',
        unlocks: 'Lets OpenVibe.Domains list, renew and point your Cloudflare domains, so you can run them from one place.',
        keys: [
            {
                name: 'cloudflare_api_token', local: 'apiToken', title: 'Cloudflare API token', secret: true, env: 'CLOUDFLARE_API_TOKEN',
                words: 'A Cloudflare API token that may read your zones and change their DNS records. Domains seals it when you save it and never shows it again.',
            },
        ],
        get_it_at: 'https://dash.cloudflare.com/profile/api-tokens',
        get_it_how: 'Create a token with Zone:Read and DNS:Edit, then paste it here.',
    },
    {
        id: 'porkbun',
        name: 'Porkbun',
        unlocks: 'Lets OpenVibe.Domains list, renew and point your Porkbun domains, so you can run them from one place.',
        keys: [
            {
                name: 'porkbun_api_key', local: 'apiKey', title: 'Porkbun API key', secret: true, env: 'PORKBUN_API_KEY',
                words: 'The Porkbun API key from your account\'s API page. Together with its secret it lets Domains read and change Porkbun DNS; the key alone does nothing.',
            },
            {
                name: 'porkbun_secret_api_key', local: 'secretApiKey', title: 'Porkbun secret API key', secret: true, env: 'PORKBUN_SECRET_API_KEY',
                words: 'The secret half of the Porkbun API key pair. It is locked when saved and never shown again; make a new pair at Porkbun if it is lost.',
            },
        ],
        get_it_at: 'https://porkbun.com/account/api',
        get_it_how: 'Enable the API on that page, create a key pair, and paste both halves here.',
    },
    {
        id: 'namecheap',
        name: 'Namecheap',
        unlocks: 'Lets OpenVibe.Domains list, renew and point your Namecheap domains, so you can run them from one place.',
        keys: [
            {
                name: 'namecheap_api_user', local: 'apiUser', title: 'Namecheap API user', secret: true, env: 'NAMECHEAP_API_USER',
                words: 'The API user Namecheap shows on its API page. It is half of the pair that lets Domains read your Namecheap domains.',
            },
            {
                name: 'namecheap_api_key', local: 'apiKey', title: 'Namecheap API key', secret: true, env: 'NAMECHEAP_API_KEY',
                words: 'The API key that goes with the API user. Namecheap only answers calls from an address on the account\'s list, so that address belongs here too.',
            },
            {
                name: 'namecheap_client_ip', local: 'clientIp', title: 'Namecheap allowed address', secret: false, env: 'NAMECHEAP_CLIENT_IP',
                words: 'The internet address Namecheap sees OpenVibe calling from. Put the address on your Namecheap API access list here, or Namecheap refuses every call.',
            },
        ],
        get_it_at: 'https://www.namecheap.com/support/api/methods/',
        get_it_how: 'Turn on API access for your account, allow the address OpenVibe calls from, then paste the API user, the API key and that address here.',
    },
    {
        id: 'gandi',
        name: 'Gandi',
        unlocks: 'Lets OpenVibe.Domains list, renew and point your Gandi domains, so you can run them from one place.',
        keys: [
            {
                name: 'gandi_api_token', local: 'apiToken', title: 'Gandi personal access token', secret: true, env: 'GANDI_API_TOKEN',
                words: 'A Gandi personal access token. It is the one key Domains needs to read and change the Gandi domains your account holds.',
            },
        ],
        get_it_at: 'https://account.gandi.net/api/',
        get_it_how: 'Create a personal access token with the domain rights, then paste it here.',
    },
    {
        id: 'dynadot',
        name: 'Dynadot',
        unlocks: 'Lets OpenVibe.Domains list, renew and point your Dynadot domains, so you can run them from one place.',
        keys: [
            {
                name: 'dynadot_api_key', local: 'apiKey', title: 'Dynadot API key', secret: true, env: 'DYNADOT_API_KEY',
                words: 'The Dynadot API key from your account. With its secret it signs every call Domains makes, so it needs both halves.',
            },
            {
                name: 'dynadot_api_secret', local: 'apiSecret', title: 'Dynadot API secret', secret: true, env: 'DYNADOT_API_SECRET',
                words: 'The secret that signs Dynadot calls. It is locked when saved and never shown again; make a new pair at Dynadot if it is lost.',
            },
        ],
        get_it_at: 'https://www.dynadot.com/account/api',
        get_it_how: 'Create an API key and secret on that page, then paste both here.',
    },
    {
        id: 'spaceship',
        name: 'Spaceship',
        unlocks: 'Lets OpenVibe.Domains list, renew and point your Spaceship domains, so you can run them from one place.',
        keys: [
            {
                name: 'spaceship_api_key', local: 'apiKey', title: 'Spaceship API key', secret: true, env: 'SPACESHIP_API_KEY',
                words: 'The Spaceship API key from your account. Its secret signs the calls Domains makes, so it needs both halves.',
            },
            {
                name: 'spaceship_api_secret', local: 'apiSecret', title: 'Spaceship API secret', secret: true, env: 'SPACESHIP_API_SECRET',
                words: 'The secret that signs Spaceship calls. It is locked when saved and never shown again; make a new pair at Spaceship if it is lost.',
            },
        ],
        get_it_at: 'https://www.spaceship.com/application/api',
        get_it_how: 'Create an API key and secret on that page, then paste both here.',
    },
];

/** The registrar's row name: what the fields of that registrar are "for". */
const requiredFor = (registrar) => `${registrar.name} domains`;

/** The registrar a key belongs to, or null when the key is not a registrar's. */
const registrarOfKey = (key) => REGISTRARS.find((r) => r.keys.some((k) => k.name === key)) || null;

/** Every key in the registry, and the ones that are secret class (write-only, sealed). */
const ALL_KEYS = REGISTRARS.flatMap((r) => r.keys.map((k) => k.name));
const SECRET_KEYS = new Set(REGISTRARS.flatMap((r) => r.keys.filter((k) => k.secret).map((k) => k.name)));

module.exports = { REGISTRARS, requiredFor, unlocksOf, registrarOfKey, ALL_KEYS, SECRET_KEYS };
