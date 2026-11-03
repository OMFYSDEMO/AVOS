import { newRouter, requireCap, requireAny, body, str, optStr, int, oneOf, paise, optDate } from "../app";
import { Batch, HttpError, all, one, id, assertPeriodOpen } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { splitInclusive } from "../domain/money";
import { allowed } from "../auth";

const r = newRouter();
// The CA and revenue desk read the register; recording stays with whoever collects the money.
r.use("*", async (c, next) => (c.req.method === "GET" ? requireAny("other_income", "finance") : requireCap("other_income"))(c, next));

export const INCOME_CATEGORIES = ["dining", "photo", "events", "transport", "other"] as const;
const METHODS = ["upi", "cash", "card", "airpay", "bank"] as const;

/** Other income for a month: meals for day guests, photoshoots, events — anything that is not a room stay. */
r.get("/", async (c) => {
  const p = c.get("property");
  const period = c.req.query("period") ?? todayIn(p.timezone).slice(0, 7);
  // The front desk sees what it recorded and what landed in the cash it holds; the rest is the revenue desk's, owner's and CA's.
  const own = allowed(c.get("actor"), "finance") ? "" : "AND (a.holder_role = 'property' OR u.role = 'property')";
  const rows = await all(c.env.DB, `SELECT i.*, a.name AS account_name, u.name AS recorded_name FROM other_income i LEFT JOIN money_accounts a ON a.id = i.account_id LEFT JOIN users u ON u.id = i.recorded_by
     WHERE i.property_id = ? AND substr(i.on_date,1,7) = ? ${own} ORDER BY i.on_date DESC, i.created_at DESC`, p.id, period);
  return c.json({ period, income: rows, categories: INCOME_CATEGORIES });
});

/**
 * Record other income. The amount is what was collected (inclusive of GST); the slab is chosen by whoever
 * records it (meals at 5%, most services at 18%, 0 when GST is not charged). The money lands in the
 * account that matches the method, so the cash ledger stays right without a separate payment row.
 */
r.post("/", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const idem = optStr(x.idempotency_key, "idempotency_key");
  if (idem) { const ex = await one<{ id: string }>(c.env.DB, "SELECT id FROM other_income WHERE property_id = ? AND idempotency_key = ?", p.id, idem); if (ex) return c.json({ id: ex.id, duplicate: true }); }
  const amount = paise(x.amount_paise, "amount_paise");
  const onDate = optDate(x.on_date, "on_date") ?? todayIn(p.timezone);
  await assertPeriodOpen(c.env.DB, p.id, onDate);
  const method = oneOf(x.method, "method", METHODS);
  const gstBp = p.gstin ? int(x.gst_rate_bp ?? 0, "gst_rate_bp", { min: 0, max: 2800, optional: true }) : 0;
  const { ex, gst } = splitInclusive(amount, gstBp);
  let accountId = optStr(x.account_id, "account_id");
  if (accountId) {
    const a = await one(c.env.DB, "SELECT id FROM money_accounts WHERE id = ? AND property_id = ? AND active = 1", accountId, p.id);
    if (!a) throw new HttpError(400, "unknown money account");
  } else {
    const kindWanted = method === "cash" ? "cash" : method === "airpay" || method === "card" ? "gateway" : "bank";
    const a = await one<{ id: string }>(c.env.DB, "SELECT id FROM money_accounts WHERE property_id = ? AND kind = ? AND active = 1 ORDER BY is_default DESC, id LIMIT 1", p.id, kindWanted)
      ?? await one<{ id: string }>(c.env.DB, "SELECT id FROM money_accounts WHERE property_id = ? AND kind = 'bank' AND active = 1 ORDER BY is_default DESC, id LIMIT 1", p.id);
    if (!a) throw new HttpError(400, "no money account configured");
    accountId = a.id;
  }
  const iid = id("inc");
  const b = new Batch(c.env.DB, actor);
  b.add(`INSERT INTO other_income (id, property_id, on_date, category, description, payer_name, amount_paise, gst_rate_bp, gst_paise, taxable_paise, method, account_id, reference, recorded_by, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    iid, p.id, onDate, oneOf(x.category, "category", INCOME_CATEGORIES), str(x.description, "description"), optStr(x.payer_name, "payer_name"), amount, gstBp, gst, ex, method, accountId, optStr(x.reference, "reference"), actor.id, idem);
  b.audit("income.create", "other_income", iid, null, { on_date: onDate, category: x.category, amount_paise: amount, gst_rate_bp: gstBp, gst_paise: gst, method, account_id: accountId });
  await b.run();
  return c.json({ id: iid, taxable_paise: ex, gst_paise: gst, account_id: accountId }, 201);
});

r.post("/:id/void", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const row: any = await one(c.env.DB, "SELECT * FROM other_income WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!row) throw new HttpError(404, "income entry not found");
  if (row.voided_at) throw new HttpError(409, "already voided");
  await assertPeriodOpen(c.env.DB, p.id, row.on_date);
  const x = await body(c);
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE other_income SET voided_at = ?, void_reason = ? WHERE id = ?", nowIso(), str(x.reason, "reason"), row.id);
  b.audit("income.void", "other_income", row.id, { amount_paise: row.amount_paise }, { void: true, reason: x.reason });
  await b.run();
  return c.json({ ok: true });
});

export default r;
