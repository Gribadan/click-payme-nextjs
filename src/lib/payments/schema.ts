/**
 * Shared `payment_orders` table — serves BOTH Click and Payme.
 * The `provider` column distinguishes them.
 *
 * Merge this into your existing Drizzle schema (or import it), then:
 *   npx drizzle-kit generate && npx drizzle-kit migrate
 *
 * Key design choices (don't fight them):
 *  - `amount` is stored in **plain UZS** (an integer), NOT tiyin. Click sends
 *    UZS already; Payme sends tiyin and we convert at the boundary.
 *  - Payme's millisecond timestamps (create_time/perform_time/cancel_time)
 *    OVERFLOW pg `integer` (~2.1e9). They live in the `metadata` JSON string,
 *    never in integer columns. See docs/payme.md gotcha #2.
 *  - `id` is a UUID (text), not autoincrement — it becomes the gateway's
 *    `merchant_trans_id` / `account` value, so it must not be enumerable.
 */
import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: text("id").primaryKey(), // UUID → Click merchant_trans_id / Payme account
    userId: text("user_id").notNull(),
    purchaseType: text("purchase_type").notNull(), // "course" | "subscription" | ...
    targetId: text("target_id").notNull(), // what they're buying
    amount: integer("amount").notNull(), // plain UZS (NOT tiyin)
    provider: text("provider").notNull(), // "click" | "payme"
    providerTransId: text("provider_trans_id"), // click_trans_id / Payme transaction id
    prepareId: integer("prepare_id"), // Click merchant_prepare_id (32-bit safe)
    status: text("status").notNull().default("pending"),
    // pending | preparing | paid | cancelled | failed
    errorCode: integer("error_code"),
    errorNote: text("error_note"),
    metadata: text("metadata"), // JSON string: Payme timestamps, etc.
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    index("payment_orders_provider_trans_idx").on(t.provider, t.providerTransId),
    index("payment_orders_status_idx").on(t.status),
  ],
);

export type PaymentOrder = typeof paymentOrders.$inferSelect;
export type NewPaymentOrder = typeof paymentOrders.$inferInsert;
