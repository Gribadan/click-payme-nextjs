/**
 * Payme (Paycom) single callback — handles all six JSON-RPC methods.
 *
 * Registered with Payme as: POST https://yourapp.com/api/payments/payme/callback
 * Auth is HTTP Basic: base64("Paycom:<key>").
 *
 * Every method is idempotent — Payme (and its sandbox) calls them repeatedly
 * and expects the SAME result each time. See docs/payme.md for the full spec.
 */
import {
  ACCOUNT_FIELD_NAME,
  PAYME_ERRORS,
  PAYME_STATE,
  paymeError,
  paymeResult,
  verifyPaymeAuth,
  json,
  type PaymeParams,
} from "@/lib/payments/payme";
import {
  getPaymeSettings,
  getOrderById,
  findByPaymeTransId,
  updateOrder,
  mergedMeta,
  readMeta,
  fulfilOrder,
  getOrdersInRange,
} from "@/lib/payments/store";
import type { PaymentOrder } from "@/lib/payments/schema";

// Payme cancels a transaction left pending longer than 12 hours (720 min).
const TX_TIMEOUT_MS = 12 * 60 * 60 * 1000;

// ── State + timestamp helpers ────────────────────────────────────────────────
function paymeState(order: PaymentOrder): number {
  if (order.status === "paid") return PAYME_STATE.PAID;
  if (order.status === "cancelled" || order.status === "failed") {
    return order.errorCode === PAYME_STATE.CANCELLED_AFTER_PERFORM
      ? PAYME_STATE.CANCELLED_AFTER_PERFORM
      : PAYME_STATE.CANCELLED_BEFORE_PERFORM;
  }
  return PAYME_STATE.PENDING; // pending / preparing
}

const createTime = (o: PaymentOrder) => readMeta(o).payme_create_time ?? 0;
const performTime = (o: PaymentOrder) => readMeta(o).payme_perform_time ?? 0;
const cancelTime = (o: PaymentOrder) => readMeta(o).payme_cancel_time ?? 0;
const cancelReason = (o: PaymentOrder) => readMeta(o).payme_cancel_reason ?? null;

// ── Entry point ──────────────────────────────────────────────────────────────
export async function POST(request: Request) {
  const settings = getPaymeSettings();

  // Auth — never log the key, only the outcome (gotcha: -32504)
  if (!verifyPaymeAuth(request.headers.get("authorization"), settings)) {
    return json(paymeError(PAYME_ERRORS.AUTH_FAILED, "Auth failed", 0));
  }

  let body: { id: number | string; method: string; params: PaymeParams };
  try {
    body = await request.json();
  } catch {
    return json(paymeError(PAYME_ERRORS.INVALID_JSON, "Invalid JSON", 0));
  }

  const { id: rpcId, method, params } = body;

  switch (method) {
    case "CheckPerformTransaction":
      return json(await checkPerform(params, rpcId));
    case "CreateTransaction":
      return json(await createTransaction(params, rpcId));
    case "PerformTransaction":
      return json(await performTransaction(params, rpcId));
    case "CancelTransaction":
      return json(await cancelTransaction(params, rpcId));
    case "CheckTransaction":
      return json(await checkTransaction(params, rpcId));
    case "GetStatement":
      return json(await getStatement(params, rpcId));
    default:
      return json(paymeError(PAYME_ERRORS.METHOD_NOT_FOUND, "Method not found", rpcId));
  }
}

// ── CheckPerformTransaction ──────────────────────────────────────────────────
// Pre-flight before showing the user the pay UI. Validate only; write nothing.
async function checkPerform(params: PaymeParams, rpcId: number | string) {
  const accountId = params.account?.[ACCOUNT_FIELD_NAME];
  const amount = Number(params.amount);
  if (!accountId)
    return paymeError(PAYME_ERRORS.ORDER_BUSY, "Order not found", rpcId, ACCOUNT_FIELD_NAME);
  const order = await getOrderById(accountId);
  if (!order)
    return paymeError(PAYME_ERRORS.ORDER_BUSY, "Order not found", rpcId, ACCOUNT_FIELD_NAME);
  if (amount !== order.amount * 100) // gotcha #1: tiyin
    return paymeError(PAYME_ERRORS.INVALID_AMOUNT, "Invalid amount", rpcId);
  return paymeResult({ allow: true }, rpcId);
}

// ── CreateTransaction ────────────────────────────────────────────────────────
async function createTransaction(params: PaymeParams, rpcId: number | string) {
  const accountId = params.account?.[ACCOUNT_FIELD_NAME];
  if (!accountId)
    return paymeError(PAYME_ERRORS.ORDER_BUSY, "Order not found", rpcId, ACCOUNT_FIELD_NAME);
  const order = await getOrderById(accountId);
  if (!order)
    return paymeError(PAYME_ERRORS.ORDER_BUSY, "Order not found", rpcId, ACCOUNT_FIELD_NAME);
  if (Number(params.amount) !== order.amount * 100)
    return paymeError(PAYME_ERRORS.INVALID_AMOUNT, "Invalid amount", rpcId);

  // Retry of the SAME Payme transaction → must be idempotent (gotcha #3, #8)
  if (order.providerTransId === params.id) {
    const state = paymeState(order);
    if (state !== PAYME_STATE.PENDING)
      return paymeError(PAYME_ERRORS.CANNOT_PERFORM, "Cannot perform", rpcId);
    if (Date.now() - createTime(order) > TX_TIMEOUT_MS) {
      await updateOrder(order.id, {
        status: "cancelled",
        errorCode: PAYME_STATE.CANCELLED_BEFORE_PERFORM,
        metadata: mergedMeta(order, { payme_cancel_time: Date.now() }),
      });
      return paymeError(PAYME_ERRORS.CANNOT_PERFORM, "Timed out", rpcId);
    }
    return paymeResult(
      { transaction: order.id, state: PAYME_STATE.PENDING, create_time: createTime(order) },
      rpcId,
    );
  }

  // A DIFFERENT transaction already claimed this order
  if (order.providerTransId) {
    const state = paymeState(order);
    if (state === PAYME_STATE.PAID)
      return paymeError(PAYME_ERRORS.ALREADY_PAID, "Order already paid", rpcId);
    if (state === PAYME_STATE.PENDING)
      return paymeError(PAYME_ERRORS.ORDER_BUSY, "Order busy", rpcId, ACCOUNT_FIELD_NAME);
  }

  // Brand new transaction. Store params.time as create_time — NEVER Date.now()
  // (gotcha #3: the sandbox calls this twice and compares create_time).
  await updateOrder(order.id, {
    status: "preparing",
    providerTransId: params.id ?? null,
    metadata: mergedMeta(order, { payme_create_time: params.time ?? 0 }),
  });
  return paymeResult(
    { transaction: order.id, state: PAYME_STATE.PENDING, create_time: params.time ?? 0 },
    rpcId,
  );
}

// ── PerformTransaction ───────────────────────────────────────────────────────
// User completed payment. THIS is where you fulfil.
async function performTransaction(params: PaymeParams, rpcId: number | string) {
  const order = await findByPaymeTransId(params.id ?? "");
  if (!order)
    return paymeError(PAYME_ERRORS.TRANSACTION_NOT_FOUND, "Transaction not found", rpcId);

  const state = paymeState(order);
  if (state === PAYME_STATE.PAID)
    return paymeResult(
      { transaction: order.id, state: PAYME_STATE.PAID, perform_time: performTime(order) },
      rpcId,
    ); // idempotent (gotcha #8)
  if (state !== PAYME_STATE.PENDING)
    return paymeError(PAYME_ERRORS.CANNOT_PERFORM, "Cannot perform", rpcId);

  if (Date.now() - createTime(order) > TX_TIMEOUT_MS) {
    await updateOrder(order.id, {
      status: "cancelled",
      errorCode: PAYME_STATE.CANCELLED_BEFORE_PERFORM,
      metadata: mergedMeta(order, { payme_cancel_time: Date.now() }),
    });
    return paymeError(PAYME_ERRORS.CANNOT_PERFORM, "Timed out", rpcId);
  }

  const result = await fulfilOrder(order);
  if (!result.success)
    return paymeError(PAYME_ERRORS.CANNOT_PERFORM, "Fulfilment failed", rpcId);

  const pTime = Date.now();
  await updateOrder(order.id, {
    status: "paid",
    metadata: mergedMeta(order, { payme_perform_time: pTime }),
  });
  return paymeResult(
    { transaction: order.id, state: PAYME_STATE.PAID, perform_time: pTime },
    rpcId,
  );
}

// ── CancelTransaction ────────────────────────────────────────────────────────
async function cancelTransaction(params: PaymeParams, rpcId: number | string) {
  const order = await findByPaymeTransId(params.id ?? "");
  if (!order)
    return paymeError(PAYME_ERRORS.TRANSACTION_NOT_FOUND, "Transaction not found", rpcId);

  const state = paymeState(order);
  if (state > 0) {
    // active → cancel. 1 → -1, 2 → -2 (refund). perform_time MUST persist.
    const newState = -state;
    const cTime = Date.now();
    await updateOrder(order.id, {
      status: "cancelled",
      errorCode: newState,
      errorNote: `Cancelled, reason: ${params.reason ?? ""}`,
      metadata: mergedMeta(order, {
        payme_cancel_time: cTime,
        payme_cancel_reason: params.reason ?? 0,
      }),
    });
    return paymeResult(
      { transaction: order.id, state: newState, cancel_time: cTime },
      rpcId,
    );
  }
  // already cancelled → idempotent
  return paymeResult(
    { transaction: order.id, state, cancel_time: cancelTime(order) },
    rpcId,
  );
}

// ── CheckTransaction ─────────────────────────────────────────────────────────
async function checkTransaction(params: PaymeParams, rpcId: number | string) {
  const order = await findByPaymeTransId(params.id ?? "");
  if (!order)
    return paymeError(PAYME_ERRORS.TRANSACTION_NOT_FOUND, "Transaction not found", rpcId);
  const state = paymeState(order);
  return paymeResult(
    {
      create_time: createTime(order),
      // perform_time persists even after refund (-2) — gotcha #4
      perform_time:
        state === PAYME_STATE.PAID || state === PAYME_STATE.CANCELLED_AFTER_PERFORM
          ? performTime(order)
          : 0,
      cancel_time: state < 0 ? cancelTime(order) : 0,
      transaction: order.id,
      state,
      reason: state < 0 ? cancelReason(order) : null,
    },
    rpcId,
  );
}

// ── GetStatement ─────────────────────────────────────────────────────────────
async function getStatement(params: PaymeParams, rpcId: number | string) {
  const orders = await getOrdersInRange(params.from ?? 0, params.to ?? Date.now());
  const transactions = orders
    .filter((o) => o.providerTransId)
    .map((o) => ({
      id: o.providerTransId,
      time: createTime(o),
      amount: o.amount * 100,
      account: { [ACCOUNT_FIELD_NAME]: o.id },
      create_time: createTime(o),
      perform_time: performTime(o),
      cancel_time: cancelTime(o),
      transaction: o.id,
      state: paymeState(o),
      reason: cancelReason(o),
    }));
  return paymeResult({ transactions }, rpcId);
}
