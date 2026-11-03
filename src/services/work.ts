import type { Env } from "../env";
import { Batch, all, one, type PropertyRow } from "../db";
import { nowIso, todayIn, previousPeriod, periodOf } from "../domain/dates";
import { notifyRole } from "./notify";
import { gstPolicy } from "./bookings";
import { slabBpForRoomNight } from "../domain/gst";
import { AFTER_STAY } from "./inboxAuto";

/**
 * The work queue (W14). Every role sees the jobs that are on it right now, built from data that already exists:
 * nothing is entered twice. Each item carries how long it has waited and a tolerance; past the tolerance it is
 * overdue and is raised once to the next role up. The owner sees everything overdue anywhere.
 */
export interface WorkItem {
  key: string; kind: string; title: string; sub: string | null;
  owner_role: string; since: string; tolerance_hours: number; due_at: string; overdue: boolean; waited_hours: number;
  href: string; escalated_to?: string | null; escalated_at?: string | null;
}

export const ESCALATE_TO: Record<string, string | null> = { sales: "revenue", property: "owner", revenue: "owner", accountant: "owner", owner: null };
/** Items that were already waiting when the queue went live (WORK_QUEUE_LIVE_SINCE, production only) are shown, but not raised with a notification. */

/** Hours an item may wait before it is overdue. Start loose; tighten once the slip report shows what is normal. */
export const TOLERANCE: Record<string, number> = {
  inbox: 2, lead: 1, receipt: 24, paidonline: 6,
  arrival: 4, departure: 4, overstay: 1, task: 24, unpaid: 24, refund: 48, gstslab: 24, airpay: 24,
  approval: 4, payout: 7 * 24, bank: 7 * 24,
  lock: 72, file: 72,
  idproof: 2, formc: 24, idarchive: 72,
};

const hoursBetween = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 3_600_000);
const localIso = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;

function item(kind: string, key: string, title: string, sub: string | null, ownerRole: string, since: string, href: string, now: string): WorkItem {
  const tol = TOLERANCE[kind] ?? 24;
  const sinceIso = since.includes("T") ? since : since.replace(" ", "T") + (since.endsWith("Z") ? "" : "Z");
  const waited = hoursBetween(sinceIso, now);
  return { key, kind, title, sub, owner_role: ownerRole, since: sinceIso, tolerance_hours: tol, due_at: new Date(Date.parse(sinceIso) + tol * 3_600_000).toISOString(), overdue: waited > tol, waited_hours: Math.round(waited * 10) / 10, href };
}

/** Every open item across every role, oldest first within each. */
export async function allWorkItems(db: D1Database, p: PropertyRow, now = nowIso()): Promise<WorkItem[]> {
  const today = todayIn(p.timezone, new Date(now));
  const out: WorkItem[] = [];
  // Sales: emails waiting and leads nobody has answered.
  for (const r of await all<any>(db, "SELECT id, kind, source, subject, received_at, auto_note, parsed_json FROM inbox_items WHERE property_id = ? AND status = 'pending' ORDER BY received_at", p.id)) {
    const d = r.parsed_json ? JSON.parse(r.parsed_json) : {};
    // Bank alerts and gateway receipts that could not post themselves are the revenue desk's, never sales'.
    const finance = ["bank_alert", "payment"].includes(r.kind) || ["bank", "airpay"].includes(r.source) || String(r.auto_note ?? "").startsWith(AFTER_STAY);
    out.push(item("inbox", `inbox:${r.id}`, `${d.guest_name ?? r.subject ?? "Email"} · ${r.kind.replace("_", " ")} from ${r.source}`, r.auto_note ?? null, finance ? "revenue" : "sales", r.received_at, "#inbox", now));
  }
  // Revenue: a bank alert AVOS could not post (account digits unknown, unreadable) waits in the inbox for the revenue desk.
  for (const r of await all<any>(db, "SELECT id, subject, received_at, auto_note FROM inbox_items WHERE property_id = ? AND kind = 'bank_alert' AND status = 'routed' ORDER BY received_at", p.id))
    out.push(item("inbox", `inbox:${r.id}`, `Bank alert not posted · ${r.subject ?? "bank email"}`, r.auto_note ?? null, "revenue", r.received_at, "#inbox", now));
  for (const r of await all<any>(db, "SELECT l.id, l.created_at, l.check_in, l.source, g.name FROM leads l LEFT JOIN guests g ON g.id = l.guest_id WHERE l.property_id = ? AND l.status = 'new' ORDER BY l.created_at", p.id))
    out.push(item("lead", `lead:${r.id}`, `${r.name ?? "Lead"} · ${r.source} enquiry unanswered`, r.check_in ? `wants ${r.check_in}` : null, "sales", r.created_at, "#leads", now));
  // Property: today's arrivals and departures, overstays, open tasks, gateway receipts not matched to a stay.
  for (const r of await all<any>(db, "SELECT b.id, b.check_in, g.name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.status = 'approved' AND b.check_in <= ? ORDER BY b.check_in", p.id, today))
    out.push(item("arrival", `arrival:${r.id}`, `${r.name} arriving ${r.check_in === today ? "today" : r.check_in} · not checked in`, r.check_in < today ? "Front desk → Not checked in yet: set when they arrived (and left), or No-show" : null, "property", localIso(r.check_in, "14:00"), "#desk", now));
  for (const r of await all<any>(db, `SELECT b.id, b.check_out, b.gross_paise, g.name, (SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END),0) FROM payments WHERE booking_id = b.id AND status != 'void') AS paid
       FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.status = 'checked_in' AND b.check_out <= ? ORDER BY b.check_out`, p.id, today)) {
    const due = r.gross_paise - r.paid;
    if (r.check_out < today) out.push(item("overstay", `overstay:${r.id}`, `${r.name} was due out ${r.check_out} · still checked in`, due > 0 ? `balance ₹${(due / 100).toLocaleString("en-IN")}` : null, "property", localIso(r.check_out, "11:00"), "#desk", now));
    else if (due > 0) out.push(item("departure", `departure:${r.id}`, `${r.name} leaves today · balance ₹${(due / 100).toLocaleString("en-IN")} to collect`, null, "property", localIso(r.check_out, "08:00"), "#desk", now));
  }
  // A stay that ended with money still owed (guest pays us: direct and pay-at-property) stays on the desk until
  // collected; past its tolerance it goes to the owner like any other desk item.
  for (const r of await all<any>(db, `SELECT b.id, b.check_out, b.checked_out_at, b.gross_paise, g.name, ch.name AS channel, (SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END),0) FROM payments WHERE booking_id = b.id AND status != 'void') AS paid
       FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND b.status = 'checked_out' AND ch.collection_type != 'channel_collect' ORDER BY b.check_out`, p.id)) {
    const due = r.gross_paise - r.paid;
    if (due > 0) out.push(item("unpaid", `unpaid:${r.id}`, `${r.name} left ${r.check_out} owing ₹${(due / 100).toLocaleString("en-IN")}`, `${r.channel} · collect, or record what was already collected`, "property", r.checked_out_at ?? localIso(r.check_out, "11:00"), "#pay", now));
  }
  // Guest IDs: a checked-in stay with no document yet; Form C open on a foreign stay; finished stays whose IDs cannot archive because Drive is not connected.
  for (const r of await all<any>(db, "SELECT b.id, b.checked_in_at, g.name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.status = 'checked_in' AND NOT EXISTS (SELECT 1 FROM guest_documents d WHERE d.booking_id = b.id AND d.deleted_at IS NULL) ORDER BY b.checked_in_at", p.id))
    out.push(item("idproof", `idproof:${r.id}`, `${r.name} · no ID proof on file`, "photograph Aadhaar / passport / licence", "property", r.checked_in_at, "#ids", now));
  for (const r of await all<any>(db, "SELECT b.id, b.check_in, b.checked_in_at, g.name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.form_c_status = 'due' AND b.status NOT IN ('cancelled','no_show') ORDER BY b.check_in", p.id))
    out.push(item("formc", `formc:${r.id}`, `${r.name} · Form C to file (foreign national)`, "FRRO portal within 24 h of arrival; record the acknowledgement", "sales", r.checked_in_at ?? localIso(r.check_in, "14:00"), "#ids", now));
  {
    const w = await one<{ n: number; oldest: string | null }>(db, "SELECT COUNT(*) AS n, MIN(COALESCE(b.checked_out_at, b.updated_at)) AS oldest FROM bookings b WHERE b.property_id = ? AND b.status IN ('checked_out','cancelled','no_show') AND b.ids_archived_at IS NULL AND EXISTS (SELECT 1 FROM guest_documents d WHERE d.booking_id = b.id AND d.deleted_at IS NULL AND d.r2_key IS NOT NULL)", p.id);
    if (w && w.n > 0 && w.oldest) out.push(item("idarchive", "idarchive", `${w.n} finished stay${w.n > 1 ? "s" : ""} with ID documents waiting to archive`, "they move to Google Drive 48 h after the stay; connect Drive under Settings if this keeps waiting", "owner", new Date(Date.parse(w.oldest.replace(" ", "T") + (w.oldest.includes("+") || w.oldest.endsWith("Z") ? "" : "Z")) + 48 * 3_600_000).toISOString(), "#ids", now));
  }
  for (const r of await all<any>(db, "SELECT t.id, t.title, t.kind, t.priority, t.created_at, t.due_on, l.name AS loc FROM tasks t JOIN locations l ON l.id = t.location_id WHERE t.property_id = ? AND t.status IN ('open','in_progress') ORDER BY t.created_at", p.id))
    out.push(item("task", `task:${r.id}`, `${r.title} · ${r.loc}`, `${r.kind}${r.priority === "high" ? " · high priority" : ""}${r.due_on ? ` · due ${r.due_on}` : ""}`, "property", r.created_at, "#tasks", now));
  for (const r of await all<any>(db, "SELECT id, received_at, parsed_json FROM inbox_items WHERE property_id = ? AND kind = 'payment' AND status = 'routed' ORDER BY received_at", p.id)) {
    const d = r.parsed_json ? JSON.parse(r.parsed_json) : {};
    out.push(item("receipt", `receipt:${r.id}`, `${d.via ?? "Airpay"} receipt ${d.order_id ?? ""} · ₹${((d.amount_paise ?? 0) / 100).toLocaleString("en-IN")} not matched to a stay`, d.payer_name ?? null, "property", r.received_at, "#pay", now));
  }
  // A website booking the guest paid online, whose Airpay receipt never reached the books (a mail filter that
  // did not forward it, say). The booking email says what was paid; the payment is recorded from the receipt.
  for (const r of await all<any>(db, `SELECT i.id, i.received_at, json_extract(i.parsed_json, '$.amount_paid_paise') AS paid_online, g.name,
       COALESCE((SELECT SUM(CASE WHEN p.kind = 'refund' THEN -p.amount_paise ELSE p.amount_paise END) FROM payments p WHERE p.booking_id = b.id AND p.status != 'void'), 0) AS recorded
     FROM inbox_items i JOIN bookings b ON b.id = i.booking_id JOIN guests g ON g.id = b.guest_id
     WHERE i.property_id = ? AND i.source = 'bookingengine' AND i.kind = 'new_reservation' AND b.status NOT IN ('cancelled','no_show')
       AND json_extract(i.parsed_json, '$.amount_paid_paise') > 0 ORDER BY i.received_at`, p.id)) {
    if (r.recorded >= r.paid_online) continue;
    out.push(item("paidonline", `paidonline:${r.id}`, `${r.name} paid ₹${(r.paid_online / 100).toLocaleString("en-IN")} online · not in the books`, "the Airpay receipt has not arrived: forward it to the AVOS inbox, or record the payment on Payments", "revenue", r.received_at, "#pay", now));
  }
  // Revenue: approvals, OTA payouts not settled, bank lines not reconciled.
  for (const r of await all<any>(db, "SELECT id, kind, summary, created_at FROM approvals WHERE property_id = ? AND status = 'pending' ORDER BY created_at", p.id))
    out.push(item("approval", `approval:${r.id}`, `${r.kind} approval · ${r.summary}`, null, "revenue", r.created_at, "#appr", now));
  for (const r of await all<any>(db, `SELECT b.id, b.checked_out_at, b.check_out, b.gross_paise, g.name, ch.name AS channel FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id
       WHERE b.property_id = ? AND ch.collection_type = 'channel_collect' AND b.status = 'checked_out'
         AND b.id NOT IN (SELECT si.booking_id FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id WHERE s.status = 'settled') ORDER BY b.check_out`, p.id))
    out.push(item("payout", `payout:${r.id}`, `${r.channel} payout for ${r.name} not settled`, `stay ended ${r.check_out} · ₹${(r.gross_paise / 100).toLocaleString("en-IN")} gross`, "revenue", r.checked_out_at ?? localIso(r.check_out, "11:00"), "#payouts", now));
  for (const r of await all<any>(db, "SELECT id, on_date, description, amount_paise FROM bank_statement_lines WHERE property_id = ? AND status IN ('unmatched','proposed') ORDER BY on_date", p.id))
    out.push(item("bank", `bank:${r.id}`, `Bank line ${r.on_date} · ₹${(Math.abs(r.amount_paise) / 100).toLocaleString("en-IN")} ${r.amount_paise < 0 ? "out" : "in"} not reconciled`, r.description, "revenue", localIso(r.on_date, "18:00"), "#recon", now));
  // Revenue: a live booking taxed on a slab that does not match the price charged (made before the slab followed the price).
  {
    const pol = gstPolicy(p);
    const rows = await all<any>(db, `SELECT b.id, b.check_in, b.created_at, g.name, br.nightly_rate_paise, br.gst_rate_bp FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN booking_rooms br ON br.booking_id = b.id
       WHERE b.property_id = ? AND b.status IN ('provisional','approved','checked_in') ORDER BY b.check_in`, p.id);
    const seen = new Set<string>();
    for (const r of rows) if (!seen.has(r.id) && r.gst_rate_bp !== slabBpForRoomNight(pol, r.nightly_rate_paise)) {
      seen.add(r.id);
      out.push(item("gstslab", `gstslab:${r.id}`, `${r.name} (${r.check_in}) · GST slab does not match the price charged`, "check the OTA voucher or quote, then Amend the booking so GST is recomputed", "revenue", r.created_at, "#resv", now));
    }
  }
  // Revenue: money left in Airpay clearing when no Airpay payment is waiting to settle: Airpay's real charges differ from the estimate.
  {
    const gw = await one<{ id: string; bal: number; last: string | null }>(db, `SELECT a.id,
         a.opening_paise + COALESCE((SELECT SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END) FROM payments WHERE account_id = a.id AND status != 'void'),0)
         + COALESCE((SELECT SUM(amount_paise) FROM other_income WHERE account_id = a.id AND voided_at IS NULL),0)
         - COALESCE((SELECT SUM(amount_paise) FROM expenses WHERE paid_from_account_id = a.id AND voided_at IS NULL),0)
         + COALESCE((SELECT SUM(amount_paise) FROM transfers WHERE to_account_id = a.id AND voided_at IS NULL),0)
         - COALESCE((SELECT SUM(amount_paise) FROM transfers WHERE from_account_id = a.id AND voided_at IS NULL),0) AS bal,
         (SELECT MAX(received_on) FROM payments WHERE account_id = a.id AND status != 'void') AS last
       FROM money_accounts a WHERE a.property_id = ? AND a.kind = 'gateway' AND a.active = 1 ORDER BY a.id LIMIT 1`, p.id);
    const quietSince = gw?.last ? new Date(Date.parse(`${gw.last}T00:00:00+05:30`) + 5 * 86_400_000).toISOString().slice(0, 10) : null;
    if (gw && gw.bal !== 0 && quietSince && today >= quietSince)
      out.push(item("airpay", `airpay:${gw.id}:${gw.bal}`, `Airpay clearing holds ₹${(gw.bal / 100).toLocaleString("en-IN")} with nothing left to settle`, "Airpay's actual charges differ from the 2.75% + GST estimate: adjust the fee expenses to the settlement (or tell the owner)", "revenue", localIso(quietSince, "09:00"), "#recon", now));
  }
  // Owner: refunds approved by the revenue desk and not yet paid.
  for (const r of await all<any>(db, `SELECT a.id, a.summary, a.amount_paise, a.decided_at, a.created_at FROM approvals a WHERE a.property_id = ? AND a.kind = 'refund' AND a.status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.refund_approval_id = a.id AND p.status != 'void') ORDER BY a.decided_at`, p.id))
    out.push(item("refund", `refund:${r.id}`, `Refund to pay · ${r.summary}`, `₹${((r.amount_paise ?? 0) / 100).toLocaleString("en-IN")} approved: make the transfer, then record it on Approvals`, "owner", r.decided_at ?? r.created_at, "#appr", now));
  // Accountant: lock last month by the 5th, file GST by the 15th.
  const prev = previousPeriod(periodOf(today));
  const lock: any = (await all<any>(db, "SELECT status FROM period_locks WHERE property_id = ? AND period = ?", p.id, prev))[0];
  const cur = periodOf(today);
  if (!lock || !["locked", "filed"].includes(lock.status)) { if (today >= `${cur}-05`) out.push(item("lock", `lock:${prev}`, `Lock ${prev} · the month is still ${lock?.status ?? "open"}`, "pre-close, then lock, so the books stop moving", "accountant", localIso(`${cur}-05`, "09:00"), "#close", now)); }
  else if (lock.status === "locked" && today >= `${cur}-15`) out.push(item("file", `file:${prev}`, `File GST for ${prev}`, "the sheet is ready under GST filing sheet", "accountant", localIso(`${cur}-15`, "09:00"), "#gst", now));
  return out;
}

/** What one role sees: its own items, items raised to it, and (owner) everything overdue anywhere. */
export async function queueForRole(db: D1Database, p: PropertyRow, role: string, now = nowIso()) {
  const items = await allWorkItems(db, p, now);
  const esc = await all<any>(db, "SELECT item_key, escalated_to, escalated_at FROM work_escalations WHERE property_id = ? AND cleared_at IS NULL", p.id);
  const byKey = new Map(esc.map((e) => [e.item_key, e]));
  for (const it of items) { const e = byKey.get(it.key); if (e) { it.escalated_to = e.escalated_to; it.escalated_at = e.escalated_at; } }
  const mine = items.filter((i) => i.owner_role === role);
  const raised = items.filter((i) => i.owner_role !== role && (i.escalated_to === role || (role === "owner" && i.overdue)));
  const order = (a: WorkItem, b: WorkItem) => Number(b.overdue) - Number(a.overdue) || b.waited_hours - a.waited_hours;
  mine.sort(order); raised.sort(order);
  return { items: mine, raised, overdue: mine.filter((i) => i.overdue).length, tolerance_hours: TOLERANCE };
}

/** Cron: raise newly overdue items once to the next role; close the record when an item stops waiting. */
export async function runEscalations(env: Env, p: PropertyRow, now = nowIso()) {
  const items = await allWorkItems(env.DB, p, now);
  const open = await all<any>(env.DB, "SELECT item_key, escalated_to FROM work_escalations WHERE property_id = ? AND cleared_at IS NULL", p.id);
  const openKeys = new Set(open.map((e) => e.item_key));
  const present = new Set(items.map((i) => i.key));
  const b = new Batch(env.DB, null);
  let raised = 0, cleared = 0;
  for (const it of items) {
    const to = ESCALATE_TO[it.owner_role];
    if (!it.overdue || !to || openKeys.has(it.key) || (env.WORK_QUEUE_LIVE_SINCE && it.since < env.WORK_QUEUE_LIVE_SINCE)) continue;
    b.add("INSERT INTO work_escalations (property_id, item_key, kind, title, owner_role, escalated_to, since, escalated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(property_id, item_key) DO UPDATE SET cleared_at = NULL, escalated_to = excluded.escalated_to, escalated_at = excluded.escalated_at, since = excluded.since",
      p.id, it.key, it.kind, it.title, it.owner_role, to, it.since, now);
    await notifyRole(b, p.id, to, "work_overdue", `Overdue with ${it.owner_role} for ${Math.round(it.waited_hours)} h: ${it.title}`, { kind: "work", id: it.key });
    raised++;
  }
  for (const e of open) if (!present.has(e.item_key)) { b.add("UPDATE work_escalations SET cleared_at = ? WHERE property_id = ? AND item_key = ?", now, p.id, e.item_key); cleared++; }
  if (b.size) await b.run();
  return { raised, cleared };
}

/** The slip report: what went overdue, who had it, how long it waited. */
export async function slips(db: D1Database, p: PropertyRow, days: number) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await all<any>(db, "SELECT * FROM work_escalations WHERE property_id = ? AND escalated_at >= ? ORDER BY escalated_at DESC", p.id, since);
  return rows.map((r) => ({ ...r, waited_hours: Math.round(hoursBetween(r.since, r.cleared_at ?? nowIso()) * 10) / 10 }));
}
