# Dedicated VPS origin for ltsd.ro

The public `ltsd.ro` hostname remains a Cloudflare Worker Custom Domain until the
VPS reverse proxy is tested and the DNS cutover is explicitly scheduled.

## Topology

- Public user hostname: `https://ltsd.ro` (eventually a **DNS-only** A record to the VPS).
- VPS public IPv4: `206.237.9.56`. Nginx terminates TLS.
- Worker origin hostname: `https://origin.ltsd.ro` (proxied Worker Custom Domain attached to `lastroweb-production`).
- **Do not point the origin domain back at the VPS**; this causes a proxy loop.

## Server-side shared secret

Generate a random lowercase 64-character hex secret *on the VPS*:

```sh
openssl rand -hex 32
```

Store it as a root-readable Nginx snippet, **outside the repository**,
for example `/etc/nginx/snippets/ltsd-proxy-secret.conf` with mode 600:

```nginx
proxy_set_header X-LTSD-Proxy-Secret "<64-hex-secret>";
```

Inside the existing `location /` that proxies `origin.ltsd.ro`:

```nginx
proxy_set_header X-LTSD-Client-IP $remote_addr;
proxy_set_header X-LTSD-Public-Host ltsd.ro;
include /etc/nginx/snippets/ltsd-proxy-secret.conf;
```

The Nginx `proxy_set_header` directives override arbitrary visitor-supplied
proxy headers. Ensure the VPS is **not** configured with a trusted external
`real_ip_header` that allows clients to spoof `$remote_addr`.

Configure the **same** secret via Workers secrets for the production environment:

```sh
npx wrangler secret put LTSD_PROXY_SHARED_SECRET --env production
```

Never set the secret as a plain `[vars]` value or commit it to git.

## Authentication model

The Worker accepts `X-LTSD-Client-IP` only when all are true:

1. Request hostname is `origin.ltsd.ro`.
2. Cloudflare's own `CF-Connecting-IP` equals the configured VPS IP.
3. `X-LTSD-Proxy-Secret` matches the secret binding.
4. `X-LTSD-Client-IP` is a single syntactically valid IPv4 or IPv6 address.

Requests to the origin that fail these checks return 403 in the Worker script.
Direct `ltsd.ro` requests continue using Cloudflare's own visitor IP and
`request.cf` until cutover. API search and upload fast paths are protected too.

**Important:** Workers Static Assets can be served before the Worker script.
Add a Cloudflare WAF custom rule BEFORE removing the direct entrypoint:

```text
(http.host eq "origin.ltsd.ro" and ip.src ne 206.237.9.56)
```

Action: **Block**. Confirm the outbound VPS source IPv4 is correct before
enabling the rule. Do not apply this rule to `ltsd.ro`.

## Geolocation

Cloudflare `request.cf.country/city/asn` reflects **the VPS** when requests
arrive through the proxy, not the end-user. For trusted proxy traffic this code
intentionally stores **null** geo values unless Nginx explicitly supplies
GeoIP-derived metadata through these optional headers:

- `X-LTSD-Client-Country` (ISO alpha-2)
- `X-LTSD-Client-Region`, `X-LTSD-Client-City`
- `X-LTSD-Client-Latitude`, `X-LTSD-Client-Longitude`
- `X-LTSD-Client-ASN`, `X-LTSD-Client-AS-Org`

Nginx does **not** emit these by default. They require a maintained, trusted
GeoIP database (e.g. MaxMind GeoLite2) installed on the VPS. Until that
database is configured, make sure Nginx overwrites (does not forward) all of
the above headers, **even if the browser sends them**:

```nginx
proxy_set_header X-LTSD-Client-Country "";
proxy_set_header X-LTSD-Client-Region "";
proxy_set_header X-LTSD-Client-City "";
proxy_set_header X-LTSD-Client-Latitude "";
proxy_set_header X-LTSD-Client-Longitude "";
proxy_set_header X-LTSD-Client-ASN "";
proxy_set_header X-LTSD-Client-AS-Org "";
```

Additionally the Worker deliberately ignores these headers until the binding
`LTSD_PROXY_GEO_ENABLED` is set to `true`. Leave it **unset** for the initial
proxy cutover. Enable it only after installing a maintained GeoIP database
and configuring all Nginx GeoIP fields as server-derived values. Do not
synthesize them from the VPS's own Cloudflare location or trust visitor headers.

## Before DNS cutover

Test via `curl --resolve ltsd.ro:443:206.237.9.56 https://ltsd.ro/`.
Verify KE device-code limits on two separate end-user IPs, login/CSRF cookies,
Stripe webhooks, downloads, static assets, and host-based redirects.
Check the cloudflare WAF rule separately because static assets can bypass JS.
Make sure the origin Custom Domain remains attached across deployments.
