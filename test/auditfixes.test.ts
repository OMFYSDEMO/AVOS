import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { seed, api, ok, sql } from "./helpers";
import { todayIn, addDays } from "../src/domain/dates";
import { gatewayFee } from "../src/services/payments";

/** Fixes from the 25 Oct audit: nothing owed, owed back, mis-taxed or cancelled after the stay may fall between desks. */
describe("Audit fixes", () => {
  beforeAll(seed);
  const today = todayIn("Asia/Kolkata");
  const work = async (u: "sindhu" | "trupti" | "shaji") => JSON.stringify(await ok(u, "GET", "/api/work"));
  const book = (name: string, phone: string, ci: string, co: string, room: string, rate = 600000, extra: Record<string, unknown> = {}) =>
    ok("shaji", "POST", "/api/bookings", { guest_name: name, guest_phone: phone, channel_code: "direct", check_in: ci, check_out: co, rooms: [{ room_id: room, nightly_rate_paise: rate }], ...extra });

  it("a stay that ended without a check-in can be checked in and out at the desk with the real times", async () => {
    const ci = addDays(today, -3), co = addDays(today, -1);
    const b = await book("Ended Guest", "9500000401", ci, co, "loc_r1");
    const desk = await ok("sindhu", "GET", "/api/bookings/frontdesk/today");
    expect(desk.late_arrivals.map((x: any) => x.id)).toContain(b.booking.id);
    await ok("sindhu", "POST", `/api/bookings/${b.booking.id}/check-in`, { arrived_at: `${ci}T15:00:00+05:30` });
    expect((await api("sindhu", "POST", `/api/bookings/${b.booking.id}/check-out`, { departed_at: `${ci}T10:00:00+05:30` })).status).toBe(400); // before arrival
    expect((await api("sindhu", "POST", `/api/bookings/${b.booking.id}/check-out`, { departed_at: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(400); // future
    const out = await ok("sindhu", "POST", `/api/bookings/${b.booking.id}/check-out`, { departed_at: `${co}T11:00:00+05:30` });
    expect(out.housekeeping_tasks).toHaveLength(0); // the room was cleaned days ago
    const [row] = await sql("SELECT status, checked_out_at FROM bookings WHERE id = ?", b.booking.id);
    expect(row.status).toBe("checked_out"); expect(row.checked_out_at).toBe(new Date(`${co}T11:00:00+05:30`).toISOString());

    // Left owing: stays on the desk's collect list and My work until collected.
    const due = await ok("sindhu", "GET", "/api/payments/due");
    expect(due.due.find((d: any) => d.booking_id === b.booking.id)?.overdue).toBe(true);
    expect(await work("sindhu")).toContain(`unpaid:${b.booking.id}`);
    await ok("sindhu", "POST", "/api/payments", { booking_id: b.booking.id, method: "cash", amount_paise: out.balance_due_paise });
    expect(await work("sindhu")).not.toContain(`unpaid:${b.booking.id}`);
  });

  it("an approved refund stays on the owner's My work until it is paid", async () => {
    const b = await book("Refund Guest", "9500000402", "2027-10-01", "2027-10-02", "loc_r2");
    await ok("sindhu", "POST", "/api/payments", { booking_id: b.booking.id, method: "cash", amount_paise: 100000 });
    await ok("shaji", "POST", `/api/bookings/${b.booking.id}/cancel`, { reason: "guest cancelled" });
    const [apr] = await sql("SELECT id FROM approvals WHERE ref_id = ? AND kind = 'refund'", b.booking.id);
    await ok("trupti", "POST", `/api/approvals/${apr.id}/approve`, {});
    expect(await work("shaji")).toContain(`refund:${apr.id}`);
    await ok("shaji", "POST", `/api/approvals/refunds/${apr.id}/pay`, { method: "bank", reference: "RF-AUDIT" });
    expect(await work("shaji")).not.toContain(`refund:${apr.id}`);
  });

  it("GST follows the price charged; a live booking taxed on the old basis is flagged for the revenue desk and at pre-close", async () => {
    await ok("shaji", "PATCH", "/api/admin/property", { gstin: "32AAACX1234A1Z5" });
    const b = await book("Peak Price", "9500000403", "2027-11-10", "2027-11-11", "loc_r4", 800000);
    expect(b.booking.lines[0].gstRateBp).toBe(1800);
    await sql("UPDATE booking_rooms SET gst_rate_bp = 500, gst_paise = 40000 WHERE booking_id = ?", b.booking.id);
    expect(await work("trupti")).toContain(`gstslab:${b.booking.id}`);
    const pre = await ok("trupti", "GET", "/api/reports/preclose?period=2027-11");
    expect(pre.stays_on_wrong_gst_slab.map((x: any) => x.id)).toContain(b.booking.id);
  });

  it("a booking-engine modification points to the booking to amend, never to a new booking", async () => {
    const b = await book("Mod Guest", "9500000404", "2027-12-01", "2027-12-03", "loc_r3", 550000, { external_ref: "1060900000888001" });
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@mybookingsite.io", subject: "(Modified) Mod Guest Reservation No:1060900000888001-The Meadows Varkala", text: "Booking ID 1060900000888001 Modified. Guest Mod Guest. Check-in 01 Dec 2027 Check-out 04 Dec 2027." });
    expect(ing.status).toBe("pending");
    const box = await ok("prachi", "GET", "/api/inbox?status=pending");
    const card = box.items.find((i: any) => i.id === ing.id);
    expect(card.kind).toBe("modification");
    expect(card.booking_match?.id).toBe(b.booking.id);
  });

  it("an OTA cancellation after the stay was checked out says so and goes to the revenue desk", async () => {
    const ci = addDays(today, -2), co = addDays(today, -1);
    const b = await ok("shaji", "POST", "/api/bookings", { guest_name: "After Stay", guest_phone: "9500000405", channel_code: "agoda", external_ref: "7770001 (1060900000777001)", check_in: ci, check_out: co, rooms: [{ room_id: "loc_r2", nightly_rate_paise: 600000 }] });
    await ok("sindhu", "POST", `/api/bookings/${b.booking.id}/check-in`, { arrived_at: `${ci}T15:00:00+05:30` });
    await ok("sindhu", "POST", `/api/bookings/${b.booking.id}/check-out`, { departed_at: `${co}T10:00:00+05:30` });
    const canc = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "Cancelled Reservation Agoda for After Reservation No:7770001 (1060900000777001) - The Meadows Varkala", text: "Channel Name: Agoda\nBookings Status: Cancelled\nBooking Id#: 1060900000777001 (7770001)\nGUEST NAME\nAfter Stay" });
    expect(canc.auto.note).toMatch(/cancelled after the stay was checked out/);
    expect(await work("trupti")).toContain(`inbox:${canc.id}`);
    expect(JSON.stringify(await ok("prachi", "GET", "/api/work"))).not.toContain(`inbox:${canc.id}`);
  });

  it("money left in Airpay clearing after settlement is flagged for the revenue desk", async () => {
    await ok("sindhu", "POST", "/api/payments", { method: "airpay", amount_paise: 1000000, received_on: addDays(today, -10), reference: "AP-RESIDUE" });
    // Estimated fee 2.75% + GST = 324.50, so 9,675.50 is the expected settlement; Airpay paid ₹100 less.
    await ok("shaji", "POST", "/api/payments/transfers", { from_account_id: "acc_gw", to_account_id: "acc_bank", amount_paise: 957550, reference: "AIRPAY SETTLE" });
    expect(await work("trupti")).toMatch(/Airpay clearing holds ₹100/);
  });

  it("the Airpay fee estimate is 2.75% plus GST on the charge, as Airpay settles it", async () => {
    // ₹23,100 paid, ₹22,350.40 settled: Airpay kept 635.25 + 114.35 GST = 749.60.
    expect(gatewayFee("airpay", 2310000)).toMatchObject({ charge: 63525, gst: 11435, total: 74960, gstBp: 1800 });
    const pay = await ok("sindhu", "POST", "/api/payments", { method: "airpay", amount_paise: 2310000, reference: "AP-RATE" });
    const fee: any = await env.DB.prepare("SELECT amount_paise, gst_rate_bp, gst_paise FROM expenses WHERE id = ?").bind(pay.fee_expense_id).first();
    expect(fee).toEqual({ amount_paise: 74960, gst_rate_bp: 1800, gst_paise: 11435 });
    // Card's rate already includes GST: nothing added on top.
    expect(gatewayFee("card", 1000000)).toMatchObject({ total: 17700, gst: 0 });
  });
});

describe("Invoices for OTA-collected stays", () => {
  beforeAll(seed);
  it("show the stay paid through the OTA, with nothing due from the guest", async () => {
    const ci = addDays(todayIn("Asia/Kolkata"), -2), co = addDays(todayIn("Asia/Kolkata"), -1);
    const b = await ok("shaji", "POST", "/api/bookings", { guest_name: "OTA Invoice", guest_phone: "9500000501", channel_code: "agoda", check_in: ci, check_out: co, rooms: [{ room_id: "loc_r3", nightly_rate_paise: 525938 }] });
    await ok("sindhu", "POST", `/api/bookings/${b.booking.id}/check-in`, { arrived_at: `${ci}T14:00:00+05:30` });
    await ok("sindhu", "POST", `/api/bookings/${b.booking.id}/check-out`, { departed_at: `${co}T11:00:00+05:30` });
    const inv = await ok("sindhu", "POST", `/api/invoices/bookings/${b.booking.id}`);
    expect(inv.balance_paise).toBe(0); expect(inv.received_paise).toBe(inv.total_paise);
    const html = await api("sindhu", "GET", `/api/invoices/${inv.id}/html`);
    expect(String(html.json.raw ?? html.json)).toContain("Paid through Agoda");
  });
});

describe("Form C marked by mistake", () => {
  beforeAll(seed);
  it("switching a stay back to Indian withdraws the unread Form C notifications and the overdue escalation", async () => {
    const ci = addDays(todayIn("Asia/Kolkata"), -2);
    const b = await ok("shaji", "POST", "/api/bookings", { guest_name: "Indian Guest", guest_phone: "9500000601", channel_code: "direct", check_in: ci, check_out: addDays(todayIn("Asia/Kolkata"), 1), rooms: [{ room_id: "loc_r4", nightly_rate_paise: 700000 }] });
    await ok("sindhu", "POST", `/api/bookings/${b.booking.id}/check-in`, { arrived_at: `${ci}T14:00:00+05:30` });
    await ok("sindhu", "POST", `/api/ids/bookings/${b.booking.id}/nationality`, { nationality: "foreign" });
    await ok("trupti", "GET", "/api/work"); // the work queue raises the overdue item (arrival was 2 days ago)
    const before = await sql("SELECT kind FROM notifications WHERE ref_id IN (?, ?)", b.booking.id, `formc:${b.booking.id}`);
    expect(before.map((n: any) => n.kind)).toContain("form_c_due");
    await ok("sindhu", "POST", `/api/ids/bookings/${b.booking.id}/nationality`, { nationality: "indian" });
    expect(await sql("SELECT kind FROM notifications WHERE kind = 'form_c_due' AND ref_id = ?", b.booking.id)).toHaveLength(0);
    expect(await sql("SELECT kind FROM notifications WHERE ref_kind = 'work' AND ref_id = ?", `formc:${b.booking.id}`)).toHaveLength(0);
    expect(JSON.stringify(await ok("prachi", "GET", "/api/work"))).not.toContain(`formc:${b.booking.id}`);
  });
});
