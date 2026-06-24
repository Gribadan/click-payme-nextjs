/**
 * Payme (Paycom) — protocol-correct helpers. No DB, no app deps.
 *
 * JSON-RPC envelope builders, Basic-auth verification, the checkout-URL
 * generator, error codes, and types. The single callback route in
 * src/app/api/payments/payme/callback imports from this file.
 *
 * Full walkthrough + every gotcha: docs/payme.md
 */
import { NextResponse } from "next/server";

// The single cart-field name you defined in the Payme cabinet (Поля корзины).
// MUST match the cabinet exactly and never change after go-live.
export const ACCOUNT_FIELD_NAME = process.env.PAYME_ACCOUNT_FIELD || "order_id";

// ── Error codes — Payme sandbox validates the EXACT integer, not the message ──
// Sourced from https://developer.help.paycom.uz/metody-merchant-api/oshibki-errors/
export const PAYME_ERRORS = {
  INVALID_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  CANNOT_CANCEL: -31007, // can't cancel: goods/services already delivered
  CANNOT_PERFORM: -31008, // wrong transaction state (e.g. order already paid / busy)
  // -31050..-31099 is a MERCHANT-DEFINED range reserved for invalid `account`
  // input ONLY (e.g. order_id not found). Responses in this range MUST include
  // `data: "<account_field_name>"`. No single code in the range is pre-defined
  // by Payme — do NOT use it for transaction-state conditions (use -31008).
  ACCOUNT_ERROR: -31050,
  AUTH_FAILED: -32504,
  METHOD_NOT_FOUND: -32601,
  INVALID_JSON: -32700,
} as const;

// Transaction states (Payme's vocabulary)
export const PAYME_STATE = {
  PENDING: 1,
  PAID: 2,
  CANCELLED_BEFORE_PERFORM: -1,
  CANCELLED_AFTER_PERFORM: -2,
} as const;

// ── Types ────────────────────────────────────────────────────────────────────
export interface PaymeRpcRequest {
  jsonrpc?: string;
  id: number | string;
  method: string;
  params: PaymeParams;
}

export interface PaymeParams {
  id?: string; // Payme transaction id
  time?: number; // ms epoch — store this AS create_time, never Date.now()
  amount?: number; // tiyin
  account?: Record<string, string>;
  reason?: number;
  from?: number;
  to?: number;
}

export interface PaymeSettings {
  merchantId: string;
  secretKey: string;
  testKey?: string;
}

// ── Gotcha #7: response Content-Type must be text/json, not application/json ──
export function json(body: unknown): NextResponse {
  return NextResponse.json(body, {
    headers: { "Content-Type": "text/json; charset=UTF-8" },
  });
}

// JSON-RPC success envelope.
export function paymeResult(result: unknown, id: number | string) {
  return { jsonrpc: "2.0", id, result };
}

// JSON-RPC error envelope. `data` is required for the -31050..-31099 range so
// Payme can highlight the right cart field to the user.
export function paymeError(
  code: number,
  message: string,
  id: number | string,
  data?: string,
) {
  const error: { code: number; message: string; data?: string } = {
    code,
    message,
  };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

// ── Authentication ───────────────────────────────────────────────────────────
// Payme sends `Authorization: Basic base64("Paycom:<key>")` on every callback.
// Accept BOTH production and test keys so sandbox tests keep passing after the
// production switch. Never log the key itself — log only success | failed.
export function verifyPaymeAuth(
  authHeader: string | null,
  settings: PaymeSettings,
): boolean {
  if (!authHeader?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  const login = decoded.slice(0, sep);
  const key = decoded.slice(sep + 1);
  if (login !== "Paycom") return false;
  return key === settings.secretKey || key === settings.testKey;
}

// ── Checkout URL generator ───────────────────────────────────────────────────
// Gotcha #1: amount is in tiyin on the Payme side (1 UZS = 100 tiyin).
export function generatePaymeCheckoutUrl(args: {
  merchantId: string;
  orderId: string;
  amount: number; // plain UZS — converted to tiyin here
  isTest?: boolean;
}): string {
  const amountTiyin = args.amount * 100;
  const merchantParams = Buffer.from(
    `m=${args.merchantId};ac.${ACCOUNT_FIELD_NAME}=${args.orderId};a=${amountTiyin}`,
  ).toString("base64");
  const baseUrl = args.isTest
    ? "https://test.paycom.uz"
    : "https://checkout.paycom.uz";
  return `${baseUrl}/${merchantParams}`;
}
