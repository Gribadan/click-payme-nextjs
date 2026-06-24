/**
 * Click prepare callback (action=0). Click calls this BEFORE charging the card.
 * Verify the signature + amount, issue a merchant_prepare_id, persist it.
 *
 * Registered with Click as: POST https://yourapp.com/api/payments/click/prepare
 */
import { NextResponse } from "next/server";
import {
  CLICK_ERRORS,
  parseClickBody,
  verifyPrepareSign,
  clickResponse,
  generatePrepareId,
} from "@/lib/payments/click";
import { getClickSettings, getOrderById, updateOrder } from "@/lib/payments/store";

export async function POST(request: Request) {
  const p = await parseClickBody(request); // gotcha #1: form-encoded, not JSON
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

  // 1. Signature (gotcha #2: prepare-specific formula)
  if (!verifyPrepareSign(p, secretKey)) return fail(CLICK_ERRORS.SIGN_CHECK_FAILED);

  // 2. Action — coerce, never compare a string to a number (gotcha #4b)
  if (Number(p.action) !== 0) return fail(CLICK_ERRORS.ACTION_NOT_FOUND);

  // 3. Order exists
  const order = await getOrderById(p.merchant_trans_id);
  if (!order) return fail(CLICK_ERRORS.ORDER_NOT_FOUND);

  // 4. State
  if (order.status === "paid")
    return fail(CLICK_ERRORS.ALREADY_PAID, order.prepareId ?? 0);
  if (order.status === "cancelled" || order.status === "failed")
    return fail(CLICK_ERRORS.TRANSACTION_CANCELLED, order.prepareId ?? 0);

  // 5. Amount — integer compare, never float === (gotcha #4)
  if (Math.round(Number(p.amount)) !== order.amount)
    return fail(CLICK_ERRORS.INCORRECT_AMOUNT);

  // 6. Issue a 32-bit-safe prepare_id and persist it (gotcha #3)
  const prepareId = generatePrepareId();
  await updateOrder(order.id, {
    status: "preparing",
    providerTransId: String(p.click_trans_id),
    prepareId,
  });

  // 7. Success
  return NextResponse.json(
    clickResponse({
      clickTransId: p.click_trans_id,
      merchantTransId: p.merchant_trans_id,
      error: CLICK_ERRORS.SUCCESS,
      prepareId,
      idField: "merchant_prepare_id",
    }),
  );
}
