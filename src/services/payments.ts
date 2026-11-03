import type { Actor } from "../auth";
import { Batch, HttpError, one, id, type PropertyRow, assertPeriodOpen } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { applyBp } from "../domain/money";
import { loadBooking, paidOnBooking } from "./bookings";

export const METHODS = ["upi", "cash", "card", "airpay", "bank", "ota"] as const;
export type PaymentMethod = (typeof METHODS)[number];
/** Estimated gateway charge per method, in basis points of the amount received, before any GST the gateway adds. */
// Card: the bank's POS charge as it has actually been deducted here, 1.5% + 18% GST = 1.77% (GST included in the rate).
// Airpay: 2.75% + 18% GST on the charge, as on its settlements (₹23,100 paid, ₹749.60 kept). Reconciliation adjusts either to the exact figure.
export const GATEWAY_FEE_BP: Record<string, number> = { airpay: 275, card: 177, upi: 0, cash: 0, bank: 0, ota: 0 };
/** GST the gateway charges on top of its fee: booked as input GST on the fee expense, as Airpay's invoices show it. */
export const GATEWAY_FEE_GST_BP: Record<string, number> = { airpay: 1800 };

/** The fee expense for a payment: charge at the rate, plus the gateway's GST on the charge (each rounded, as the gateway does). */
export function gatewayFee(method: string, amountPaise: number, overrideBp?: number): { bp: number; charge: number; gstBp: number; gst: number; total: number } {
  const bp = overrideBp ?? GATEWAY_FEE_BP[method] ?? 0;
  const gstBp = overrideBp === undefined ? GATEWAY_FEE_GST_BP[method] ?? 0 : 0; // an explicit rate is all-in
  const charge = applyBp(amountPaise, bp);
  const gst = applyBp(charge, gstBp);
  return { bp, charge, gstBp, gst, total: charge + gst };
}

export interface RecordPaymentInput {
  idempotency_key?: string | null;
  booking_id?: string | null;
  guest_id?: string | null;
  method: PaymentMethod;
  amount_paise: number;
  received_on?: string | null;
  account_id?: string | null;
  fee_bp?: number;
  reference?: string | null;
  inbox_item_id?: string | null;
}

/**
 * The one place a payment is recorded: the front desk, the Airpay inbox card and inbox automation all come
 * here. Amount is the only typed field; advances and part-payments are allowed; the gateway fee expense is
 * created once, at the contracted rate, linked to the payment so a void follows it.
 */
export async function recordPayment(db: D1Database, actor: Actor, p: PropertyRow, x: RecordPaymentInput) {
  if (x.idempotency_key) {
    const ex = await one<{ id: string }>(db, "SELECT id FROM payments WHERE property_id = ? AND idempotency_key = ?", p.id, x.idempotency_key);
    if (ex) return { id: ex.id, duplicate: true as const, kind: null, fee_expense_id: null, balance_paise: null };
  }
  if (!Number.isInteger(x.amount_paise) || x.amount_paise <= 0) throw new HttpError(400, "amount_paise must be a positive integer");
  const receivedOn = x.received_on ?? todayIn(p.timezone);
  await assertPeriodOpen(db, p.id, receivedOn);
  let guestId: string | null = x.guest_id ?? null;
  let kind: "advance" | "balance" = "balance";
  if (x.booking_id) {
    const bk = await loadBooking(db, p.id, x.booking_id);
    if (["cancelled", "no_show"].includes(bk.status)) throw new HttpError(409, `booking is ${bk.status}`);
    guestId = bk.guest_id;
    kind = bk.status === "checked_in" || bk.status === "checked_out" ? "balance" : "advance";
  }
  // Default account by method: cash → cash in hand; airpay → the gateway clearing account; card → the bank the
  // property's card machine settles into (Settings), else the default bank; upi/bank → the default bank.
  let accountId = x.account_id ?? null;
  if (!accountId && x.method === "card" && p.pos_account_id) {
    const pos = await one<{ id: string }>(db, "SELECT id FROM money_accounts WHERE id = ? AND property_id = ? AND kind = 'bank' AND active = 1", p.pos_account_id, p.id);
    if (pos) accountId = pos.id;
  }
  if (accountId) {
    const a = await one(db, "SELECT id FROM money_accounts WHERE id = ? AND property_id = ? AND active = 1", accountId, p.id);
    if (!a) throw new HttpError(400, "unknown money account");
  } else {
    const kindWanted = x.method === "cash" ? "cash" : x.method === "airpay" ? "gateway" : "bank";
    const a = await one<{ id: string }>(db, "SELECT id FROM money_accounts WHERE property_id = ? AND kind = ? AND active = 1 ORDER BY is_default DESC, id LIMIT 1", p.id, kindWanted)
      ?? await one<{ id: string }>(db, "SELECT id FROM money_accounts WHERE property_id = ? AND kind = 'bank' AND active = 1 ORDER BY is_default DESC, id LIMIT 1", p.id);
    if (!a) throw new HttpError(400, "no money account configured");
    accountId = a.id;
  }
  const pid = id("pay");
  const b = new Batch(db, actor);
  const fee = gatewayFee(x.method, x.amount_paise, x.fee_bp);
  let feeId: string | null = null;
  if (fee.total > 0) {
    feeId = id("exp");
    const rate = `${fee.bp / 100}%${fee.gstBp ? " + GST" : ""}`;
    b.add(`INSERT INTO expenses (id, property_id, kind, category, description, amount_paise, gst_rate_bp, gst_paise, paid_from_account_id, on_date, payment_id, recorded_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, feeId, p.id, "gateway_fee", "bank_charges", `${x.method} fee ${rate} on payment ${pid}${x.method === "airpay" ? " (estimate; adjusted to the settlement)" : ""}`, fee.total, fee.gstBp, fee.gst, accountId, receivedOn, pid, actor.id);
  }
  // An Airpay receipt that came through the inbox is confirmed by the gateway's own email; a hand-typed one waits for the statement.
  const status = x.method === "airpay" && !x.inbox_item_id ? "recorded" : "confirmed";
  b.add(`INSERT INTO payments (id, property_id, booking_id, guest_id, kind, method, amount_paise, account_id, reference, received_on, status, fee_expense_id, inbox_item_id, recorded_by, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pid, p.id, x.booking_id ?? null, guestId, kind, x.method, x.amount_paise, accountId, x.reference ?? null, receivedOn, status, feeId, x.inbox_item_id ?? null, actor.id, x.idempotency_key ?? null);
  if (x.inbox_item_id) b.add("UPDATE inbox_items SET status = 'approved', payment_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND property_id = ?", pid, actor.via === "automation" ? null : actor.id, nowIso(), x.inbox_item_id, p.id);
  b.audit("payment.create", "payment", pid, null, { booking_id: x.booking_id ?? null, kind, method: x.method, amount_paise: x.amount_paise, account_id: accountId, fee_expense_id: feeId, inbox_item_id: x.inbox_item_id ?? null });
  await b.run();
  const balance = x.booking_id ? (await loadBooking(db, p.id, x.booking_id)).gross_paise - (await paidOnBooking(db, x.booking_id)) : null;
  return { id: pid, duplicate: false as const, kind, fee_expense_id: feeId, balance_paise: balance };
}
