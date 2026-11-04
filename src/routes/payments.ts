import { newRouter, requireCap, requireAny, body, str, optStr, int, date, oneOf, paise } from "../app";
import { Batch, HttpError, all, one, id, assertPeriodOpen } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { allowed } from "../auth";
import { applyBp } from "../domain/money";
import { loadBooking, paidOnBooking } from "../services/bookings";
import { recordPayment, METHODS } from "../services/payments";
import { rankStaysForPayment } from "../services/airpayMatch";

const r = newRouter();
const SALES_METHODS = ["upi", "bank", "card", "airpay"];

/** Contracted gateway fees (bp of amount) by method; the fee expense is booked once, here (F4). */

async function account(db: D1Database, propertyId: string, accountId: string) {
  const a: any = await one(db, "SELECT * FROM money_accounts WHERE id = ? AND property_id = ? AND active = 1", accountId, propertyId);
  if (!a) throw new HttpError(400, "unknown money account");
  return a;
}

/** Who owes money today: in-house or arriving direct guests with a balance, plus upcoming stays wanting an advance. */
r.get("/due", requireCap("payments"), async (c) => {
  const p = c.get("property");
  const today = todayIn(p.timezone);
  const rows = await all(c.env.DB,
    `SELECT b.id AS booking_id, g.name AS guest_name, g.phone AS guest_phone, b.check_in, b.check_out, b.status, b.gross_paise, ch.collection_type,
            (SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END),0) FROM payments WHERE booking_id = b.id AND status != 'void') AS paid_paise
     FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id
     WHERE b.property_id = ? AND ch.collection_type != 'channel_collect' AND b.status IN ('approved','checked_in','checked_out','provisional')
       AND (b.check_out >= ? OR b.status = 'checked_out')
     ORDER BY b.check_in LIMIT 200`, p.id, today);
  // A guest who has left still owing stays on this list (marked overdue) until it is collected or recorded.
  const due = rows.map((x: any) => ({ ...x, balance_paise: x.gross_paise - x.paid_paise, overdue: x.status === "checked_out", due_today: x.status === "checked_in" || x.status === "checked_out" || x.check_in === today || x.check_out === today })).filter((x: any) => x.balance_paise > 0);
  return c.json({ due: due.sort((a: any, b: any) => Number(b.due_today) - Number(a.due_today)) });
});

r.get("/", requireAny("payments", "finance"), async (c) => {
  const p = c.get("property");
  const fin = allowed(c.get("actor"), "finance");
  const from = c.req.query("from"), to = c.req.query("to"), bookingId = c.req.query("booking_id");
  const where = ["p.property_id = ?"]; const params: unknown[] = [p.id];
  // The front desk and sales each see the collections their own desk recorded: no OTA payouts, nothing the revenue desk or owner posted.
  if (!fin) { where.push("p.method != 'ota' AND p.recorded_by IN (SELECT id FROM users WHERE role = ?)"); params.push(c.get("actor").role); }
  if (from) { where.push("p.received_on >= ?"); params.push(date(from, "from")); }
  if (to) { where.push("p.received_on <= ?"); params.push(date(to, "to")); }
  if (bookingId) { where.push("p.booking_id = ?"); params.push(bookingId); }
  const rows = await all(c.env.DB, `SELECT p.*, g.name AS guest_name, a.name AS account_name, e.amount_paise AS fee_paise FROM payments p LEFT JOIN guests g ON g.id = p.guest_id JOIN money_accounts a ON a.id = p.account_id LEFT JOIN expenses e ON e.id = p.fee_expense_id WHERE ${where.join(" AND ")} ORDER BY p.received_on DESC, p.created_at DESC LIMIT 300`, ...params);
  if (!fin) for (const r of rows as any[]) { delete r.fee_paise; delete r.fee_expense_id; }
  return c.json({ payments: rows });
});

/** Airpay emails routed from the inbox, waiting for Sindhu to confirm against a stay. */
r.get("/gateway-inbox", requireCap("payments"), async (c) => {
  const p = c.get("property");
  if (c.get("actor").role === "sales") return c.json({ items: [] }); // gateway receipts are the front desk's and the revenue desk's
  const items = await all(c.env.DB, "SELECT * FROM inbox_items WHERE property_id = ? AND kind = 'payment' AND status = 'routed' ORDER BY received_at DESC", p.id);
  const out = [];
  for (const it of items as any[]) {
    const d = JSON.parse(it.parsed_json ?? "{}");
    // Order-id prefix match: Airpay order ids start with the SwiftBook itinerary number.
    let match: any = null;
    if (d.order_id) match = await one(c.env.DB, `SELECT b.id, b.gross_paise, b.external_ref, g.name AS guest_name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.external_ref IS NOT NULL AND ? LIKE b.external_ref || '%' AND b.status NOT IN ('cancelled','no_show') ORDER BY b.created_at DESC LIMIT 1`, p.id, String(d.order_id));
    // No booking carries the order id: rank the open stays by who paid and the amount, for one-tap confirmation.
    const candidates = match ? [] : (await rankStaysForPayment(c.env.DB, p.id, p.timezone, { amount_paise: d.amount_paise, payer_name: d.payer_name, payer_mobile: d.payer_mobile, payer_email: d.payer_email, paid_at: d.sent_at ?? it.received_at }))
      .filter((x) => x.score >= 30).slice(0, 3).map((x) => ({ id: x.id, guest_name: x.guest_name, check_in: x.check_in, check_out: x.check_out, owing_paise: x.owing_paise, why: x.why }));
    out.push({ ...it, parsed: d, suggested_booking: match, candidates });
  }
  return c.json({ items: out });
});

/**
 * Record a payment. Rules: amount is the only typed field; advances and part-payments allowed; the
 * gateway fee expense is created here, once, at the contracted rate, linked to the payment.
 */
r.post("/", requireCap("payments"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  if (actor.role === "sales" && !SALES_METHODS.includes(x.method as string)) throw new HttpError(403, "sales record UPI, bank transfer, card or Airpay payments; cash is collected at the property");
  const res = await recordPayment(c.env.DB, actor, p, {
    idempotency_key: optStr(x.idempotency_key, "idempotency_key"), booking_id: optStr(x.booking_id, "booking_id"), guest_id: optStr(x.guest_id, "guest_id"),
    method: oneOf(x.method, "method", METHODS), amount_paise: paise(x.amount_paise, "amount_paise"), received_on: optStr(x.received_on, "received_on"),
    account_id: optStr(x.account_id, "account_id"), fee_bp: x.fee_bp === undefined ? undefined : int(x.fee_bp, "fee_bp", { min: 0, max: 1000 }),
    reference: optStr(x.reference, "reference"), inbox_item_id: optStr(x.inbox_item_id, "inbox_item_id"),
  });
  if (res.duplicate) return c.json({ id: res.id, duplicate: true });
  return c.json({ id: res.id, kind: res.kind, fee_expense_id: res.fee_expense_id, balance_paise: res.balance_paise }, 201);
});

/** Void follows the payment through: its fee expense is voided in the same batch (F4). */
r.post("/:id/void", requireCap("payments"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const pay: any = await one(c.env.DB, "SELECT * FROM payments WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!pay) throw new HttpError(404, "payment not found");
  if (pay.status === "void") throw new HttpError(409, "already void");
  if (pay.status === "matched") throw new HttpError(409, "payment is reconciled to the bank; unmatch it first");
  // A desk voids only what its own desk recorded; the revenue desk and the owner can void any.
  if (!allowed(actor, "finance")) {
    const by = await one<{ role: string }>(c.env.DB, "SELECT role FROM users WHERE id = ?", pay.recorded_by);
    if (by?.role !== actor.role) throw new HttpError(403, "only the revenue desk or the owner can void a payment another desk recorded");
  }
  await assertPeriodOpen(c.env.DB, p.id, pay.received_on);
  const x = await body(c);
  const reason = str(x.reason, "reason");
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE payments SET status = 'void', voided_at = ?, void_reason = ? WHERE id = ?", nowIso(), reason, pay.id);
  if (pay.fee_expense_id) b.add("UPDATE expenses SET voided_at = ?, void_reason = ? WHERE id = ?", nowIso(), `payment voided: ${reason}`, pay.fee_expense_id);
  b.audit("payment.void", "payment", pay.id, { status: pay.status, amount_paise: pay.amount_paise }, { status: "void", reason, fee_expense_voided: pay.fee_expense_id });
  await b.run();
  return c.json({ ok: true });
});

// ---- Money accounts and transfers (F6) ----
r.get("/accounts", requireCap("balances"), async (c) => {
  const p = c.get("property");
  const asOf = c.req.query("as_of") ?? todayIn(p.timezone);
  // The front desk sees only the cash it holds (cash in hand, petty cash); banks are for the revenue desk, owner and CA.
  const fin = allowed(c.get("actor"), "finance");
  const rows = await all(c.env.DB,
    `SELECT a.*,
       a.opening_paise
       + COALESCE((SELECT SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END) FROM payments WHERE account_id = a.id AND status != 'void' AND received_on <= ?),0)
       + COALESCE((SELECT SUM(amount_paise) FROM other_income WHERE account_id = a.id AND voided_at IS NULL AND on_date <= ?),0)
       - COALESCE((SELECT SUM(amount_paise) FROM expenses WHERE paid_from_account_id = a.id AND voided_at IS NULL AND on_date <= ?),0)
       + COALESCE((SELECT SUM(amount_paise) FROM transfers WHERE to_account_id = a.id AND voided_at IS NULL AND on_date <= ?),0)
       - COALESCE((SELECT SUM(amount_paise) FROM transfers WHERE from_account_id = a.id AND voided_at IS NULL AND on_date <= ?),0) AS balance_paise
     FROM money_accounts a WHERE a.property_id = ? AND a.active = 1 ${fin ? "" : "AND a.holder_role = 'property'"} ORDER BY a.kind`, asOf, asOf, asOf, asOf, asOf, p.id);
  const period = asOf.slice(0, 7);
  const spent = await all(c.env.DB, `SELECT e.paid_from_account_id AS account_id, SUM(e.amount_paise) AS spent_paise FROM expenses e JOIN money_accounts a ON a.id = e.paid_from_account_id WHERE e.property_id = ? AND e.voided_at IS NULL AND substr(e.on_date,1,7) = ? ${fin ? "" : "AND a.holder_role = 'property'"} GROUP BY e.paid_from_account_id`, p.id, period);
  if (!fin) for (const r of rows as any[]) { delete r.account_no; delete r.reported_balance_paise; delete r.reported_at; delete r.opening_paise; }
  return c.json({ as_of: asOf, accounts: rows, spent_this_month: spent });
});

r.post("/transfers", requireCap("transfers"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const idem = optStr(x.idempotency_key, "idempotency_key");
  if (idem) { const ex = await one<{ id: string }>(c.env.DB, "SELECT id FROM transfers WHERE property_id = ? AND idempotency_key = ?", p.id, idem); if (ex) return c.json({ id: ex.id, duplicate: true }); }
  const from = await account(c.env.DB, p.id, str(x.from_account_id, "from_account_id"));
  const to = await account(c.env.DB, p.id, str(x.to_account_id, "to_account_id"));
  if (from.id === to.id) throw new HttpError(400, "from and to must differ");
  // Who holds the money records the movement: bank movements are the owner's; cash/petty movements the property's.
  const touchesBank = from.kind === "bank" || to.kind === "bank";
  if (touchesBank && !["owner", "property"].includes(actor.role)) throw new HttpError(403, "bank transfers are recorded by the owner");
  const amount = paise(x.amount_paise, "amount_paise");
  const onDate = optStr(x.on_date, "on_date") ?? todayIn(p.timezone);
  await assertPeriodOpen(c.env.DB, p.id, onDate);
  const tid = id("trf");
  const b = new Batch(c.env.DB, actor);
  b.add("INSERT INTO transfers (id, property_id, from_account_id, to_account_id, amount_paise, on_date, reference, note, recorded_by, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
    tid, p.id, from.id, to.id, amount, onDate, optStr(x.reference, "reference"), optStr(x.note, "note"), actor.id, idem);
  b.audit("transfer.create", "transfer", tid, null, { from: from.name, to: to.name, amount_paise: amount, on_date: onDate });
  await b.run();
  return c.json({ id: tid }, 201);
});

r.get("/transfers", requireAny("transfers", "finance"), async (c) => {
  const p = c.get("property");
  // The front desk sees only movements of the cash it holds (deposits, petty top-ups), never bank-to-bank or gateway settlements.
  const own = allowed(c.get("actor"), "finance") ? "" : "AND (fa.holder_role = 'property' OR ta.holder_role = 'property')";
  const rows = await all(c.env.DB, `SELECT t.*, fa.name AS from_name, ta.name AS to_name FROM transfers t JOIN money_accounts fa ON fa.id = t.from_account_id JOIN money_accounts ta ON ta.id = t.to_account_id WHERE t.property_id = ? AND t.voided_at IS NULL ${own} ORDER BY t.on_date DESC LIMIT 200`, p.id);
  return c.json({ transfers: rows });
});

export default r;
