import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { seed, api, ok, sql } from "./helpers";

/** Bank details, balances, OTA terms and gateway fees belong to the revenue desk, the owner and the CA.
 *  The front desk and sales see only what they record themselves. */
describe("Who sees the money", () => {
  beforeAll(async () => {
    await seed();
    await env.DB.prepare("UPDATE money_accounts SET account_no = '3390' WHERE id = 'acc_bank'").run();
  });

  it("the front desk sees no balance at all, not even the cash it holds (blind count)", async () => {
    expect((await api("sindhu", "GET", "/api/payments/accounts")).status).toBe(403);
    expect((await api("prachi", "GET", "/api/payments/accounts")).status).toBe(403);
    const book = await ok("sindhu", "GET", "/api/expenses/petty-statement");
    expect(book.balances_hidden).toBe(true);
    for (const k of ["opening_paise", "closing_paise", "received_paise"]) expect(k in book).toBe(false);
    expect(book.account).toEqual({ id: expect.any(String), name: expect.any(String) });
    const owner = await ok("shaji", "GET", "/api/payments/accounts");
    expect(owner.accounts.find((a: any) => a.kind === "bank")).toBeTruthy();
    const ca = await ok("ca", "GET", "/api/payments/accounts");
    expect(ca.accounts.find((a: any) => a.kind === "bank")).toBeTruthy();
  });

  it("reference data carries no account numbers or OTA terms for the desks", async () => {
    for (const u of ["sindhu", "prachi"] as const) {
      const ref = await ok(u, "GET", "/api/ref");
      expect(ref.accounts.some((a: any) => "account_no" in a)).toBe(false);
      expect(ref.channels.some((c: any) => "commission_bp" in c || "tds_bp" in c)).toBe(false);
    }
    const ref = await ok("trupti", "GET", "/api/ref");
    expect(ref.accounts.find((a: any) => a.id === "acc_bank").account_no).toBe("3390");
    expect(ref.channels.some((c: any) => "commission_bp" in c)).toBe(true);
  });

  it("transfers: the desk sees its own cash movements only; the CA reads them all", async () => {
    await ok("shaji", "POST", "/api/payments/transfers", { from_account_id: "acc_gw", to_account_id: "acc_bank", amount_paise: 100000, reference: "SETTLE-VIS" });
    await ok("sindhu", "POST", "/api/payments/transfers", { from_account_id: "acc_cash", to_account_id: "acc_bank", amount_paise: 5000, reference: "DEPOSIT-VIS" });
    const desk = await ok("sindhu", "GET", "/api/payments/transfers");
    expect(desk.transfers.map((t: any) => t.reference)).toContain("DEPOSIT-VIS");
    expect(desk.transfers.map((t: any) => t.reference)).not.toContain("SETTLE-VIS");
    const ca = await ok("ca", "GET", "/api/payments/transfers");
    expect(ca.transfers.map((t: any) => t.reference)).toEqual(expect.arrayContaining(["DEPOSIT-VIS", "SETTLE-VIS"]));
    expect((await api("prachi", "GET", "/api/payments/transfers")).status).toBe(403);
  });

  it("payments: the desk sees collections without gateway fees or OTA payouts; the CA reads the register", async () => {
    const bk = await ok("shaji", "POST", "/api/bookings", { guest_name: "Visibility Guest", guest_phone: "9500000111", channel_code: "direct", check_in: "2027-07-01", check_out: "2027-07-02", rooms: [{ room_id: "loc_r2", nightly_rate_paise: 650000 }] });
    await ok("sindhu", "POST", "/api/payments", { booking_id: bk.booking.id, method: "airpay", amount_paise: 100000, reference: "VIS-AIRPAY" });
    const desk = await ok("sindhu", "GET", `/api/payments?booking_id=${bk.booking.id}`);
    expect(desk.payments).toHaveLength(1);
    expect("fee_paise" in desk.payments[0]).toBe(false);
    await env.DB.prepare("INSERT INTO payments (id, property_id, booking_id, kind, method, amount_paise, account_id, received_on, status) VALUES ('pay_vis_ota','prop_meadows',?,'balance','ota',1000,'acc_bank','2027-07-03','confirmed')").bind(bk.booking.id).run();
    expect((await ok("sindhu", "GET", `/api/payments?booking_id=${bk.booking.id}`)).payments.map((p: any) => p.id)).not.toContain("pay_vis_ota");
    // An advance the owner posted is not on the desk's list; the desk sees what it collected.
    await ok("shaji", "POST", "/api/payments", { booking_id: bk.booking.id, method: "bank", amount_paise: 2000, reference: "VIS-OWNER" });
    const deskNow = await ok("sindhu", "GET", `/api/payments?booking_id=${bk.booking.id}`);
    expect(deskNow.payments.map((p: any) => p.reference)).toEqual(["VIS-AIRPAY"]);
    const ca = await ok("ca", "GET", `/api/payments?booking_id=${bk.booking.id}`);
    expect(ca.payments.map((p: any) => p.id)).toContain("pay_vis_ota");
    expect(ca.payments.find((p: any) => p.method === "airpay").fee_paise).toBeGreaterThan(0);
    // The CA reads but never records.
    expect((await api("ca", "POST", "/api/payments", { booking_id: bk.booking.id, method: "cash", amount_paise: 100 })).status).toBe(403);
    // The booking detail shows the desk no OTA terms.
    const det = await ok("prachi", "GET", `/api/bookings/${bk.booking.id}`);
    expect("commission_bp" in det.channel).toBe(false);
  });

  it("sales record a guest's advance against the booking, but not cash, other desks' payments or gateway receipts", async () => {
    const bk = await ok("prachi", "POST", "/api/bookings", { guest_name: "Sales Advance", guest_phone: "9500000222", channel_code: "direct", check_in: "2027-08-01", check_out: "2027-08-03", rooms: [{ room_id: "loc_r2", nightly_rate_paise: 1000000 }] });
    const pay = await api("prachi", "POST", "/api/payments", { booking_id: bk.booking.id, method: "upi", amount_paise: 1000000, account_id: "acc_bank", reference: "UPI-SALES-1" });
    expect(pay.status).toBe(201);
    const det = await ok("prachi", "GET", `/api/bookings/${bk.booking.id}`);
    expect(pay.json.balance_paise).toBe(det.booking.gross_paise - 1000000);
    expect(det.balance_paise).toBe(det.booking.gross_paise - 1000000);
    expect((await api("prachi", "POST", "/api/payments", { booking_id: bk.booking.id, method: "cash", amount_paise: 1000 })).status).toBe(403);
    expect((await api("prachi", "POST", "/api/payments", { booking_id: bk.booking.id, method: "ota", amount_paise: 1000 })).status).toBe(403);
    // Each desk lists what its own desk recorded.
    await ok("sindhu", "POST", "/api/payments", { booking_id: bk.booking.id, method: "cash", amount_paise: 5000, reference: "DESK-CASH" });
    const mine = await ok("prachi", "GET", `/api/payments?booking_id=${bk.booking.id}`);
    expect(mine.payments.map((p: any) => p.reference)).toEqual(["UPI-SALES-1"]);
    expect((await ok("sindhu", "GET", `/api/payments?booking_id=${bk.booking.id}`)).payments.map((p: any) => p.reference)).toEqual(["DESK-CASH"]);
    // The revenue desk sees both and can void either; a desk voids only its own desk's.
    expect((await ok("trupti", "GET", `/api/payments?booking_id=${bk.booking.id}`)).payments).toHaveLength(2);
    const cash = (await ok("sindhu", "GET", `/api/payments?booking_id=${bk.booking.id}`)).payments[0];
    expect((await api("prachi", "POST", `/api/payments/${cash.id}/void`, { reason: "not mine" })).status).toBe(403);
    expect((await api("sindhu", "POST", `/api/payments/${pay.json.id}/void`, { reason: "not mine" })).status).toBe(403);
    await ok("prachi", "POST", `/api/payments/${pay.json.id}/void`, { reason: "typed twice" });
    // Gateway receipts waiting in the inbox and other income stay with the front desk and the revenue desk.
    expect((await ok("prachi", "GET", "/api/payments/gateway-inbox")).items).toEqual([]);
    expect((await api("prachi", "POST", "/api/income", { on_date: "2027-08-01", category: "dining", description: "x", amount_paise: 1000, gst_rate_bp: 0, method: "upi" })).status).toBe(403);
    expect((await ok("sindhu", "GET", "/api/payments/gateway-inbox")).items).toBeDefined();
  });

  it("sales never see bank alerts or gateway receipts in the inbox, and cannot act on them", async () => {
    const alert = await ok("trupti", "POST", "/api/inbox/ingest", { from: "transaction.alerts@idfcfirstbank.com", subject: "Transaction alert from IDFC FIRST Bank", text: "Your A/C XXXXXXX3390 has been credited with INR 1,234.00 on 25/10/2026 10:00. New balance is INR 9,99,999.00CR.", message_id: "<vis-alert@idfc>" });
    const all = async (u: "prachi" | "trupti") => [...(await ok(u, "GET", "/api/inbox?status=pending")).items, ...(await ok(u, "GET", "/api/inbox?status=approved")).items, ...(await ok(u, "GET", "/api/inbox?status=routed")).items];
    expect((await all("prachi")).find((i: any) => i.id === alert.id)).toBeUndefined();
    expect((await all("prachi")).some((i: any) => i.kind === "bank_alert" || i.kind === "payment")).toBe(false);
    expect((await all("trupti")).find((i: any) => i.id === alert.id)).toBeTruthy();
    expect((await api("prachi", "POST", `/api/inbox/${alert.id}/dismiss`, {})).status).toBe(404);
    // A bank alert that waits (two banks, neither carries these digits) is on the revenue desk's My work, not sales'.
    await env.DB.prepare("INSERT INTO money_accounts (id, property_id, kind, name, holder_role, opening_paise, opening_date, account_no) VALUES ('acc_vis2','prop_meadows','bank','Second bank','owner',0,'2026-09-01','1111')").run();
    const waiting = await ok("trupti", "POST", "/api/inbox/ingest", { from: "transaction.alerts@idfcfirstbank.com", subject: "Transaction alert from IDFC FIRST Bank", text: "Your A/C XXXXXXX7777 has been credited with INR 10.00 on 25/10/2026 11:00. New balance is INR 1,000.00CR.", message_id: "<vis-wait@idfc>" });
    const sales = await ok("prachi", "GET", "/api/work");
    expect(JSON.stringify(sales)).not.toContain(waiting.id);
    const rev = await ok("trupti", "GET", "/api/work");
    expect(JSON.stringify(rev)).toContain(waiting.id);
  });

  it("stored files open only for the roles that may see them", async () => {
    await env.FILES.put("packs/prop_meadows/2026-10/v1/summary.json", "{}");
    await env.FILES.put("inbox/prop_meadows/inb_vis.eml", "raw");
    expect((await api("prachi", "GET", "/api/files/packs/prop_meadows/2026-10/v1/summary.json")).status).toBe(403);
    expect((await api("sindhu", "GET", "/api/files/packs/prop_meadows/2026-10/v1/summary.json")).status).toBe(403);
    expect((await api("ca", "GET", "/api/files/packs/prop_meadows/2026-10/v1/summary.json")).status).toBe(200);
    expect((await api("prachi", "GET", "/api/files/inbox/prop_meadows/inb_vis.eml")).status).toBe(403);
    expect((await api("trupti", "GET", "/api/files/inbox/prop_meadows/inb_vis.eml")).status).toBe(200);
  });
});
