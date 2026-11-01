import { newRouter, requireCap, body, str, optStr, int, date } from "../app";
import { Batch, HttpError, all, one, id, loadProperty } from "../db";
import { nowIso } from "../domain/dates";
import { splitInclusive } from "../domain/money";
import { readRawEmail } from "../email/raw";
import { parseInboundEmail, PARSER_VERSION, type ParsedEmail } from "../email/parsers";
import { createBooking, gstPolicy, conflicts } from "../services/bookings";
import { autoApply, REF_MATCH, refArgs } from "../services/inboxAuto";
import { slabBpForRoomNight } from "../domain/gst";
import { isWholeVilla } from "../email/parsers";
import type { Env } from "../env";
import { allowed } from "../auth";

const r = newRouter();
r.use("*", requireCap("inbox"));

// Bank alerts and gateway receipts carry balances and settlement amounts: the revenue desk, owner and CA only.
const FINANCE_ITEM = "(i.kind IN ('bank_alert','payment') OR i.source IN ('bank','airpay'))";
const isFinanceItem = (it: { kind: string; source: string }) => ["bank_alert", "payment"].includes(it.kind) || ["bank", "airpay"].includes(it.source);
const guardItem = async (c: any, next: () => Promise<void>) => {
  if (!allowed(c.get("actor"), "finance")) {
    const it: any = await one(c.env.DB, "SELECT kind, source FROM inbox_items WHERE id = ? AND property_id = ?", c.req.param("id"), c.get("property").id);
    if (it && isFinanceItem(it)) throw new HttpError(404, "inbox item not found");
  }
  await next();
};
r.use("/:id", guardItem);
r.use("/:id/*", guardItem);

/** Nightly rate ex-GST implied by the email, the same way Approve derives it. */
function impliedNightly(p: any, d: Record<string, any>, roomsN: number): number | null {
  if (!d.check_in || !d.check_out) return null;
  const nights = Math.max(1, Math.round((Date.parse(d.check_out) - Date.parse(d.check_in)) / 86_400_000));
  if (d.nightly_rate_paise) return Number(d.nightly_rate_paise);
  if (d.room_total_paise) return Math.round(Number(d.room_total_paise) / (nights * roomsN));
  if (d.total_incl_gst_paise) { const perNight = Math.round(Number(d.total_incl_gst_paise) / (nights * roomsN)); return splitInclusive(perNight, slabBpForRoomNight(gstPolicy(p), perNight)).ex; }
  return null;
}

/**
 * Waiting cards carry everything a person needs to decide in one tap: every room with whether it is free for the
 * stay (and who holds it when not), the rooms automation would have picked, and the nightly rate the email implies.
 */
r.get("/", async (c) => {
  const p = c.get("property");
  const status = c.req.query("status") ?? "pending";
  const fin = allowed(c.get("actor"), "finance");
  const rows = await all(c.env.DB, `SELECT i.*, b.status AS booking_status FROM inbox_items i LEFT JOIN bookings b ON b.id = i.booking_id WHERE i.property_id = ? AND i.status = ? ${fin ? "" : `AND NOT ${FINANCE_ITEM}`} ORDER BY i.received_at DESC LIMIT 100`, p.id, status);
  const rooms = await all<{ id: string; name: string; code: string }>(c.env.DB, "SELECT id, name, code FROM locations WHERE property_id = ? AND kind = 'room' AND active = 1 ORDER BY sort, code", p.id);
  const items = [];
  for (const x of rows as any[]) {
    const d = x.parsed_json ? JSON.parse(x.parsed_json) : null;
    // OTA commission from the channel's email is a commercial term, not something sales records.
    if (d && !fin) { delete d.commission_paise; delete d.commission_bp; }
    if (!fin) delete x.parsed_json;
    let room_options: unknown[] | null = null, suggested_room_ids: string[] = [], nightly_rate_paise: number | null = null;
    if (x.status === "pending" && x.kind === "new_reservation" && d?.check_in && d?.check_out && d.check_in < d.check_out) {
      const taken = await conflicts(c.env.DB, p.id, rooms.map((r) => r.id), d.check_in, d.check_out);
      const holders: Record<string, string> = {};
      for (const t of taken) {
        if (holders[t.room_id]) continue;
        const who: any = t.booking_id ? await one(c.env.DB, "SELECT g.name, b.status FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.id = ?", t.booking_id)
          : t.lead_id ? await one(c.env.DB, "SELECT g.name, 'hold' AS status FROM leads l JOIN guests g ON g.id = l.guest_id WHERE l.id = ?", t.lead_id) : null;
        holders[t.room_id] = who ? `${who.name}${who.status === "provisional" ? " (awaiting approval)" : who.status === "hold" ? " (on hold)" : ""}` : "another booking";
      }
      const villa = isWholeVilla(d.room_name);
      const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      // Every room type the email lists, each with how many rooms of it (a STAAH email repeats a block per type).
      const types: { want: string; count: number }[] = Array.isArray(d.room_types) && d.room_types.length > 1
        ? d.room_types.map((t: any) => ({ want: norm(t.name), count: Math.max(1, Number(t.count ?? 1)) }))
        : [{ want: norm(d.room_name), count: villa ? rooms.length : Math.max(1, Number(d.rooms ?? 1)) }];
      const isType = (r: { name: string }, want: string) => { if (villa) return true; const n = norm(r.name); return !!want && (n === want || want.startsWith(n) || n.startsWith(want)); };
      room_options = rooms.map((r) => ({ id: r.id, name: r.name, free: !holders[r.id], taken_by: holders[r.id] ?? null, matches_type: types.some((t) => isType(r, t.want)) }));
      for (const t of types) suggested_room_ids.push(...rooms.filter((r) => isType(r, t.want) && !holders[r.id] && !suggested_room_ids.includes(r.id)).slice(0, t.count).map((r) => r.id));
      const wanted = types.reduce((n, t) => n + t.count, 0);
      nightly_rate_paise = impliedNightly(p, d, wanted);
    }
    // A modification is applied by amending the booking it refers to, never by booking again.
    let booking_match: unknown = null;
    if (x.kind === "modification" && x.external_ref) booking_match = await one(c.env.DB, `SELECT b.id, b.status, b.check_in, b.check_out, g.name AS guest_name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND ${REF_MATCH} AND b.status NOT IN ('cancelled','no_show') ORDER BY b.created_at DESC LIMIT 1`, p.id, ...refArgs(x.external_ref));
    items.push({ ...x, parsed: d, room_options, suggested_room_ids, nightly_rate_paise, booking_match });
  }
  return c.json({ items, rooms });
});

/** Status an email starts in: a known reservation is a duplicate; a payment routes to the Payments screen. */
async function initialStatus(env: Env, propertyId: string, parsed: ParsedEmail, self?: { id: string; received_at: string }): Promise<string> {
  if (parsed.external_ref && parsed.kind === "new_reservation") {
    const dup = await one(env.DB, `SELECT id FROM bookings WHERE property_id = ? AND ${REF_MATCH}`, propertyId, ...refArgs(parsed.external_ref));
    if (dup) return "duplicate";
    // The same stay under its other number: STAAH's email carries the OTA's reference too, and the OTA's own
    // voucher may have booked it already (or the other way round).
    const ota = String((parsed.data as any).ota_ref ?? "");
    if (ota && ota !== parsed.external_ref && await one(env.DB, `SELECT id FROM bookings WHERE property_id = ? AND ${REF_MATCH}`, propertyId, ...refArgs(ota))) return "duplicate";
    // The same notification forwarded twice: the earlier card stands, the later one is a duplicate of it.
    const earlier = await one(env.DB, "SELECT id FROM inbox_items WHERE property_id = ? AND kind = 'new_reservation' AND external_ref = ? AND status IN ('pending','approved') AND id != ? AND received_at <= ?",
      propertyId, parsed.external_ref, self?.id ?? "", self?.received_at ?? "9999");
    if (earlier) return "duplicate";
  }
  return parsed.kind === "payment" || parsed.kind === "bank_alert" ? "routed" : "pending";
}

/**
 * Mail that is not AVOS's business is filed as dismissed with the reason, so it never waits for a person: mail our
 * own staff wrote (a quote, a reply to a guest) and anything else that is not a booking, payment or bank notification.
 * A forwarded email is kept: that is how staff hand AVOS something on purpose.
 */
/** A payment link sent to a guest is a record, not work: it is filed with what it asked for. */
function paymentRequestNote(parsed: ParsedEmail): string | null {
  if (parsed.kind !== "payment_request") return null;
  const d = parsed.data as Record<string, any>;
  const amt = d.amount_due_paise != null ? `₹${(Number(d.amount_due_paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "an amount";
  return `payment link sent to ${d.guest_name ?? "the guest"} for ${amt} (booking ${d.booking_ref ?? "?"}); the payment is recorded when its confirmation or Airpay receipt arrives`;
}

async function ownMailNote(env: Env, propertyId: string, from: string, subject: string, html: string | undefined, text: string | undefined, parsed: ParsedEmail): Promise<string | null> {
  if (parsed.source !== "unknown") return null;
  const addr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  if (!addr) return null;
  if (/^\s*(?:fwd?|fw)\s*:/i.test(subject) || /Forwarded message|Original Message|Begin forwarded message/i.test(`${text ?? ""}\n${html ?? ""}`)) return null;
  const own = await one(env.DB, "SELECT id FROM users WHERE property_id = ? AND lower(email) = ?", propertyId, addr);
  if (own) return `sent from our own mailbox (${addr}), not a booking or payment notification`;
  // bookings@ forwards everything it receives: AVOS keeps only bookings, payments and bank notifications. Mail it
  // cannot read but that looks like one (a new OTA, an unfamiliar payment email) still waits for a person, so nothing
  // that may be money or a stay is filed unseen; guest chatter, newsletters and offers are filed with the reason.
  const words = `${subject}\n${(text ?? html ?? "").slice(0, 4000)}`;
  if (/\b(reservation|booking|voucher|itinerary|check-?in|cancell?ation|cancell?ed|refund|payment|paid|transaction|credited|debited|settlement|payout|invoice|UTR|NEFT|IMPS|UPI)\b/i.test(words)) return null;
  return "not a booking, payment or bank notification: filed automatically";
}

/** Run automation on a stored item and return the outcome plus the row as it now stands. */
async function applyAutomation(env: Env, propertyId: string, iid: string, status: string, parsed: ParsedEmail, subject: string) {
  const property = await loadProperty(env.DB, propertyId);
  let auto: Awaited<ReturnType<typeof autoApply>> | null = null;
  if (property.inbox_automation === 1 && (status === "pending" || status === "routed")) {
    auto = await autoApply(env.DB, property, { id: iid, kind: parsed.kind, source: parsed.source, external_ref: parsed.external_ref, subject }, parsed);
    if (!auto.applied && auto.note !== "already recorded") await env.DB.prepare("UPDATE inbox_items SET auto_note = ? WHERE id = ?").bind(auto.note, iid).run();
  }
  const row = await one<{ status: string; booking_id: string | null; payment_id: string | null }>(env.DB, "SELECT status, booking_id, payment_id FROM inbox_items WHERE id = ?", iid);
  return { id: iid, status: row?.status ?? status, booking_id: row?.booking_id ?? null, payment_id: row?.payment_id ?? null, auto, parsed };
}

/** Shared with the Email Worker: store an inbound email as an inbox item (duplicates flagged, payments routed), then apply it. */
export async function ingestEmail(env: Env, propertyId: string, msg: { message_id: string | null; from: string; subject: string; html?: string; text?: string; raw?: ArrayBuffer | null; received_at?: string }) {
  const parsed = parseInboundEmail(msg.from, msg.subject, msg.html, msg.text);
  const iid = id("inb");
  // Keep the original: the .eml from Email Routing, or the pasted text, so the item can be re-read after a parser update.
  let rawKey: string | null = null;
  if (msg.raw) { rawKey = `inbox/${propertyId}/${iid}.eml`; await env.FILES.put(rawKey, msg.raw, { httpMetadata: { contentType: "message/rfc822" } }); }
  else if (msg.text || msg.html) { rawKey = `inbox/${propertyId}/${iid}.txt`; await env.FILES.put(rawKey, JSON.stringify({ from: msg.from, subject: msg.subject, text: msg.text ?? null, html: msg.html ?? null }), { httpMetadata: { contentType: "application/json" } }); }
  const own = paymentRequestNote(parsed) ?? await ownMailNote(env, propertyId, msg.from, msg.subject, msg.html, msg.text, parsed);
  const status = own ? "dismissed" : await initialStatus(env, propertyId, parsed);
  const b = new Batch(env.DB, null);
  b.add(`INSERT INTO inbox_items (id, property_id, source, kind, message_id, from_addr, subject, received_at, raw_key, parsed_json, parser_version, external_ref, status, auto_note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    iid, propertyId, parsed.source, parsed.kind, msg.message_id, msg.from, msg.subject, msg.received_at ?? nowIso(), rawKey, JSON.stringify({ ...parsed.data, confidence: parsed.confidence }), PARSER_VERSION, parsed.external_ref, status, own);
  b.audit("inbox.ingest", "inbox_item", iid, null, { source: parsed.source, kind: parsed.kind, status, confidence: parsed.confidence, ...(own ? { reason: own } : {}) });
  await b.run();
  return applyAutomation(env, propertyId, iid, status, parsed, msg.subject);
}

/**
 * Re-read a waiting item from its stored original with the current parser, then apply it. Used by the
 * "Re-read" button and by the cron sweep after a parser update, so a template fix reaches old cards too.
 */
export async function reparseItem(env: Env, propertyId: string, itemId: string, actorId: string | null) {
  const item: any = await one(env.DB, "SELECT * FROM inbox_items WHERE id = ? AND property_id = ?", itemId, propertyId);
  if (!item) throw new HttpError(404, "inbox item not found");
  if (!["pending", "routed"].includes(item.status)) throw new HttpError(409, `item is ${item.status}`);
  let from = item.from_addr ?? "", subject = item.subject ?? "", html: string | undefined, text: string | undefined;
  const obj = item.raw_key ? await env.FILES.get(item.raw_key) : null;
  if (obj && item.raw_key.endsWith(".eml")) { const m = await readRawEmail(await obj.arrayBuffer()); from = m.from || from; subject = m.subject || subject; html = m.html; text = m.text; }
  else if (obj) { const j = JSON.parse(await obj.text()); from = j.from ?? from; subject = j.subject ?? subject; text = j.text ?? undefined; html = j.html ?? undefined; }
  else { const d = JSON.parse(item.parsed_json ?? "{}"); text = d.preview ?? ""; }
  const parsed = parseInboundEmail(from, subject, html, text);
  const own = paymentRequestNote(parsed) ?? await ownMailNote(env, propertyId, from, subject, html, text, parsed);
  const status = own ? "dismissed" : await initialStatus(env, propertyId, parsed, { id: item.id, received_at: item.received_at });
  const b = new Batch(env.DB, null);
  b.add("UPDATE inbox_items SET source = ?, kind = ?, parsed_json = ?, parser_version = ?, external_ref = ?, status = ?, auto_note = ? WHERE id = ?",
    parsed.source, parsed.kind, JSON.stringify({ ...parsed.data, confidence: parsed.confidence }), PARSER_VERSION, parsed.external_ref, status, own, item.id);
  b.audit("inbox.reparse", "inbox_item", item.id, { source: item.source, kind: item.kind, parser_version: item.parser_version }, { source: parsed.source, kind: parsed.kind, parser_version: PARSER_VERSION, by: actorId ?? "cron" });
  await b.run();
  return applyAutomation(env, propertyId, item.id, status, parsed, subject);
}

/** Manual ingest (paste an email) — the same code path the Email Worker uses, handy before DNS is set up. */
r.post("/ingest", async (c) => {
  const p = c.get("property");
  const x = await body(c);
  const res = await ingestEmail(c.env, p.id, { message_id: optStr(x.message_id, "message_id"), from: str(x.from, "from"), subject: str(x.subject, "subject"), html: optStr(x.html, "html") ?? undefined, text: optStr(x.text, "text") ?? undefined, raw: null });
  return c.json(res, 201);
});

r.post("/:id/reparse", async (c) => c.json(await reparseItem(c.env, c.get("property").id, c.req.param("id"), c.get("actor").id)));

/** Edit the parsed fields before approving (the mock's "Edit"). */
r.patch("/:id", async (c) => {
  const p = c.get("property"); const item: any = await one(c.env.DB, "SELECT * FROM inbox_items WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!item) throw new HttpError(404, "inbox item not found");
  if (item.status !== "pending") throw new HttpError(409, `item is ${item.status}`);
  const x = await body(c);
  const before = JSON.parse(item.parsed_json ?? "{}");
  const after = { ...before, ...x.parsed as object };
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("UPDATE inbox_items SET parsed_json = ?, external_ref = COALESCE(?, external_ref) WHERE id = ?", JSON.stringify(after), optStr(x.external_ref, "external_ref"), item.id);
  b.audit("inbox.edit", "inbox_item", item.id, before, after);
  await b.run();
  return c.json({ ok: true });
});

/** Approve: a reservation becomes a booking (through the shared path); a cancellation cancels its booking. */
r.post("/:id/approve", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const item: any = await one(c.env.DB, "SELECT * FROM inbox_items WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!item) throw new HttpError(404, "inbox item not found");
  if (item.status !== "pending") throw new HttpError(409, `item is ${item.status}`);
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const d = { ...JSON.parse(item.parsed_json ?? "{}"), ...((x.parsed as object) ?? {}) };
  if (item.kind === "new_reservation") {
    const channelCode = str(x.channel_code ?? (item.source === "swiftbook" ? "swiftbook" : item.source === "bookingengine" ? "direct" : d.channel ? String(d.channel).toLowerCase().replace(/[^a-z]+/g, "_") : ""), "channel_code");
    const roomIds: string[] = Array.isArray(x.room_ids) ? x.room_ids.map(String) : [];
    if (!roomIds.length) throw new HttpError(400, "pick the room(s) this reservation occupies");
    const checkIn = date(d.check_in, "check_in"), checkOut = date(d.check_out, "check_out");
    // Rate per room-night ex-GST. OTA totals usually arrive ex-GST; SwiftBook arrives inclusive, so split it.
    const nights = Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000));
    let nightly: number;
    if (x.nightly_rate_paise !== undefined) nightly = int(x.nightly_rate_paise, "nightly_rate_paise", { min: 0 });
    else if (d.nightly_rate_paise) nightly = Number(d.nightly_rate_paise);
    else if (d.room_total_paise) nightly = Math.round(Number(d.room_total_paise) / (nights * roomIds.length));
    else if (d.total_incl_gst_paise) {
      const perNight = Math.round(Number(d.total_incl_gst_paise) / (nights * roomIds.length));
      const slab = slabBpForRoomNight(gstPolicy(p), perNight);
      nightly = splitInclusive(perNight, slab).ex;
    } else throw new HttpError(400, "nightly_rate_paise required: the email carried no amount");
    const result = await createBooking(c.env.DB, actor, p, {
      guest: { name: str(d.guest_name, "guest_name"), phone: d.guest_phone ?? null, email: d.guest_email ?? null },
      channelCode, externalRef: item.external_ref, checkIn, checkOut, rooms: roomIds.map((roomId) => ({ roomId, nightlyRatePaise: nightly })),
      inboxItemId: item.id, isOta: channelCode !== "direct", notes: `from ${item.source} email ${item.subject}`,
    });
    const b = new Batch(c.env.DB, actor);
    b.add("UPDATE inbox_items SET status = 'approved', booking_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", result.id, actor.id, nowIso(), item.id);
    b.audit("inbox.approve", "inbox_item", item.id, { status: "pending" }, { status: "approved", booking_id: result.id });
    await b.run();
    return c.json({ booking: result });
  }
  if (item.kind === "cancellation") {
    if (!item.external_ref) throw new HttpError(400, "cancellation email has no reference; dismiss and cancel the booking manually");
    const bk: any = await one(c.env.DB, `SELECT id FROM bookings WHERE property_id = ? AND ${REF_MATCH} AND status NOT IN ('cancelled','no_show','checked_out')`, p.id, ...refArgs(item.external_ref));
    if (!bk) throw new HttpError(404, `no open booking with reference ${item.external_ref}`);
    const { cancelBooking } = await import("../services/bookings");
    const res = await cancelBooking(c.env.DB, actor, p, bk.id, "cancelled", `OTA cancellation (${item.source})`);
    const b = new Batch(c.env.DB, actor);
    b.add("UPDATE inbox_items SET status = 'approved', booking_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", bk.id, actor.id, nowIso(), item.id);
    b.audit("inbox.approve", "inbox_item", item.id, { status: "pending" }, { status: "approved", cancelled: bk.id });
    await b.run();
    return c.json({ cancelled: bk.id, ...res });
  }
  throw new HttpError(400, `cannot auto-apply a ${item.kind}; edit the booking directly and dismiss this item`);
});

r.post("/:id/dismiss", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const item: any = await one(c.env.DB, "SELECT * FROM inbox_items WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!item) throw new HttpError(404, "inbox item not found");
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE inbox_items SET status = 'dismissed', reviewed_by = ?, reviewed_at = ? WHERE id = ?", actor.id, nowIso(), item.id);
  b.audit("inbox.dismiss", "inbox_item", item.id, { status: item.status }, { status: "dismissed", reason: optStr(x.reason, "reason") });
  await b.run();
  return c.json({ ok: true });
});

export default r;
export type { ParsedEmail };
