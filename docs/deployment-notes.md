# Deployment notes for payment callbacks

The payment gateways call **your** server. These few infrastructure details are
what actually break go-lives — the integration code can be perfect and a single
nginx line still makes every callback fail. Self-contained checklist below.

---

## 1. nginx location blocks must NOT have a trailing slash

This one causes an instant, total outage of a callback route and is maddening to
debug because the integration code is correct.

A `location` block that ends with a slash makes nginx auto-301 `/foo` → `/foo/`.
Next.js' App Router then 308s `/foo/` → `/foo`. The result is a redirect loop:
`ERR_TOO_MANY_REDIRECTS` on any POST to that route. The gateway follows the
redirect, gets another redirect, and gives up — your handler never runs.

```nginx
# ✗ WRONG — trailing slash triggers the 301 ↔ 308 loop
location /api/payments/click/ { proxy_pass http://app; }

# ✓ RIGHT — slashless
location /api/payments/click   { proxy_pass http://app; }
location /api/payments/payme   { proxy_pass http://app; }
```

Same rule for any route Next.js owns. If you use a single `location /api/` block,
keep it slashless too.

---

## 2. Always return JSON, never HTML — even on error

Both Click and Payme parse your response body. If an unhandled exception makes
Next.js return its HTML error page, the gateway chokes and the transaction is
left in limbo (Click shows "Not paid", Payme retries forever).

- Wrap handler bodies so **every** path returns the gateway's expected JSON
  shape, including malformed-input and internal-error paths.
- The route handlers in this repo already return a structured error response for
  bad signatures, missing orders, etc. Add a top-level `try/catch` if your
  `fulfilOrder()` can throw, and return the gateway's "failed/retry" code rather
  than letting the exception bubble into an HTML 500.

---

## 3. Don't block the gateway's IPs

Both gateways send callbacks from real-world IP ranges that change over time.

- **Cloudflare:** do NOT exclude the callback paths from CF, and do NOT try to
  allowlist gateway IPs. Use **SSL → Full (strict)** with an Origin Certificate
  so the origin only accepts CF, and let CF pass the callbacks through.
- **Firewall (UFW/security groups):** the callback URL must be reachable from
  the public internet. If you restrict 443 to Cloudflare IP ranges, that's fine
  — just don't add a narrower allowlist that drops the gateway.
- A WAF "block scanner paths" rule (`.env`, `/.git`, `/wp-`) is good hygiene and
  doesn't affect `/api/payments/*` — just make sure your rule doesn't match the
  callback path.

---

## 4. Use an nginx upstream with keepalive

Not strictly required, but under burst (a sale, a campaign) a fresh loopback TCP
socket per request leaves 60-second `TIME_WAIT` entries and can exhaust
ephemeral ports — callbacks then time out intermittently.

```nginx
upstream app {
    server 127.0.0.1:3000;
    keepalive 64;
    keepalive_timeout 60s;
    keepalive_requests 1000;
}

server {
    # ...
    proxy_http_version 1.1;
    proxy_set_header Connection "";   # required for upstream keepalive
    location /api/payments/click { proxy_pass http://app; }
    location /api/payments/payme { proxy_pass http://app; }
}
```

---

## 5. Quick pre-go-live verification

```bash
# Callback reachable and returns JSON (not an HTML error page):
curl -sS -X POST https://yourapp.com/api/payments/payme/callback \
  -H "Content-Type: application/json" -d '{}' -i | head -20
# Expect: 200 with a JSON body and Content-Type: text/json (Payme),
# NOT a 301/308 redirect and NOT an HTML page.

curl -sS -X POST https://yourapp.com/api/payments/click/prepare \
  -d "action=0" -i | head -20
# Expect: 200 with a JSON {"error": ...} body, NOT ERR_TOO_MANY_REDIRECTS.
```

If you see a `301`/`308` in the response headers, fix the trailing slash
(section 1) before contacting the gateway to go live.
