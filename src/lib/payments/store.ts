/**
 * The integration seam. This is the ONLY file you have to edit.
 *
 * Everything Click/Payme-protocol-specific is done in click.ts / payme.ts.
 * Here we read credentials, look up + update orders, and (the one stub you
 * must fill in) fulfil a paid order.
 *
 * Assumes a Drizzle `db` instance at `@/db` and the `paymentOrders` table from
 * ./schema. Port the bodies to Prisma/Kysely/raw SQL if that's your stack —
 * the route handlers only depend on the function signatures below.
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db"; // ← your Drizzle client
import { paymentOrders, type PaymentOrder } from "./schema";
import type { PaymeSettings } from "./payme";

// ── Credentials ──────────────────────────────────────────────────────────────
// Env-var based for easy setup. To let admins rotate keys without a redeploy,
// swap these bodies to read from a `settings` table instead.
export interface ClickSettings {
  serviceId: string;
  merchantId: string;
  secretKey: string;
}

export function getClickSettings(): ClickSettings {
  return {
    serviceId: process.env.CLICK_SERVICE_ID ?? "",
    merchantId: process.env.CLICK_MERCHANT_ID ?? "",
    secretKey: process.env.CLICK_SECRET_KEY ?? "",
  };
}

export function getPaymeSettings(): PaymeSettings {
  return {
    merchantId: process.env.PAYME_MERCHANT_ID ?? "",
    secretKey: process.env.PAYME_SECRET_KEY ?? "",
    testKey: process.env.PAYME_TEST_KEY ?? "",
  };
}

// ── Order lookup ─────────────────────────────────────────────────────────────
export async function getOrderById(id: string): Promise<PaymentOrder | null> {
  const rows = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Payme sends its own transaction id in params.id; the sandbox sometimes sends
 * your order id instead. Check both (gotcha #5 in docs/payme.md).
 */
export async function findByPaymeTransId(
  transId: string,
): Promise<PaymentOrder | null> {
  let rows = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.providerTransId, transId))
    .limit(1);
  if (rows.length === 0) {
    rows = await db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, transId))
      .limit(1);
  }
  return rows[0] ?? null;
}

// ── Updates ──────────────────────────────────────────────────────────────────
export async function updateOrder(
  id: string,
  patch: Partial<PaymentOrder>,
): Promise<void> {
  await db
    .update(paymentOrders)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(paymentOrders.id, id));
}

// Payme timestamps (ms epoch) overflow pg integer — keep them in metadata JSON.
export function readMeta(order: PaymentOrder): Record<string, number> {
  return order.metadata ? JSON.parse(order.metadata) : {};
}

export function mergedMeta(
  order: PaymentOrder,
  updates: Record<string, number>,
): string {
  return JSON.stringify({ ...readMeta(order), ...updates });
}

// ── Create an order (used by your "Pay" / create-order route) ────────────────
export async function createPaymentOrder(args: {
  id: string; // pass a UUID
  userId: string;
  purchaseType: string;
  targetId: string;
  amount: number; // plain UZS
  provider: "click" | "payme";
}): Promise<PaymentOrder> {
  const now = new Date();
  const [row] = await db
    .insert(paymentOrders)
    .values({
      ...args,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

// ── THE STUB YOU MUST IMPLEMENT ──────────────────────────────────────────────
/**
 * Called exactly once, when a payment is confirmed (Click complete success /
 * Payme PerformTransaction). Do your real business logic here: create the
 * purchase record, grant course/subscription access, send a receipt, etc.
 *
 * Must be idempotent-safe: the route layer already guards against double calls
 * by checking order.status === "paid" first, but if you emit side effects
 * (emails, webhooks) add your own dedupe.
 *
 * Return { success: false } to make the gateway retry (it will call again).
 */
export async function fulfilOrder(
  order: PaymentOrder,
): Promise<{ success: boolean }> {
  // TODO: implement for your app, e.g.
  //   await db.insert(purchases).values({ userId: order.userId,
  //     targetId: order.targetId, type: order.purchaseType, ... });
  //   await grantAccess(order.userId, order.targetId);
  throw new Error(
    `fulfilOrder() not implemented — wire up access-granting for order ${order.id}`,
  );
}

// ── GetStatement helper (Payme reconciliation) ───────────────────────────────
export async function getOrdersInRange(
  from: number,
  to: number,
): Promise<PaymentOrder[]> {
  return db
    .select()
    .from(paymentOrders)
    .where(
      and(
        eq(paymentOrders.provider, "payme"),
        gte(paymentOrders.createdAt, new Date(from)),
        lte(paymentOrders.createdAt, new Date(to)),
      ),
    )
    .orderBy(sql`${paymentOrders.createdAt} ASC`);
}
