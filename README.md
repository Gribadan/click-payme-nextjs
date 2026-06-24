# Click & Payme for Next.js

**English** · [Русский](README.ru.md) · [Oʻzbekcha](README.uz.md)

> Drop-in **Click** and **Payme (Paycom)** payment integration for Next.js (App Router) — the two payment gateways every Uzbekistan product needs, done right the first time.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-App_Router-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

Both gateways share **one** `payment_orders` table and the same Next.js Route
Handler pattern, so you wire your DB once and get both. The protocol-correct
parts (MD5 signatures, JSON-RPC envelopes, tiyin↔UZS conversion, idempotency)
are written and ready; you only plug in your own order lookup and fulfilment.

> [!WARNING]
> Community project. **Not** affiliated with or endorsed by Click, Payme, or
> Paycom. Always verify against the official docs linked below before go-live.

---

## Why this exists

Integrating Click and Payme looks simple and then quietly eats a week. The
failure modes are non-obvious and most of them only show up **in production
against the real gateway** — there's no helpful error. This repo encodes the
traps that actually cost real outages:

- 💸 **Payme amounts are in tiyin** (1 UZS = 100 tiyin). Get it wrong once and
  you charge 100× or refund forever.
- 📝 **Click POSTs `x-www-form-urlencoded`, not JSON** — `request.json()`
  rejects it and every callback 400s while orders sit "pending".
- 🔐 **Click uses two different MD5 formulas** for `prepare` vs `complete`.
- 🔁 **Both gateways retry callbacks** — every method must be idempotent or you
  double-fulfil / fail the Payme sandbox.
- 🧮 **Form fields arrive as strings** — an uncoerced `"2000"` into an `Int`
  column crashes mid-prepare and Click marks the invoice "Not paid" forever.

The [docs](#documentation) explain each one with the symptom you'd actually see.

---

## What's included

```
src/
  lib/payments/
    click.ts        # MD5 sign verify (prepare + complete), body parser, URL builder, error map, types
    payme.ts        # Basic-auth verify, JSON-RPC helpers, checkout URL builder, error codes, types
    schema.ts       # Drizzle `payment_orders` table (shared by both gateways)
    store.ts        # The integration seam — order lookup + fulfilment (you implement fulfilOrder)
  app/api/payments/
    click/prepare/route.ts      # Click action=0
    click/complete/route.ts     # Click action=1
    payme/callback/route.ts     # All six Payme JSON-RPC methods
docs/
  click.md            # Full Click setup guide + every gotcha
  payme.md            # Full Payme setup guide + every gotcha
  deployment-notes.md # The nginx / callback gotchas that take down go-lives
```

**Stack assumed:** Next.js App Router · TypeScript · Postgres · Drizzle ORM.
The crypto/protocol code is ORM-agnostic; only `schema.ts` and `store.ts` are
Drizzle-specific and easy to port.

---

## Quick start

This is a **copy-in starter**, not an npm package — the route handlers call
into your app's DB, so you drop the files into an existing Next.js project.

1. **Copy the source**

   ```bash
   cp -r src/lib/payments      <your-app>/src/lib/payments
   cp -r src/app/api/payments  <your-app>/src/app/api/payments
   ```

2. **Add the table** — merge `payment_orders` from
   [`src/lib/payments/schema.ts`](src/lib/payments/schema.ts) into your Drizzle
   schema, then `npx drizzle-kit generate && npx drizzle-kit migrate`.

3. **Implement the seam** — open
   [`src/lib/payments/store.ts`](src/lib/payments/store.ts) and fill in
   `fulfilOrder()` (grant access / create the purchase record). The rest is
   ready.

4. **Set credentials** — copy [`.env.example`](.env.example) to `.env.local`
   and fill in your Click and Payme keys.

5. **Register your callback URLs** with each gateway (see the docs):
   - Click → `POST /api/payments/click/prepare` and `/complete`
   - Payme → `POST /api/payments/payme/callback`

6. **Test** — Payme has a [sandbox](https://test.paycom.uz/); Click verifies
   from their side with test cards. Walk the [go-live checklists](docs/).

---

## Documentation

| Guide | What it covers |
|---|---|
| **[docs/click.md](docs/click.md)** | Click SHOP API — prepare/complete flow, both MD5 formulas, the 8 gotchas, error codes, go-live checklist |
| **[docs/payme.md](docs/payme.md)** | Payme JSON-RPC — all six methods, tiyin conversion, sandbox idempotency tests, error codes, go-live checklist |
| **[docs/deployment-notes.md](docs/deployment-notes.md)** | The nginx trailing-slash `ERR_TOO_MANY_REDIRECTS` trap and other callback-reachability issues that break go-lives |

**Official references:** [Click SHOP API](https://docs.click.uz/en/shop-api/) ·
[Payme developer docs](https://developer.help.paycom.uz/) ·
[Payme sandbox](https://test.paycom.uz/)

---

## How the flows work

**Click** (gateway hosts the card form):

```
User → your create-order route → redirect to my.click.uz/services/pay
   → Click calls POST /click/prepare  (action=0)  → you return merchant_prepare_id
   → Click charges the card
   → Click calls POST /click/complete (action=1)  → you fulfil the order
   → Click redirects the browser back to your return_url
```

**Payme** (gateway hosts the checkout):

```
User → your create-order route → redirect to checkout.paycom.uz/<base64>
   → Payme calls your single callback over JSON-RPC:
       CheckPerformTransaction → CreateTransaction → PerformTransaction
   → on PerformTransaction you fulfil the order
   → browser returns to your return_url
```

---

## Contributing

Issues and PRs welcome — especially additional gotchas you've hit in
production, error-code corrections, or ports to other ORMs (Prisma, Kysely).
Keep changes surgical and documented.

## License

[MIT](LICENSE) — use it freely, including commercially. No warranty; payment
code is your responsibility to verify before handling real money.
