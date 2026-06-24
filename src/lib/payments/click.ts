/**
 * Click (SHOP API) — protocol-correct helpers. No DB, no app deps.
 *
 * Everything here is portable: signature verification, request parsing,
 * the response/error builder, the payment-URL generator, and the types.
 * The route handlers in src/app/api/payments/click/* import from this file.
 *
 * Full walkthrough + every gotcha: docs/click.md
 */
import { createHash } from "crypto";

// ── Error codes — Click compares the EXACT integer. Don't invent new ones. ──
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

export type ClickErrorCode = (typeof CLICK_ERRORS)[keyof typeof CLICK_ERRORS];

// ── Types ───────────────────────────────────────────────────────────────────
/**
 * Click POSTs form-encoded strings; we keep them as strings until the point of
 * use. The signature MD5 input MUST use the raw strings verbatim — coercing
 * before hashing desyncs you from Click's hash. Coerce everywhere else.
 */
export interface ClickRawParams {
  click_trans_id: string;
  service_id: string;
  click_paydoc_id?: string;
  merchant_trans_id: string; // your payment_order.id
  merchant_prepare_id?: string; // present on complete (action=1)
  amount: string;
  action: string; // "0" = prepare, "1" = complete
  error?: string;
  error_note?: string;
  sign_time: string;
  sign_string: string;
}

export interface ClickResponse {
  click_trans_id: string;
  merchant_trans_id: string;
  merchant_prepare_id?: number; // returned by prepare
  merchant_confirm_id?: number; // returned by complete
  error: number;
  error_note: string;
}

// ── Gotcha #1: Click sends application/x-www-form-urlencoded, NOT JSON ───────
// request.json() rejects it with a generic 400 and your orders sit pending.
// Parse both content types so you're robust to either.
export async function parseClickBody(request: Request): Promise<ClickRawParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json()) as ClickRawParams;
  }
  const text = await request.text();
  return Object.fromEntries(new URLSearchParams(text)) as unknown as ClickRawParams;
}

// ── Gotcha #2: prepare and complete use DIFFERENT md5 inputs ─────────────────
// Complete inserts merchant_prepare_id between merchant_trans_id and amount.
// All values concatenated as raw strings, no separator.
export function verifyPrepareSign(p: ClickRawParams, secretKey: string): boolean {
  const data =
    `${p.click_trans_id}${p.service_id}${secretKey}` +
    `${p.merchant_trans_id}${p.amount}${p.action}${p.sign_time}`;
  return createHash("md5").update(data).digest("hex") === p.sign_string;
}

export function verifyCompleteSign(p: ClickRawParams, secretKey: string): boolean {
  const data =
    `${p.click_trans_id}${p.service_id}${secretKey}` +
    `${p.merchant_trans_id}${p.merchant_prepare_id}${p.amount}${p.action}${p.sign_time}`;
  return createHash("md5").update(data).digest("hex") === p.sign_string;
}

// ── Response builder ─────────────────────────────────────────────────────────
// Always return JSON (never HTML) with the exact field names Click expects.
// `idField` switches between merchant_prepare_id (prepare) and
// merchant_confirm_id (complete).
export function clickResponse(args: {
  clickTransId: string;
  merchantTransId: string;
  error: number;
  errorNote?: string;
  prepareId?: number;
  idField?: "merchant_prepare_id" | "merchant_confirm_id";
}): ClickResponse {
  const note =
    args.errorNote ??
    (args.error === CLICK_ERRORS.SUCCESS ? "Success" : "Error");
  const res: ClickResponse = {
    click_trans_id: args.clickTransId,
    merchant_trans_id: args.merchantTransId,
    error: args.error,
    error_note: note,
  };
  if (args.prepareId !== undefined) {
    res[args.idField ?? "merchant_prepare_id"] = args.prepareId;
  }
  return res;
}

// ── Gotcha #3: merchant_prepare_id must be a 32-bit integer ──────────────────
// Date.now() overflows int32 (~2.1e9) and Click silently rejects the prepare.
export function generatePrepareId(): number {
  return Date.now() % 2147483647;
}

// ── Payment URL generator ────────────────────────────────────────────────────
// Click currency is plain UZS — no tiyin conversion (unlike Payme).
export function generateClickPaymentUrl(args: {
  serviceId: string;
  merchantId: string;
  orderId: string; // becomes merchant_trans_id
  amount: number; // plain UZS
  returnUrl: string;
}): string {
  const url = new URL("https://my.click.uz/services/pay");
  url.searchParams.set("service_id", args.serviceId);
  url.searchParams.set("merchant_id", args.merchantId);
  url.searchParams.set("amount", String(args.amount));
  url.searchParams.set("transaction_param", args.orderId);
  url.searchParams.set("return_url", args.returnUrl);
  return url.toString();
}
