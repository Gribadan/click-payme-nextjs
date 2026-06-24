# Payme Integration for Next.js — Setup Guide

Project-agnostic runbook for integrating **Payme (Paycom)** payments into a
Next.js App Router app.

- **Protocol:** JSON-RPC 2.0 over HTTPS
- **Official docs:** https://developer.help.paycom.uz/
- **Sandbox:** https://test.paycom.uz/
- **Production checkout:** https://checkout.paycom.uz/
- **Currency:** all amounts in **tiyin** on the Payme side (1 UZS = 100 tiyin)

> If you skip nothing else, read § 4 (Critical gotchas). Each item there cost
> at least one production incident in real deployments.

**Code in this repo:**
[`src/lib/payments/payme.ts`](../src/lib/payments/payme.ts) (helpers),
[`src/lib/payments/store.ts`](../src/lib/payments/store.ts) (DB seam),
[`callback/route.ts`](../src/app/api/payments/payme/callback/route.ts) (all six methods).

---

## 1. What you'll build

A single Next.js API route — `POST /api/payments/payme/callback` — that handles
**all six** Payme JSON-RPC methods. Payme's merchant cabinet calls this URL with
Basic auth; you respond with the proper JSON-RPC envelope.

Flow from a user's perspective:

1. User clicks **Pay** in your app.
2. Your server creates a `payment_orders` row with `status = "pending"`.
3. Your server returns a **Payme checkout URL** to the browser.
4. Browser is redirected to Payme; user pays.
5. Payme calls your callback over JSON-RPC: `CheckPerformTransaction` →
   `CreateTransaction` → `PerformTransaction`.
6. On `PerformTransaction` success, you fulfill the order (mark paid, grant
   access, etc.).
7. User is redirected back to your `return_url`.

---

## 2. Credentials you need from Payme

Go to https://merchant.payme.uz/ → your cabinet (the brand migrated from Paycom
to Payme; the old `merchant.paycom.uz` now 301-redirects here):

| Field | Where it comes from | Storage |
|---|---|---|
| **Kassa ID** (a.k.a. Merchant ID) | Cabinet → "Касса" → ID at top | `PAYME_MERCHANT_ID` |
| **Production secret key** | Cabinet → "Настройки" → API endpoint | `PAYME_SECRET_KEY` |
| **Test secret key** | Cabinet → toggle sandbox | `PAYME_TEST_KEY` |
| **Account field name** | Cabinet → "Настройки" → "Поля корзины". Define ONE field, name it whatever you want — `order_id`, `merchant_trans_id`, etc. Pick a name and **keep it forever**. | `PAYME_ACCOUNT_FIELD` |

For runtime key rotation without a redeploy, move the keys into a `settings`
table and change `getPaymeSettings()` in `store.ts` to read from it.

---

## 3. Database schema

See [`src/lib/payments/schema.ts`](../src/lib/payments/schema.ts). Keep `amount`
in **UZS** (not tiyin), and store Payme's millisecond timestamps in the
`metadata` JSON column, never in integer columns (gotcha #2).

---

## 4. Critical gotchas (the part you came for)

### Gotcha #1 — Amount is in **tiyin** on the wire, but your DB stores UZS

Payme sends `amount: 500000` to mean **5,000 UZS**. Get this conversion wrong
once and you'll either charge 100× or refund customers forever. Every place
you compare to `params.amount`, use `order.amount * 100`:

```ts
if (amount !== order.amount * 100) return paymeError(-31001, "Invalid amount", rpcId);
```

When building the checkout URL, multiply by 100 (`generatePaymeCheckoutUrl`
handles this for you).

### Gotcha #2 — Store Payme timestamps in `metadata` JSON, NOT integer columns

`create_time`, `perform_time`, `cancel_time` are JS-style milliseconds since
epoch — `~1,750,000,000,000`. They **overflow PostgreSQL's `integer` type**
(max ~2.1 billion). The simplest fix is to stash them in the JSON `metadata`
field — see `mergedMeta()` / `readMeta()` in `store.ts`.

### Gotcha #3 — `create_time` must be persisted once and returned identically on retries

Payme's sandbox runs an idempotency test: it calls `CreateTransaction` twice
in a row with the same Payme transaction ID and expects the **second response to
equal the first** ("ответ должен совпадать с ответом из первого запроса"). The
documented rule is about *idempotency of the stored value*, not the *source* of
the timestamp.

So: **persist `create_time` on the first call and return the stored value on
every retry.** Per the official Payme docs, `create_time` is "the transaction
creation time in the merchant's system" — a server-side value (the official
PaycomUZ reference template uses the server clock). This repo stores
`params.time`, which is stable across the two duplicate calls and therefore also
satisfies the sandbox; either source is fine as long as it's stored once and
echoed identically. What breaks the test is generating a **fresh** `Date.now()`
on the retry — then the two responses differ by a few ms and you can't go live.

### Gotcha #4 — `perform_time` must persist even after cancellation

Cancellation state `-2` (cancelled-after-perform / refund) must return both
`perform_time` AND `cancel_time` in `CheckTransaction`. If you only update
the `metadata` on cancel without preserving `payme_perform_time`, you fail
the sandbox refund test.

### Gotcha #5 — Transaction lookup needs a fallback

Production Payme sends its own transaction ID in `params.id`. The sandbox
sometimes sends your `order_id` instead. Check both — `findByPaymeTransId()`
in `store.ts` does this (look up by `providerTransId`, then by `id`).

### Gotcha #6 — Error codes must be EXACT

Payme sandbox validates the exact integer code, not the message. Wrong code
= test failure. Memorize these:

| Code | Meaning | When to use |
|---|---|---|
| `-31001` | Invalid amount | `amount !== order.amount * 100` |
| `-31003` | Transaction not found | lookup returns null |
| `-31007` | Cannot cancel | goods/services already delivered (only if your sale is non-refundable) |
| `-31008` | Cannot perform operation | wrong transaction **state**: order already paid, busy, or timed out |
| `-31050` to `-31099` | Invalid `account` input | order/account not found — **must** include `data: "<account_field_name>"` |
| `-32504` | Auth failed | bad Basic auth header |
| `-32601` | Method not found | unknown RPC method |
| `-32700` | Invalid JSON | body parse error |

Two things the official docs are strict about, and that earlier versions of this
guide got wrong:

- The **`-31050…-31099` range is reserved for invalid `account` input only**
  (e.g. the `order_id` doesn't exist) and every response in it **must** include
  `data: "<account_field_name>"` so Payme highlights the right cart field. It is
  a merchant-defined range — no single code in it is pre-defined by Payme.
- **Transaction-state problems use `-31008`, not the `-31050` range.** "Order
  already paid" / "order busy" are state conditions → return `-31008`. There is
  **no official `-31060`**; don't invent codes inside the account range for
  state conditions.

### Gotcha #7 — Response Content-Type matters

Payme expects `Content-Type: text/json; charset=UTF-8` on responses, NOT
`application/json`. The `json()` helper in `payme.ts` sets this.

### Gotcha #8 — Idempotency on every method

Every method must return the **same** result if called twice with the same
params:

- `CreateTransaction` called twice with same Payme `id` → return the original
  `create_time` and `state`, not fresh values.
- `PerformTransaction` called twice on an already-paid order → return the
  stored `perform_time` and `state: 2`, NOT an error.
- `CancelTransaction` called twice → return the stored `cancel_time` and
  the negative state.

If you treat repeated calls as errors, the sandbox will fail you.

---

## 5. The six JSON-RPC methods

All implemented in
[`callback/route.ts`](../src/app/api/payments/payme/callback/route.ts), switched
on `body.method`:

```ts
switch (method) {
  case "CheckPerformTransaction": return json(await checkPerform(params, rpcId));
  case "CreateTransaction":       return json(await createTransaction(params, rpcId));
  case "PerformTransaction":      return json(await performTransaction(params, rpcId));
  case "CancelTransaction":       return json(await cancelTransaction(params, rpcId));
  case "CheckTransaction":        return json(await checkTransaction(params, rpcId));
  case "GetStatement":            return json(await getStatement(params, rpcId));
  default: return json(paymeError(-32601, "Method not found", rpcId));
}
```

- **CheckPerformTransaction** — pre-flight before showing the pay UI. Validate
  the order exists and amount matches. Write nothing.
- **CreateTransaction** — reserve the order, store `params.time` as
  `create_time`. Handle the new-vs-retry cases (gotcha #3, #8).
- **PerformTransaction** — user paid. **This is where you fulfil** (`fulfilOrder`).
- **CancelTransaction** — flip state to `-1` (before perform) or `-2` (refund),
  preserving `perform_time`.
- **CheckTransaction** — return all timestamps + current state. `perform_time`
  and `cancel_time` must persist across cancellations (gotcha #4).
- **GetStatement** — return all transactions in a date range for reconciliation.

---

## 6. Authentication

Payme sends `Authorization: Basic base64("Paycom:<key>")` on every callback.
`verifyPaymeAuth()` in `payme.ts` accepts **both** the production and test keys
so sandbox tests still pass after the production switch. Return
`paymeError(-32504, ...)` on mismatch. Never log the key — log only
`success | failed`.

---

## 7. Checkout URL generator

`generatePaymeCheckoutUrl()` in `payme.ts`:

```ts
const amountTiyin = amount * 100;
const merchantParams = Buffer.from(
  `m=${merchantId};ac.${ACCOUNT_FIELD_NAME}=${orderId};a=${amountTiyin}`
).toString("base64");
const baseUrl = isTest ? "https://test.paycom.uz" : "https://checkout.paycom.uz";
return `${baseUrl}/${merchantParams}`;
```

Use it in your "create order" endpoint, then `window.location.href = url` on the
client.

---

## 8. Configure the Payme cabinet

1. **API endpoint:** `https://yourapp.com/api/payments/payme/callback`
2. **HTTP method:** `POST`
3. **Auth:** Basic
4. **Поля корзины (cart fields):** add one field
   - **Name (внутреннее имя):** must match `PAYME_ACCOUNT_FIELD` in your env
   - **Display name:** whatever shows to the customer
   - **Required:** yes

Once configured, run all sandbox tests in https://test.paycom.uz/ before
asking Payme to enable production.

---

## 9. Testing in sandbox

1. Set `PAYME_SANDBOX=true` (or pass `isTest` when building the checkout URL).
2. Create a test order in DB:
   ```sql
   INSERT INTO payment_orders (id, user_id, purchase_type, target_id,
     amount, provider, status, created_at, updated_at)
   VALUES ('test-1', 'user-1', 'course', 'course-1', 1000, 'payme',
     'pending', now(), now());
   ```
3. Go to https://test.paycom.uz/, paste your endpoint URL, paste a test key.
4. Run each method in order:
   `CheckPerformTransaction` → `CreateTransaction` → `PerformTransaction` →
   `CheckTransaction` → `CancelTransaction` (creates a refund) → `GetStatement`.
5. **One order = one full test cycle.** Create a fresh order for each run — the
   sandbox checks state transitions strictly.

If any test fails, the sandbox shows the exact JSON it expected. Compare
field-by-field — it's almost always a missing field, wrong type (string vs
number), or wrong timestamp source.

---

## 10. Production go-live checklist

- [ ] All 6 sandbox tests pass for at least one order
- [ ] Cabinet API endpoint set to production URL (https, not http)
- [ ] Cabinet account field name matches `PAYME_ACCOUNT_FIELD` in env
- [ ] Production secret key in env / settings (NOT committed to git)
- [ ] Test key kept around — toggle sandbox without redeploy
- [ ] Order `id` column is a UUID, not autoincrement (prevents enumeration)
- [ ] `payment_orders` has indexes on `(provider, provider_trans_id)`, `status`
- [ ] Callback is reachable from public internet (not blocked by firewall)
- [ ] If behind Cloudflare, callback URL is NOT excluded from CF — Payme
      sends real-world IPs that change, don't try to allowlist them
- [ ] Server logs every callback (method, status) but NEVER the auth key
- [ ] No 308/301 redirect on the callback path — no trailing-slash mismatch
      (see [deployment-notes.md](deployment-notes.md))
- [ ] Tested the full user flow: create order → redirect → pay → fulfill → return

---

## 11. Common errors when going live

| Symptom | Most likely cause |
|---|---|
| All callbacks return `-32504` | Auth header decode wrong, or you check `Paycom:Paycom:key` instead of `Paycom:key` |
| Sandbox: "create_time mismatch" | Generating a fresh timestamp on the retry instead of returning the stored `create_time` (gotcha #3) |
| Sandbox: "Cannot test cancel-after-perform" | `perform_time` not preserved after cancel (gotcha #4) |
| Production: amounts off by 100× | Forgot tiyin → UZS conversion (gotcha #1) |
| `Internal error` 500s in production | Integer overflow on timestamps — move them to JSON metadata (gotcha #2) |
| Callback gets `ERR_TOO_MANY_REDIRECTS` | nginx location with trailing slash. See [deployment-notes.md](deployment-notes.md) |

---

## 12. What NOT to change after go-live

These are configured in Payme's cabinet — changing them on your side without
also updating the cabinet will break every callback:

- **Callback URL** — must match cabinet exactly
- **Account field name** — must match cabinet exactly
- **JSON-RPC response shape** — Payme validates fields strictly
- **Error code ranges** — sandbox locks you to specific codes
- **Content-Type** — `text/json; charset=UTF-8` (the Merchant API uses
  `text/json`, **not** `application/json` — confirmed in the official docs)
- **`create_time` idempotency** — persist it on the first `CreateTransaction`
  and return the **same stored value** on every retry (don't regenerate it)
