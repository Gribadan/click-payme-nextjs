/**
 * Click complete callback (action=1). Click calls this AFTER attempting the
 * charge. On success you fulfil the order; on a declined card Click still calls
 * here with error < 0 and you mark it failed.
 *
 * Registered with Click as: POST https://yourapp.com/api/payments/click/complete
 */
import { NextResponse } from "next/server";
import {
  CLICK_ERRORS,
  parseClickBody,
  verifyCompleteSign,
  clickResponse,
} from "@/lib/payments/click";
import {
  getClickSettings,
  getOrderById,
  updateOrder,
  fulfilOrder,
} from "@/lib/payments/store";

export async function POST(request: Request) {
  const p = await parseClickBody(request);
  const { secretKey } = getClickSettings();

  const fail = (error: number, prepareId?: number) =>
    NextResponse.json(
      clickResponse({
        clickTransId: p.click_trans_id,
        merchantTransId: p.merchant_trans_id,
        error,
        prepareId,
      }),
    );

  // Signature (gotcha #2: complete-specific formula, includes merchant_prepare_id)
  if (!verifyCompleteSign(p, secretKey)) return fail(CLICK_ERRORS.SIGN_CHECK_FAILED);
  if (Number(p.action) !== 1) return fail(CLICK_ERRORS.ACTION_NOT_FOUND);

  const order = await getOrderById(p.merchant_trans_id);
  if (!order) return fail(CLICK_ERRORS.ORDER_NOT_FOUND);

  // The prepare_id Click references must match what we issued in prepare
  if (order.prepareId !== Number(p.merchant_prepare_id))
    return fail(CLICK_ERRORS.TRANSACTION_NOT_FOUND);

  // Idempotency — Click retries complete after success (gotcha #5)
  if (order.status === "paid")
    return NextResponse.json(
      clickResponse({
        clickTransId: p.click_trans_id,
        merchantTransId: p.merchant_trans_id,
        error: CLICK_ERRORS.SUCCESS,
        errorNote: "Already confirmed",
        prepareId: order.prepareId ?? 0,
        idField: "merchant_confirm_id",
      }),
    );
  if (order.status === "cancelled")
    return fail(CLICK_ERRORS.TRANSACTION_CANCELLED, order.prepareId ?? 0);

  // Card declined: Click still calls complete with error < 0 (gotcha #6)
  if (Number(p.error) < 0) {
    await updateOrder(order.id, {
      status: "failed",
      errorCode: Number(p.error),
      errorNote: p.error_note ?? "Payment failed",
    });
    return fail(CLICK_ERRORS.TRANSACTION_CANCELLED, order.prepareId ?? 0);
  }

  // Re-check amount (gotcha #4)
  if (Math.round(Number(p.amount)) !== order.amount)
    return fail(CLICK_ERRORS.INCORRECT_AMOUNT);

  // SUCCESS — fulfil
  const result = await fulfilOrder(order);
  if (!result.success) return fail(CLICK_ERRORS.FAILED_TO_UPDATE, order.prepareId ?? 0);
  await updateOrder(order.id, { status: "paid" });

  return NextResponse.json(
    clickResponse({
      clickTransId: p.click_trans_id,
      merchantTransId: p.merchant_trans_id,
      error: CLICK_ERRORS.SUCCESS,
      prepareId: order.prepareId ?? 0,
      idField: "merchant_confirm_id",
    }),
  );
}
