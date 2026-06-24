# Click Integration for Next.js — Setup Guide

Project-agnostic runbook for integrating **Click** payments (SHOP API) into a
Next.js App Router app.

- **Protocol:** HTTPS with **MD5-signed form-encoded** requests
- **Official docs:** https://docs.click.uz/click-api/ (Click SHOP API)
- **Payment URL base:** `https://my.click.uz/services/pay`
- **Currency:** plain UZS (no tiyin conversion, unlike Payme)

> Read § 3 (Critical gotchas) before writing a single line. Three of them
> have caused production outages in real Click integrations.

**Code in this repo:**
[`src/lib/payments/click.ts`](../src/lib/payments/click.ts) (helpers),
[`src/lib/payments/store.ts`](../src/lib/payments/store.ts) (DB seam),
[`prepare/route.ts`](../src/app/api/payments/click/prepare/route.ts),
[`complete/route.ts`](../src/app/api/payments/click/complete/route.ts).

---

## 1. What you'll build

Two Next.js API routes:

- `POST /api/payments/click/prepare`  — Click's pre-auth call (`action=0`)
- `POST /api/payments/click/complete` — Click's post-payment call (`action=1`)

Plus one client-side redirect — your "Create Order" endpoint generates a URL to
`my.click.uz/services/pay` and the browser jumps there. Click hosts the actual
payment UI.

Flow:

1. User clicks **Pay** → your server creates a `payment_orders` row → returns a
   Click URL → browser redirected.
2. User enters card details on Click's page and confirms.
3. Click calls `POST /api/payments/click/prepare` with `action=0`. You verify
   amount, return `merchant_prepare_id`.
4. Click charges the card.
5. Click calls `POST /api/payments/click/complete` with `action=1`. You verify
   prepare_id, fulfill the order.
6. Click redirects browser to your `return_url`.

---

## 2. Credentials you need from Click

Get the Click cabinet (https://my.click.uz/) for your merchant. You need:

| Field | Where | Storage |
|---|---|---|
| **service_id** | Cabinet → My services → Service ID | `CLICK_SERVICE_ID` |
| **merchant_id** | Cabinet → Account | `CLICK_MERCHANT_ID` |
| **Secret key** | Cabinet → API settings → "Secret key" (NOT login password) | `CLICK_SECRET_KEY` |
| **Endpoint URLs** | You provide to Click support: `https://yourapp.com/api/payments/click/prepare` and `/complete` | Configured by Click |

The secret key must be set by Click support — there's no self-serve UI for
it in some merchant accounts. Email them with your two endpoint URLs and ask
for the secret key.

---

## 3. Critical gotchas

### Gotcha #1 — Click sends `application/x-www-form-urlencoded`, NOT JSON

Hands-down the most common reason a Click integration fails on day one. The
Click servers POST form data, not JSON. Next.js' `request.json()` will reject
it. Always parse both — `parseClickBody()` in `click.ts` does this:

```ts
const contentType = request.headers.get("content-type") ?? "";
if (contentType.includes("application/json")) {
  return (await request.json()) as ClickRawParams;
}
const text = await request.text();
return Object.fromEntries(new URLSearchParams(text)) as unknown as ClickRawParams;
```

Without this, you'll get HTTP 400 on every Click callback and the orders
will sit forever in "pending" status while you blame everything else.

### Gotcha #2 — Two different signature formulas for `prepare` vs `complete`

The MD5 hash inputs are **almost identical** but Complete inserts an extra
field. Hours have been wasted on this. Memorize:

**Prepare (`action=0`):**
```
md5( click_trans_id + service_id + SECRET_KEY +
     merchant_trans_id + amount + action + sign_time )
```

**Complete (`action=1`):**
```
md5( click_trans_id + service_id + SECRET_KEY +
     merchant_trans_id + merchant_prepare_id +     ← only in complete!
     amount + action + sign_time )
```

All values are concatenated as **raw strings** (no JSON, no separator).
Compare the resulting hex to `params.sign_string`. See `verifyPrepareSign` /
`verifyCompleteSign` in `click.ts`.

### Gotcha #3 — `merchant_prepare_id` must be a 32-bit integer

Click expects an integer in its DB column. If you set it to `Date.now()` you
overflow `int32` (~2.1 billion) and Click silently rejects the prepare. Modulo
fixes it (`generatePrepareId()` in `click.ts`):

```ts
const prepareId = Date.now() % 2147483647;
```

The same prepare_id must be returned on the Complete call, so persist it on the
order.

### Gotcha #4 — Verify amount as integer, not float

Click sends `amount` as a string that parses to a float. If your DB stores it
as integer UZS, do an integer compare:

```ts
const clickAmount = Math.round(Number(params.amount));
if (clickAmount !== order.amount) return /* INCORRECT_AMOUNT */;
```

Floats can drift by 0.0000001 in the wire format — never `===` them.

### Gotcha #4b — Coerce EVERY numeric field before any DB write or strict compare

This is gotcha #1's nastier sibling. Once your urlencoded parsing is in place,
the body actually populates — but every field arrives as a **string**.
JavaScript arithmetic silently coerces (`"2000" - 2000 === 0`), so amount-
comparison code "looks fine"; the bug only fires later when a string hits a
strict-typed boundary. The most common one: an ORM whose schema declares the
column as `Int` and rejects strings at insert time. The crash trace looks like:

```
PrismaClientValidationError:
  Invalid `prisma.payment.create()` invocation
  Argument `amount`: Invalid value provided. Expected Int, provided String.
  data: { amount: "2000" }   // ← string from form body, not coerced before insert
```

The handler crashes mid-prepare, the response body is empty, and Click marks
the invoice **"Не оплачен" (Not paid) — forever.** Customers see "payment
succeeded" on Click's card form but credits never land; refund tickets follow.

Coerce at **every** numeric write or strict compare site:

```ts
const amountInt    = Math.round(Number(params.amount));
const clickTransId = Number(params.click_trans_id);
const action       = Number(params.action);             // for === 0 / === 1 dispatch
const prepareId    = Number(params.merchant_prepare_id);
const errorCode    = Number(params.error);              // for `< 0` failure path
```

The signature MD5 input is the one place that **must** keep raw strings (the
template literal concatenates whatever Click sent verbatim — coercing here
desyncs you from their hash). Everywhere else, coerce on read.

### Gotcha #5 — Idempotency on duplicate complete calls

Click occasionally retries `complete` after success. If you re-fulfill the
order, you double-grant access. Always check status first and return SUCCESS
with an "Already confirmed" note (see `complete/route.ts`).

### Gotcha #6 — `error < 0` in complete means payment FAILED

When the cardholder's bank declines, Click still calls your `complete`
endpoint — with `error: -<some negative int>`. Your job is to mark the order
as failed, not fulfill it:

```ts
if (Number(params.error) < 0) {
  await updateOrder(order.id, { status: "failed", errorCode: Number(params.error) });
  return /* TRANSACTION_CANCELLED */;
}
```

---

## 4. Database schema

See [`src/lib/payments/schema.ts`](../src/lib/payments/schema.ts). The same
`payment_orders` table serves both Click and Payme — the `provider` column
distinguishes them. `amount` is stored in plain UZS; `prepare_id` holds the
32-bit `merchant_prepare_id`.

---

## 5. Error codes (must be exact)

```ts
export const CLICK_ERRORS = {
  SUCCESS: 0,
  SIGN_CHECK_FAILED: -1,
  INCORRECT_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  ORDER_NOT_FOUND: -5,
  TRANSACTION_NOT_FOUND: -6,
  FAILED_TO_UPDATE: -7,
  ERROR_IN_REQUEST: -8,
  TRANSACTION_CANCELLED: -9,
} as const;
```

Click compares the exact integer in your response — don't invent new codes
or repurpose. Always return JSON
`{ click_trans_id, merchant_trans_id, merchant_prepare_id|merchant_confirm_id, error, error_note }`.

---

## 6. Payment URL generator

`generateClickPaymentUrl()` in `click.ts`:

```ts
const url = new URL("https://my.click.uz/services/pay");
url.searchParams.set("service_id", serviceId);
url.searchParams.set("merchant_id", merchantId);
url.searchParams.set("amount", String(amount));      // plain UZS, no tiyin
url.searchParams.set("transaction_param", orderId);  // becomes merchant_trans_id
url.searchParams.set("return_url", returnUrl);
```

Used in your create-order route:
```ts
const order = await createPaymentOrder({ id: crypto.randomUUID(), amount, userId, provider: "click", ... });
const url = generateClickPaymentUrl({ serviceId, merchantId, orderId: order.id, amount, returnUrl: "https://yourapp.com/checkout/success" });
return NextResponse.json({ url });
```

---

## 7. Configuring with Click support

Send them an email (or via the cabinet ticket system):

> Hi, we'd like to set up the SHOP API integration. Please configure:
>
> - **Prepare URL:** `https://yourapp.com/api/payments/click/prepare`
> - **Complete URL:** `https://yourapp.com/api/payments/click/complete`
>
> Please also send us the secret key for signature verification.

Click typically takes 1–3 business days to set this up. They'll test from
their side using cards on your endpoints before flipping you live.

---

## 8. Testing

There's no public Click sandbox like Payme has. Two practical options:

1. **Live small-amount test cards:** ask Click support for the test card
   numbers they use during integration verification — most merchant managers
   share them on request.
2. **curl-from-localhost simulation:** mock the Click payload yourself.
   Useful for verifying signature logic before going live.

   ```bash
   # Generate a valid sign_string in Python REPL:
   python -c "
   import hashlib
   d = '{trans_id}{service_id}{secret}{order_id}{amount}{action}{sign_time}'
   print(hashlib.md5(d.encode()).hexdigest())"

   # Then curl your endpoint:
   curl -X POST https://yourapp.com/api/payments/click/prepare \
     -d "click_trans_id=12345&service_id=100&merchant_trans_id=order-1&amount=10000&action=0&sign_time=2025-01-01%2012:00:00&sign_string=<hash>"
   ```

---

## 9. Production go-live checklist

- [ ] Both prepare and complete URLs return JSON (not HTML) for any input,
      even malformed — Click parses the response and chokes on HTML
- [ ] Both endpoints handle `application/x-www-form-urlencoded` (gotcha #1)
- [ ] MD5 signature verification implemented for **both** prepare AND complete
      (different formulas, gotcha #2)
- [ ] `merchant_prepare_id` is generated as a 32-bit-safe integer (gotcha #3)
- [ ] Status flow is `pending → preparing → paid` with `failed` and `cancelled`
      as terminal states
- [ ] Amount comparison uses `Math.round(Number(x))` not float `===` (gotcha #4)
- [ ] Every numeric Click field is coerced via `Number(...)` before any DB
      write, ORM insert, or strict `===` compare (gotcha #4b)
- [ ] Complete handler treats `params.error < 0` as failure, not success (gotcha #6)
- [ ] Already-paid orders return SUCCESS with `"Already confirmed"` note (gotcha #5)
- [ ] Server logs every callback (sanitized — never log the secret key)
- [ ] Click cabinet has correct production endpoint URLs
- [ ] nginx location for `/api/payments/click/*` does NOT use a trailing slash
      (see [deployment-notes.md](deployment-notes.md))

---

## 10. Common errors when going live

| Symptom | Most likely cause |
|---|---|
| All callbacks return HTTP 400 / no logs in app | You're parsing as JSON, Click sends form-encoded (gotcha #1) |
| Signature always invalid in prepare | Wrong field order in MD5 input, or service_id type mismatch |
| Signature valid in prepare but fails in complete | Missing `merchant_prepare_id` between fields (gotcha #2) |
| `INCORRECT_AMOUNT` on legit payments | Float vs int compare. Use `Math.round` (gotcha #4) |
| Click cabinet shows invoice "Не оплачен" / "Not paid" even though the user reached the success screen | Your prepare crashed mid-handler — usually a string-vs-Int crash at DB insert (gotcha #4b). Card was never debited. Tail logs for `PrismaClientValidationError` / `Invalid input type` |
| Orders fulfilled twice for one payment | Idempotency missing on complete (gotcha #5) |
| Failed payments still grant access | Not checking `params.error < 0` (gotcha #6) |
| `merchant_prepare_id` rejected by Click | Used unmodded `Date.now()` → overflow (gotcha #3) |
| Click callback returns timeout | nginx blocked it or a CF rule. See [deployment-notes.md](deployment-notes.md) |

---

## 11. What NOT to change after go-live

- **Endpoint paths** — configured at Click's side
- **Signature input field order** — strict
- **Error code ints** — Click checks exact values
- **Field names in response** (`click_trans_id`, `merchant_trans_id`,
  `merchant_prepare_id`, `merchant_confirm_id`, `error`, `error_note`)
- **Service ID and merchant ID** in the payment URL
