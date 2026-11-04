import { newRouter, requireCap, body, str, optStr, int, date, oneOf } from "../app";
import { Batch, HttpError, all, one, id, assertPeriodOpen } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { createBooking, cancelBooking, loadBooking, paidOnBooking , amendBooking } from "../services/bookings";
import { allowed } from "../auth";

const r = newRouter();

/** Availability grid: every room × night in a window with what occupies it (F1). */
r.get("/availability", requireCap("bookings_read"), async (c) => {
  const p = c.get("property");
  const from = date(c.req.query("from") ?? todayIn(p.timezone), "from");
  const to = date(c.req.query("to") ?? from, "to");
  const rooms = await all(c.env.DB, "SELECT id, code, name FROM locations WHERE property_id = ? AND kind = 'room' AND active = 1 ORDER BY sort", p.id);
  const taken = await all(c.env.DB,
    `SELECT rn.room_id, rn.night, rn.kind, rn.booking_id, rn.lead_id, rn.expires_at, g.name AS guest_name, b.status AS booking_status
     FROM room_nights rn LEFT JOIN bookings b ON b.id = rn.booking_id LEFT JOIN guests g ON g.id = b.guest_id
     WHERE rn.property_id = ? AND rn.night BETWEEN ? AND ? AND (rn.kind = 'booked' OR rn.expires_at > ?)`, p.id, from, to, nowIso());
  return c.json({ rooms, taken, from, to });
});

r.get("/", requireCap("bookings_read"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const from = c.req.query("from"), to = c.req.query("to"), status = c.req.query("status"), mine = c.req.query("mine") === "1";
  const where: string[] = ["b.property_id = ?"]; const params: unknown[] = [p.id];
  if (from) { where.push("b.check_out >= ?"); params.push(date(from, "from")); }
  if (to) { where.push("b.check_in <= ?"); params.push(date(to, "to")); }
  if (status) { where.push("b.status = ?"); params.push(status); }
  // Sales see their own bookings and every booking that came in through the inbox (OTA and website engine stays).
  if (mine || actor.role === "sales") { where.push("(b.created_by = ? OR b.salesperson_id = ? OR b.inbox_item_id IS NOT NULL)"); params.push(actor.id, actor.id); }
  const rows = await all(c.env.DB,
    `SELECT b.*, g.name AS guest_name, g.phone AS guest_phone, ch.code AS channel_code, ch.name AS channel_name, ch.collection_type,
            (SELECT GROUP_CONCAT(l.name, ', ') FROM booking_rooms br JOIN locations l ON l.id = br.room_id WHERE br.booking_id = b.id) AS room_names,
            (SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END),0) FROM payments WHERE booking_id = b.id AND status != 'void') AS paid_paise,
            (SELECT number FROM invoices WHERE booking_id = b.id ORDER BY created_at DESC LIMIT 1) AS invoice_number
     FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id
     WHERE ${where.join(" AND ")} ORDER BY b.check_in DESC LIMIT 300`, ...params);
  return c.json({ bookings: rows });
});

r.get("/:id", requireCap("bookings_read"), async (c) => {
  const p = c.get("property");
  const bk = await loadBooking(c.env.DB, p.id, c.req.param("id"));
  const [guest, channel, rooms, payments, invoices, approvals, audit] = await Promise.all([
    one(c.env.DB, "SELECT * FROM guests WHERE id = ?", bk.guest_id),
    one(c.env.DB, "SELECT * FROM channels WHERE id = ?", bk.channel_id),
    all(c.env.DB, "SELECT br.*, l.name AS room_name, l.code AS room_code FROM booking_rooms br JOIN locations l ON l.id = br.room_id WHERE br.booking_id = ?", bk.id),
    all(c.env.DB, "SELECT p.*, a.name AS account_name FROM payments p JOIN money_accounts a ON a.id = p.account_id WHERE p.booking_id = ? ORDER BY p.received_on", bk.id),
    all(c.env.DB, "SELECT id, number, issued_on, total_paise, balance_paise, status FROM invoices WHERE booking_id = ?", bk.id),
    all(c.env.DB, "SELECT * FROM approvals WHERE ref_id = ? ORDER BY created_at", bk.id),
    all(c.env.DB, "SELECT * FROM audit_log WHERE entity = 'booking' AND entity_id = ? ORDER BY at", bk.id),
  ]);
  const paid = await paidOnBooking(c.env.DB, bk.id);
  // OTA commercial terms and gateway fees are the revenue desk's, owner's and CA's; the desks see the stay and what was collected.
  if (!allowed(c.get("actor"), "finance")) {
    for (const k of ["commission_bp", "commission_gst_bp", "commission_rcm_bp", "commission_base", "payment_fee_bp", "payment_fee_base", "tcs_bp", "tds_bp"]) delete (channel as any)?.[k];
    for (const pay of payments as any[]) delete pay.fee_expense_id;
  }
  return c.json({ booking: bk, guest, channel, rooms, payments, invoices, approvals, audit, paid_paise: paid, balance_paise: bk.gross_paise - paid });
});

/** Manual direct booking (W2). */
r.post("/", requireCap("bookings_write"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const rooms = Array.isArray(x.rooms) ? x.rooms as { room_id: string; nightly_rate_paise: number }[] : [];
  if (!rooms.length) throw new HttpError(400, "rooms required");
  const result = await createBooking(c.env.DB, actor, p, {
    guest: { id: optStr(x.guest_id, "guest_id"), name: str(x.guest_name ?? "", "guest_name", { optional: !!x.guest_id }) || "", phone: optStr(x.guest_phone, "guest_phone"), email: optStr(x.guest_email, "guest_email") },
    channelCode: optStr(x.channel_code, "channel_code") ?? "direct", externalRef: optStr(x.external_ref, "external_ref"),
    checkIn: date(x.check_in, "check_in"), checkOut: date(x.check_out, "check_out"),
    adults: int(x.adults ?? 2, "adults", { min: 1 }), children: int(x.children ?? 0, "children", { min: 0, optional: true }),
    rooms: rooms.map((rm) => ({ roomId: str(rm.room_id, "rooms[].room_id"), nightlyRatePaise: int(rm.nightly_rate_paise, "rooms[].nightly_rate_paise", { min: 0 }) })),
    notes: optStr(x.notes, "notes"), isOta: (optStr(x.channel_code, "channel_code") ?? "direct") !== "direct", inboxItemId: optStr(x.inbox_item_id, "inbox_item_id"),
  });
  const inboxId = optStr(x.inbox_item_id, "inbox_item_id");
  if (inboxId) {
    const b = new Batch(c.env.DB, actor);
    b.add("UPDATE inbox_items SET status = 'approved', booking_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND property_id = ? AND status = 'pending'", result.id, actor.id, nowIso(), inboxId, p.id);
    b.audit("inbox.approve", "inbox_item", inboxId, { status: "pending" }, { status: "approved", booking_id: result.id, by_hand: true });
    await b.run();
  }
  return c.json({ booking: result }, 201);
});

function ownUnapproved(actor: { id: string; role: string }, bk: { status: string; created_by: string | null }) {
  if (actor.role === "sales") return bk.status === "provisional" && bk.created_by === actor.id;
  return bk.status === "provisional" || bk.status === "approved";
}

/** Sales may edit or delete only their own unapproved bookings; approved bookings are read-only to sales. */
r.patch("/:id", requireCap("bookings_write"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const bk = await loadBooking(c.env.DB, p.id, c.req.param("id"));
  if (!ownUnapproved(actor, bk)) throw new HttpError(403, "only your own unapproved bookings can be edited");
  const x = await body(c);
  const after: Record<string, unknown> = {};
  if (x.notes !== undefined) after.notes = optStr(x.notes, "notes");
  if (x.adults !== undefined) after.adults = int(x.adults, "adults", { min: 1 });
  if (x.children !== undefined) after.children = int(x.children, "children", { min: 0, optional: true });
  if (!Object.keys(after).length) throw new HttpError(400, "dates, rooms and rates are changed by deleting and re-entering the booking; only notes/adults/children edit in place");
  const b = new Batch(c.env.DB, actor);
  b.add(`UPDATE bookings SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...Object.values(after), nowIso(), bk.id);
  b.audit("booking.update", "booking", bk.id, Object.fromEntries(Object.keys(after).map((k) => [k, (bk as any)[k]])), after);
  await b.run();
  return c.json({ ok: true });
});

/** Amend in place with a remark: room exchange, dates, rates, guest, channel. Sales, revenue and the owner. */
r.post("/:id/amend", requireCap("bookings_write"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const rooms = Array.isArray(x.rooms) ? (x.rooms as { room_id: string; nightly_rate_paise: number }[]).map((rm) => ({ roomId: str(rm.room_id, "rooms[].room_id"), nightlyRatePaise: int(rm.nightly_rate_paise, "rooms[].nightly_rate_paise", { min: 0 }) })) : undefined;
  const res = await amendBooking(c.env.DB, actor, p, c.req.param("id"), {
    rooms, checkIn: x.check_in === undefined ? undefined : date(x.check_in, "check_in"), checkOut: x.check_out === undefined ? undefined : date(x.check_out, "check_out"),
    guestName: x.guest_name === undefined ? undefined : optStr(x.guest_name, "guest_name"), guestPhone: x.guest_phone === undefined ? undefined : optStr(x.guest_phone, "guest_phone"),
    adults: x.adults === undefined ? undefined : int(x.adults, "adults", { min: 1 }), children: x.children === undefined ? undefined : int(x.children, "children", { min: 0 }),
    channelCode: optStr(x.channel_code, "channel_code") ?? undefined, externalRef: x.external_ref === undefined ? undefined : optStr(x.external_ref, "external_ref"),
    remark: str(x.remark, "remark"),
  });
  return c.json({ booking: res });
});

r.delete("/:id", requireCap("bookings_write"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const bk = await loadBooking(c.env.DB, p.id, c.req.param("id"));
  if (!ownUnapproved(actor, bk)) throw new HttpError(403, "only your own unapproved bookings can be deleted");
  if ((await paidOnBooking(c.env.DB, bk.id)) !== 0) throw new HttpError(409, "booking has payments; cancel it instead");
  const b = new Batch(c.env.DB, actor);
  b.add("DELETE FROM room_nights WHERE booking_id = ?", bk.id);
  b.add("DELETE FROM booking_rooms WHERE booking_id = ?", bk.id);
  b.add("UPDATE approvals SET status = 'returned', note = 'booking deleted', decided_at = ? WHERE ref_id = ? AND status = 'pending'", nowIso(), bk.id);
  b.add("UPDATE leads SET status = 'quoted', booking_id = NULL WHERE booking_id = ?", bk.id);
  b.add("DELETE FROM bookings WHERE id = ?", bk.id);
  b.audit("booking.delete", "booking", bk.id, bk, null);
  await b.run();
  return c.json({ ok: true });
});

r.post("/:id/cancel", requireCap("bookings_write"), async (c) => {
  const p = c.get("property"); const x = await body(c);
  const res = await cancelBooking(c.env.DB, c.get("actor"), p, c.req.param("id"), "cancelled", str(x.reason, "reason"));
  return c.json(res);
});
r.post("/:id/no-show", requireCap("frontdesk"), async (c) => {
  const p = c.get("property"); const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const res = await cancelBooking(c.env.DB, c.get("actor"), p, c.req.param("id"), "no_show", optStr(x.reason, "reason") ?? "no show");
  return c.json(res);
});

// ---- Front desk (Sindhu) ----
r.get("/frontdesk/today", requireCap("frontdesk"), async (c) => {
  const p = c.get("property");
  const today = c.req.query("date") ?? todayIn(p.timezone);
  const sql = (where: string) => `SELECT b.id, b.status, b.check_in, b.check_out, b.gross_paise, b.external_ref, g.name AS guest_name, g.phone AS guest_phone, ch.name AS channel_name, ch.collection_type,
      (SELECT GROUP_CONCAT(l.name, ', ') FROM booking_rooms br JOIN locations l ON l.id = br.room_id WHERE br.booking_id = b.id) AS room_names,
      (SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END),0) FROM payments WHERE booking_id = b.id AND status != 'void') AS paid_paise,
      (SELECT COUNT(*) FROM guest_documents d WHERE d.booking_id = b.id AND d.deleted_at IS NULL) AS doc_count, b.guest_nationality, b.form_c_status
     FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND ${where} ORDER BY b.check_in`;
  const [arrivals, late, departures, inHouse] = await Promise.all([
    all(c.env.DB, sql("b.check_in = ? AND b.status IN ('approved','provisional')"), p.id, today),
    // Stays that have already started (or end today) but were never checked in: a guest who came late,
    // or a check-in the desk forgot. Without this list they appear on My work but nowhere on the desk.
    // Includes stays that have already ended (check-out date passed): the desk records arrival and departure after the fact, or a no-show.
    all(c.env.DB, sql("b.check_in < ? AND b.status IN ('approved','provisional')"), p.id, today),
    all(c.env.DB, sql("b.check_out = ? AND b.status = 'checked_in'"), p.id, today),
    all(c.env.DB, sql("b.status = 'checked_in' AND b.check_out > ?"), p.id, today),
  ]);
  return c.json({ date: today, arrivals, late_arrivals: late, departures, in_house: inHouse });
});

r.post("/:id/check-in", requireCap("frontdesk"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const bk = await loadBooking(c.env.DB, p.id, c.req.param("id"));
  if (bk.status === "provisional") throw new HttpError(409, "booking is awaiting approval");
  if (bk.status !== "approved") throw new HttpError(409, `booking is ${bk.status}`);
  // Optional arrived_at: when the desk records a check-in after the fact (guest came late at night,
  // or the desk forgot), the real arrival time is kept instead of "now". It must fall between the
  // booked check-in date and now.
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const now = nowIso();
  let at = now;
  const given = optStr(x.arrived_at, "arrived_at");
  if (given) {
    const t = Date.parse(given);
    if (Number.isNaN(t)) throw new HttpError(400, "arrived_at is not a date and time");
    if (t > Date.now() + 5 * 60_000) throw new HttpError(400, "arrival time is in the future");
    const localDay = todayIn(p.timezone, new Date(t));
    if (localDay < bk.check_in) throw new HttpError(400, `arrival is before the booked check-in (${bk.check_in})`);
    at = new Date(t).toISOString();
  }
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE bookings SET status = 'checked_in', checked_in_at = ?, updated_at = ? WHERE id = ?", at, now, bk.id);
  b.audit("booking.check_in", "booking", bk.id, { status: bk.status }, { status: "checked_in", at, ...(given ? { recorded_at: now } : {}) });
  await b.run();
  return c.json({ ok: true, checked_in_at: at });
});

/**
 * Check-out: direct guests chain into Collect → Invoice (the response carries the balance);
 * channel-collect OTA guests collect nothing. A housekeeping task is created for every room either way.
 */
r.post("/:id/check-out", requireCap("frontdesk"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const bk = await loadBooking(c.env.DB, p.id, c.req.param("id"));
  if (bk.status !== "checked_in") throw new HttpError(409, `booking is ${bk.status}`);
  await assertPeriodOpen(c.env.DB, p.id, bk.books_date);
  const channel: any = await one(c.env.DB, "SELECT * FROM channels WHERE id = ?", bk.channel_id);
  const rooms = await all<{ room_id: string; room_name: string }>(c.env.DB, "SELECT br.room_id, l.name AS room_name FROM booking_rooms br JOIN locations l ON l.id = br.room_id WHERE br.booking_id = ?", bk.id);
  const paid = await paidOnBooking(c.env.DB, bk.id);
  const collectNow = channel.collection_type === "channel_collect" ? 0 : Math.max(0, bk.gross_paise - paid);
  // Optional departed_at: a check-out recorded after the fact keeps the time the guest really left
  // (not before they arrived, not in the future). A departure on an earlier day needs no cleaning task now.
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const now = nowIso();
  let at = now;
  const given = optStr(x.departed_at, "departed_at");
  if (given) {
    const t = Date.parse(given);
    if (Number.isNaN(t)) throw new HttpError(400, "departed_at is not a date and time");
    if (t > Date.now() + 5 * 60_000) throw new HttpError(400, "departure time is in the future");
    if (bk.checked_in_at && t < Date.parse(bk.checked_in_at)) throw new HttpError(400, "departure is before the guest checked in");
    at = new Date(t).toISOString();
  }
  const pastDeparture = !!given && todayIn(p.timezone, new Date(at)) < todayIn(p.timezone);
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE bookings SET status = 'checked_out', checked_out_at = ?, updated_at = ? WHERE id = ?", at, now, bk.id);
  const taskIds: string[] = [];
  if (!pastDeparture) for (const rm of [...new Map(rooms.map((x) => [x.room_id, x])).values()]) {
    const tid = id("tsk"); taskIds.push(tid);
    b.add("INSERT INTO tasks (id, property_id, location_id, kind, title, priority, status, due_on, booking_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
      tid, p.id, rm.room_id, "housekeeping", `Clean after checkout · ${rm.room_name}`, "normal", "open", todayIn(p.timezone), bk.id, actor.id);
  }
  b.audit("booking.check_out", "booking", bk.id, { status: "checked_in" }, { status: "checked_out", at, ...(given ? { recorded_at: now } : {}), balance_to_collect_paise: collectNow, housekeeping_tasks: taskIds });
  await b.run();
  const invoice = await one<{ id: string; number: string }>(c.env.DB, "SELECT id, number FROM invoices WHERE booking_id = ?", bk.id);
  return c.json({ ok: true, collection_type: channel.collection_type, balance_due_paise: collectNow, paid_paise: paid, gross_paise: bk.gross_paise, housekeeping_tasks: taskIds, invoice, next: collectNow > 0 ? "collect" : invoice ? "done" : channel.collection_type === "channel_collect" ? "done" : "invoice" });
});

export default r;
export { oneOf as _o, allowed as _a };
