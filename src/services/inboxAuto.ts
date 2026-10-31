import type { Actor } from "../auth";
import { Batch, HttpError, all, one, id, type PropertyRow } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { slabBpForRoomNight } from "../domain/gst";
import { isWholeVilla } from "../email/parsers";
import { splitInclusive } from "../domain/money";
import type { ParsedEmail } from "../email/parsers";
import { createBooking, cancelBooking, conflicts, gstPolicy } from "./bookings";
import { notifyRole } from "./notify";
import { recordPayment } from "./payments";
import { hashLine, proposeMatch } from "../domain/recon";
import { candidatesFor } from "../routes/recon";
import { addDays } from "../domain/dates";

/**
 * Inbox automation (W1). A parsed email is applied to the books the moment it arrives when every fact lines up;
 * otherwise it stays a review card carrying the reason. The rules are deliberately narrow: automation only does
 * what a person would do without thinking, and everything it does is audited as "inbox-automation".
 *
 *  - new reservation  → channel recognised, a free room of the named type for every night, an amount → booking
 *  - cancellation     → one open booking with that reference → cancelled (a refund approval is raised if money was taken)
 *  - Airpay payment   → successful, and the order id starts with a SwiftBook itinerary we hold → payment + fee
 *  - modification     → always a person: the email rarely says what changed
 */
/** A booking reference matches as stored, or as the "STAAH id (OTA ref)" pair the migrated stays carry. */
/** Note on a cancellation that arrives for a stay already checked out; such cards belong to the revenue desk. */
export const AFTER_STAY = "OTA cancelled after the stay was checked out";
export const REF_MATCH = "(external_ref = ? OR external_ref LIKE ? OR external_ref LIKE ?)";
export const refArgs = (ref: string) => [ref, `${ref} (%`, `% (${ref})`];

export type AutoResult = { applied: true; what: "booked" | "cancelled" | "paid" | "settled" | "statement line"; id: string } | { applied: false; note: string };

/** Automation acts for the owner (FKs need a real user) but signs the audit as itself. */
async function automationActor(db: D1Database, propertyId: string): Promise<Actor | null> {
  const u = await one<{ id: string; name: string }>(db, "SELECT id, name FROM users WHERE property_id = ? AND active = 1 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'sales' THEN 1 ELSE 2 END, id LIMIT 1", propertyId);
  return u ? { id: u.id, property_id: propertyId, email: "inbox-automation", name: "Inbox automation", role: "owner", via: "automation" } : null;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Other names OTAs go by in STAAH emails. */
const CHANNEL_ALIASES: Record<string, string> = { travelguru: "yatra", "yatra com": "yatra", mmt: "makemytrip", "make my trip": "makemytrip", goibibo: "goibibo", "booking com": "booking com", bdc: "booking com" };

/** Match the email's channel name to a configured channel; hotel-collect emails prefer the "(pay at property)" twin. */
async function resolveChannel(db: D1Database, propertyId: string, parsed: ParsedEmail): Promise<{ code: string } | null> {
  if (parsed.source === "swiftbook") return await one<{ code: string }>(db, "SELECT code FROM channels WHERE property_id = ? AND code = 'swiftbook' AND active = 1", propertyId);
  if (parsed.source === "bookingengine") return await one<{ code: string }>(db, "SELECT code FROM channels WHERE property_id = ? AND code = 'direct' AND active = 1", propertyId);
  // STAAH names some channels by their connection ("travelguruxml", "Booking.com XML"): drop the plumbing, then
  // match the channel's code, its name, or any part of a name like "Yatra / Travelguru".
  const raw = norm(parsed.data.channel).replace(/\s*(xml|api|b2c|b2b|connect)$/g, "").replace(/(xml|api)$/, "").trim();
  const want = CHANNEL_ALIASES[raw] ?? raw;
  if (!want) return null;
  const rows = await all<{ code: string; name: string; collection_type: string }>(db, "SELECT code, name, collection_type FROM channels WHERE property_id = ? AND active = 1", propertyId);
  const matches = (r: { code: string; name: string }) => {
    const c = norm(r.code), parts = [norm(r.name), ...String(r.name).split(/[\/(),]+/).map(norm)].filter(Boolean);
    return c === want || c.replace(/ /g, "") === want.replace(/ /g, "") || parts.some((n) => n === want || n.startsWith(want) || want.startsWith(n));
  };
  const base = rows.filter((r) => !/hotel_collect$/.test(r.code)).filter(matches);
  if (base.length !== 1) return null;
  if (parsed.data.collection_type === "hotel_collect") {
    const twin = rows.find((r) => r.code === `${base[0].code}_hotel_collect`);
    if (twin) return twin;
  }
  return base[0];
}

/** Free rooms of the named type for every night of the stay, in sort order. */
async function freeRoomsOfType(db: D1Database, propertyId: string, roomName: unknown, checkIn: string, checkOut: string): Promise<{ ids: string[]; typeKnown: boolean }> {
  const want = norm(roomName);
  const rooms = await all<{ id: string; name: string; code: string }>(db, "SELECT id, name, code FROM locations WHERE property_id = ? AND kind = 'room' AND active = 1 ORDER BY sort, code", propertyId);
  const ofType = isWholeVilla(roomName) ? rooms : want ? rooms.filter((r) => { const n = norm(r.name); return n === want || want.startsWith(n) || n.startsWith(want); }) : [];
  if (!ofType.length) return { ids: [], typeKnown: false };
  const taken = new Set((await conflicts(db, propertyId, ofType.map((r) => r.id), checkIn, checkOut)).map((c) => c.room_id));
  return { ids: ofType.filter((r) => !taken.has(r.id)).map((r) => r.id), typeKnown: true };
}

export async function autoApply(db: D1Database, property: PropertyRow, item: { id: string; kind: string; source: string; external_ref: string | null; subject: string }, parsed: ParsedEmail): Promise<AutoResult> {
  const actor = await automationActor(db, property.id);
  if (!actor) return { applied: false, note: "no active user to act for" };
  const d = parsed.data as Record<string, any>;
  try {
    if (item.kind === "new_reservation") {
      if (parsed.confidence !== "high") return { applied: false, note: "parser not confident: check the fields" };
      const checkIn = String(d.check_in), checkOut = String(d.check_out);
      if (!(checkIn < checkOut)) return { applied: false, note: "dates do not make a stay" };
      if (checkOut < todayIn(property.timezone)) return { applied: false, note: "stay is in the past" };
      const channel = await resolveChannel(db, property.id, parsed);
      if (!channel) return { applied: false, note: `channel "${d.channel ?? "?"}" is not set up: pick it by hand or add it under Settings` };
      const villa = isWholeVilla(d.room_name);
      const roomCount = (await all<{ n: number }>(db, "SELECT COUNT(*) AS n FROM locations WHERE property_id = ? AND kind = 'room' AND active = 1", property.id))[0]?.n ?? 0;
      // One entry per room type the email lists (STAAH repeats a block per type); a single type is the old shape.
      const types: { name: unknown; count: number; amount_paise: number | null }[] = Array.isArray(d.room_types) && d.room_types.length > 1
        ? d.room_types.map((t: any) => ({ name: t.name, count: Math.max(1, Number(t.count ?? 1)), amount_paise: t.amount_paise ?? null }))
        : [{ name: d.room_name, count: villa ? roomCount : Math.max(1, Number(d.rooms ?? 1)), amount_paise: null }];
      const picked: { roomId: string; share: number | null }[] = [];
      for (const t of types) {
        const free = await freeRoomsOfType(db, property.id, t.name, checkIn, checkOut);
        if (!free.typeKnown) return { applied: false, note: `room type "${t.name ?? "?"}" does not match a room: pick the room(s) by hand` };
        const open = free.ids.filter((id) => !picked.some((p) => p.roomId === id));
        if (open.length < t.count) return { applied: false, note: villa && types.length === 1 ? `whole villa booked but only ${open.length} of ${t.count} rooms are free for those dates: pick by hand or move the other stay` : `only ${open.length} of ${t.count} ${t.name} room(s) free for those dates: possible overbooking, pick by hand` };
        for (const roomId of open.slice(0, t.count)) picked.push({ roomId, share: t.amount_paise === null ? null : t.amount_paise / t.count });
      }
      const roomIds = picked.map((p) => p.roomId);
      const nights = Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000));
      let nightly: number;
      if (d.nightly_rate_paise) nightly = Number(d.nightly_rate_paise);
      else if (d.room_total_paise) nightly = Math.round(Number(d.room_total_paise) / (nights * roomIds.length));
      else if (d.total_incl_gst_paise) { const perNight = Math.round(Number(d.total_incl_gst_paise) / (nights * roomIds.length)); nightly = splitInclusive(perNight, slabBpForRoomNight(gstPolicy(property), perNight)).ex; }
      else return { applied: false, note: "the email carried no amount" };
      // Each room's own price when the email gives one per room type: its share of Room Total, so the booking adds up
      // to the email whether the nightly amounts were printed with GST or without.
      const shares = picked.every((p) => p.share !== null) && picked.length > 1 && d.room_total_paise ? picked.map((p) => p.share as number) : null;
      const sumShares = shares ? shares.reduce((a, b) => a + b, 0) : 0;
      const rates = roomIds.map((_, i) => shares && sumShares > 0 ? Math.round((Number(d.room_total_paise) * shares[i]) / sumShares / nights) : nightly);
      const result = await createBooking(db, actor, property, {
        guest: { name: String(d.guest_name), phone: d.guest_phone ?? null, email: d.guest_email ?? null },
        // Both numbers on the booking, "STAAH id (OTA ref)", so the OTA's own email for it later finds it too.
        channelCode: channel.code, externalRef: item.external_ref && d.ota_ref && d.ota_ref !== item.external_ref ? `${item.external_ref} (${d.ota_ref})` : item.external_ref, checkIn, checkOut, rooms: roomIds.map((roomId, i) => ({ roomId, nightlyRatePaise: rates[i] })),
        inboxItemId: item.id, isOta: channel.code !== "direct", adults: d.adults ?? undefined, children: d.children ?? undefined, notes: `auto-booked from ${item.source} email: ${item.subject}`,
      });
      const b = new Batch(db, actor);
      b.add("UPDATE inbox_items SET status = 'approved', booking_id = ?, auto_applied = 1, auto_note = NULL, reviewed_at = ? WHERE id = ?", result.id, nowIso(), item.id);
      b.audit("inbox.auto_book", "inbox_item", item.id, { status: "pending" }, { status: "approved", booking_id: result.id, rooms: roomIds, channel: channel.code });
      await notifyRole(b, property.id, "sales", "inbox_auto_booked", `${d.guest_name} · ${checkIn} → ${checkOut} booked from ${item.source} (${channel.code})`, { kind: "booking", id: result.id });
      await notifyRole(b, property.id, "property", "inbox_auto_booked", `${d.guest_name} arrives ${checkIn} (${channel.code}, from email)`, { kind: "booking", id: result.id });
      await b.run();
      return { applied: true, what: "booked", id: result.id };
    }
    if (item.kind === "cancellation") {
      if (!item.external_ref) return { applied: false, note: "no booking reference in the email" };
      const open = await all<{ id: string; status: string; guest_id: string }>(db, `SELECT id, status, guest_id FROM bookings WHERE property_id = ? AND ${REF_MATCH} AND status NOT IN ('cancelled','no_show','checked_out')`, property.id, ...refArgs(item.external_ref));
      if (!open.length) {
        // Cancelled after the stay was completed: the revenue desk must check with the OTA before the payout is counted on.
        const done = await one<{ name: string; check_in: string; check_out: string }>(db, `SELECT g.name, b.check_in, b.check_out FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND ${REF_MATCH} AND b.status = 'checked_out' ORDER BY b.created_at DESC LIMIT 1`, property.id, ...refArgs(String(item.external_ref)));
        if (done) return { applied: false, note: `${AFTER_STAY} (${done.name}, ${done.check_in} → ${done.check_out}): check with the OTA whether the stay will be paid, then dismiss` };
      }
      if (open.length !== 1) return { applied: false, note: open.length ? "more than one open booking carries that reference" : `no open booking with reference ${item.external_ref}` };
      if (open[0].status === "checked_in") return { applied: false, note: "guest is checked in: a person decides" };
      const res = await cancelBooking(db, actor, property, open[0].id, "cancelled", `${item.source} cancellation email`);
      const b = new Batch(db, actor);
      b.add("UPDATE inbox_items SET status = 'approved', booking_id = ?, auto_applied = 1, auto_note = NULL, reviewed_at = ? WHERE id = ?", open[0].id, nowIso(), item.id);
      b.audit("inbox.auto_cancel", "inbox_item", item.id, { status: "pending" }, { status: "approved", cancelled: open[0].id, refund_approval: res.refundApprovalId });
      await notifyRole(b, property.id, "sales", "inbox_auto_cancelled", `Booking ${item.external_ref} cancelled by ${item.source} email${res.paidPaise > 0 ? " · refund awaits approval" : ""}`, { kind: "booking", id: open[0].id });
      await notifyRole(b, property.id, "property", "inbox_auto_cancelled", `Booking ${item.external_ref} cancelled (from email): rooms released`, { kind: "booking", id: open[0].id });
      await b.run();
      return { applied: true, what: "cancelled", id: open[0].id };
    }
    if (item.kind === "payment") {
      if (parsed.confidence !== "high" || !d.success) return { applied: false, note: "not a confirmed successful transaction" };
      // Already recorded under either number: the desk often types the Airpay Id rather than the order id. A STAAH Max
      // payment and Airpay's receipt for it share the order id, so whichever arrives second is a duplicate.
      const dup = await one<{ id: string }>(db, "SELECT id FROM payments WHERE property_id = ? AND method = 'airpay' AND reference IN (?, ?) AND status != 'void'", property.id, String(d.order_id), String(d.airpay_id ?? d.order_id));
      if (dup) {
        const b = new Batch(db, actor);
        b.add("UPDATE inbox_items SET status = 'duplicate', payment_id = ?, auto_note = 'already recorded' WHERE id = ?", dup.id, item.id);
        b.audit("inbox.duplicate", "inbox_item", item.id, null, { payment_id: dup.id });
        await b.run();
        return { applied: false, note: "already recorded" };
      }
      // Airpay order ids begin with the SwiftBook itinerary number: that is the stay the money is for.
      let bk = await all<{ id: string; guest_name: string }>(db, "SELECT b.id, g.name AS guest_name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.external_ref IS NOT NULL AND ? LIKE b.external_ref || '%' AND b.status NOT IN ('cancelled','no_show') ORDER BY b.created_at DESC", property.id, String(d.order_id));
      // A STAAH Max payment also names the booking reference itself: the booking may carry that rather than the order id.
      if (!bk.length && d.booking_ref) bk = await all<{ id: string; guest_name: string }>(db, "SELECT b.id, g.name AS guest_name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.external_ref IS NOT NULL AND (b.external_ref = ? OR b.external_ref LIKE ? || '%') AND b.status NOT IN ('cancelled','no_show')", property.id, String(d.booking_ref), String(d.booking_ref));
      if (bk.length !== 1) return { applied: false, note: bk.length ? "order matches more than one stay" : "no stay matches the order id: confirm or dismiss on the Payments screen" };
      // Dated the day the guest paid: the receipt's own send time (a forward carries it), else when the email arrived.
      const arrived = await one<{ received_at: string }>(db, "SELECT received_at FROM inbox_items WHERE id = ?", item.id);
      const paidAt = Date.parse(String(d.sent_at ?? arrived?.received_at ?? ""));
      const today = todayIn(property.timezone);
      const paidOn = Number.isFinite(paidAt) ? todayIn(property.timezone, new Date(paidAt)) : today;
      const receivedOn = paidOn <= today && paidOn >= addDays(today, -60) ? paidOn : today;
      const pay = await recordPayment(db, actor, property, { booking_id: bk[0].id, method: "airpay", amount_paise: Number(d.amount_paise), reference: String(d.order_id), received_on: receivedOn, inbox_item_id: item.id, idempotency_key: `airpay:${d.order_id}` });
      const b = new Batch(db, actor);
      b.add("UPDATE inbox_items SET auto_applied = 1, auto_note = NULL WHERE id = ?", item.id);
      b.audit("inbox.auto_pay", "inbox_item", item.id, { status: "routed" }, { status: "approved", payment_id: pay.id, booking_id: bk[0].id });
      await notifyRole(b, property.id, "property", "inbox_auto_paid", `${d.via ?? "Airpay"} ${Number(d.amount_paise) / 100} received for ${bk[0].guest_name} (order ${d.order_id})`, { kind: "payment", id: pay.id });
      await b.run();
      return { applied: true, what: "paid", id: pay.id };
    }
    if (item.kind === "channel_alert") {
      // Say whether the booking it is about reached AVOS, and what to fix in STAAH.
      const ref = String(d.ota_ref ?? "");
      const bk = ref ? await one<{ guest_name: string; check_in: string }>(db, `SELECT g.name AS guest_name, b.check_in FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND ${REF_MATCH}`, property.id, ...refArgs(ref)) : null;
      const card = ref && !bk ? await one<{ id: string }>(db, "SELECT id FROM inbox_items WHERE property_id = ? AND kind = 'new_reservation' AND parsed_json LIKE ? AND status = 'pending'", property.id, `%"ota_ref":"${ref}"%`) : null;
      const where = bk ? `the booking (${bk.guest_name}, ${bk.check_in}) is in AVOS` : card ? "the booking is waiting in the inbox: book it" : "no booking for it has reached AVOS yet: check the OTA extranet";
      return { applied: false, note: `STAAH could not map the OTA's rate plan for reservation ${ref || "?"}: ${where}. Map the rate plan in STAAH so availability stays in sync on every channel, then dismiss.` };
    }
    if (item.kind === "bank_alert") {
      if (parsed.confidence !== "high") return { applied: false, note: "could not read the amount or date on the bank alert" };
      const banks = await all<any>(db, "SELECT id, name, account_no, is_default FROM money_accounts WHERE property_id = ? AND kind = 'bank' AND active = 1", property.id);
      const last = String(d.account_last ?? "");
      const acct = banks.find((b) => b.account_no && last && (last.endsWith(String(b.account_no)) || String(b.account_no).endsWith(last))) ?? (banks.length === 1 ? banks[0] : null);
      if (!acct) return { applied: false, note: `which bank is A/C ...${last || "?"}? Put the account's last digits on it under Settings & users → Bank & cash accounts` };
      const signed = d.direction === "debited" ? -Number(d.amount_paise) : Number(d.amount_paise);
      // A plain credit alert has no method, payer or reference; the direction and time keep the line readable
      // and keep two same-amount credits on one day from being taken for the same line.
      const description = [d.method, d.counterparty, d.reference].filter(Boolean).join(" ") || `${d.direction === "debited" ? "Debit" : "Credit"} alert ${d.at_time ?? ""}`.trim();
      const lineHash = hashLine(String(d.on_date), description, signed);
      const dupLine = await one<{ id: string }>(db, "SELECT id FROM bank_statement_lines WHERE property_id = ? AND account_id = ? AND line_hash = ?", property.id, acct.id, lineHash);
      const now = nowIso();
      const b = new Batch(db, actor);
      // Keep the bank's latest word: an older alert forwarded by hand later must not replace a newer balance.
      // reported_at is an IST timestamp; comparing the instants (not the strings) copes with "13:36" vs "14:32:14".
      if (d.balance_paise != null) {
        const at = `${d.on_date}T${d.at_time ?? "00:00:00"}+05:30`;
        const cur = await one<{ reported_at: string | null }>(db, "SELECT reported_at FROM money_accounts WHERE id = ?", acct.id);
        if (!cur?.reported_at || !(Date.parse(cur.reported_at) > Date.parse(at))) b.add("UPDATE money_accounts SET reported_balance_paise = ?, reported_at = ? WHERE id = ?", Number(d.balance_paise), at, acct.id);
      }
      if (dupLine) {
        b.add("UPDATE inbox_items SET status = 'duplicate', auto_note = 'already on the statement' WHERE id = ?", item.id);
        await b.run();
        return { applied: false, note: "already recorded" };
      }
      const lid = id("bsl");
      const isAirpay = signed > 0 && /airpay/i.test(String(d.counterparty ?? ""));
      if (isAirpay) {
        // Airpay settles the gateway float to the bank: a transfer from Airpay clearing, matched to this line at once.
        const gw = await one<{ id: string }>(db, "SELECT id FROM money_accounts WHERE property_id = ? AND kind = 'gateway' AND active = 1 ORDER BY id LIMIT 1", property.id);
        if (!gw) return { applied: false, note: "no gateway clearing account to settle from" };
        const tid = id("trf");
        b.add("INSERT INTO transfers (id, property_id, from_account_id, to_account_id, amount_paise, on_date, reference, note, recorded_by, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
          tid, property.id, gw.id, acct.id, signed, d.on_date, d.reference ?? null, `Airpay settlement · from the ${d.bank ?? "bank"} alert`, actor.id, `bankalert:${item.id}`);
        b.audit("transfer.create", "transfer", tid, null, { from: "gateway", to: acct.name, amount_paise: signed, reference: d.reference, via: "bank alert" });
        b.add("INSERT INTO bank_statement_lines (id, property_id, account_id, run_id, on_date, description, amount_paise, reference, line_hash, status, tier, match_kind, match_id, match_json, matched_by, matched_at) VALUES (?,?,?,?,?,?,?,?,?,'matched',1,'transfer',?,?,?,?)",
          lid, property.id, acct.id, `alert:${item.id}`, d.on_date, description, signed, d.reference ?? null, lineHash, tid, JSON.stringify({ label: "Airpay settlement", via: "bank alert" }), actor.id, now);
        b.add("UPDATE inbox_items SET status = 'approved', auto_applied = 1, auto_note = NULL, external_ref = ? WHERE id = ?", d.reference ?? null, item.id);
        b.audit("inbox.auto_bank", "inbox_item", item.id, { status: "routed" }, { status: "approved", transfer_id: tid, line_id: lid, amount_paise: signed });
        await notifyRole(b, property.id, "revenue", "bank_alert", `Airpay settled ${(signed / 100).toLocaleString("en-IN")} into ${acct.name} (${d.reference ?? "no ref"})`, { kind: "transfer", id: tid });
        await b.run();
        return { applied: true, what: "settled", id: tid };
      }
      // Any other movement becomes a statement line with the usual proposal; a person accepts it on Smart Reconcile.
      const cands = await candidatesFor(db, property.id, acct.id, String(d.on_date).slice(0, 8) + "01", addDays(String(d.on_date), 3));
      const proposal = proposeMatch({ on_date: String(d.on_date), description, amount_paise: signed, reference: d.reference ?? null, line_hash: lineHash }, cands, { feeBp: property.recon_fee_tolerance_bp, subsetBp: property.recon_subset_tolerance_bp });
      b.add("INSERT INTO bank_statement_lines (id, property_id, account_id, run_id, on_date, description, amount_paise, reference, line_hash, status, tier, match_kind, match_id, match_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        lid, property.id, acct.id, `alert:${item.id}`, d.on_date, description, signed, d.reference ?? null, lineHash, proposal ? "proposed" : "unmatched", proposal?.tier ?? null, proposal?.kind ?? null, proposal?.id ?? null, proposal ? JSON.stringify({ label: proposal.label, ...proposal.detail, via: "bank alert" }) : null);
      b.add("UPDATE inbox_items SET status = 'approved', auto_applied = 1, auto_note = ?, external_ref = ? WHERE id = ?", proposal ? `statement line proposed: ${proposal.label}` : "statement line recorded, nothing matched yet", d.reference ?? null, item.id);
      b.audit("inbox.auto_bank", "inbox_item", item.id, { status: "routed" }, { status: "approved", line_id: lid, amount_paise: signed, proposal: proposal?.kind ?? null });
      await b.run();
      return { applied: true, what: "statement line", id: lid };
    }
    if (item.kind === "modification") return { applied: false, note: "modifications are applied by hand: compare with the booking and edit it" };
    return { applied: false, note: "could not tell what this email is" };
  } catch (e: any) {
    // Anything the books refuse (locked month, clash, bad data) leaves the card for a person, with the reason.
    const msg = e instanceof HttpError ? e.message : String(e?.message ?? e);
    return { applied: false, note: msg };
  }
}
