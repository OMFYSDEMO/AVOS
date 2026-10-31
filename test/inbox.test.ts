import { describe, it, expect, beforeAll } from "vitest";
import { parseInboundEmail } from "../src/email/parsers";
import { seed, api, ok, sql } from "./helpers";

// Inbox automation (W1): emails apply themselves when the facts line up, and wait with a reason when they do not.
describe("Inbox automation", () => {
  beforeAll(async () => { await seed(); });

  const staah = (ref: string, extra = "") => ({ from: "noreply@staah.com", subject: "STAAH · New reservation · Booking.com", text: `Channel: Booking.com\nRef: ${ref}\nGuest: Meera Nair\nRoom: Premium ×1\nCheck-in: 12/12/2026\nCheck-out: 14/12/2026\nRoom Total: ₹14,000.00 (ex-GST)\nCommission: 23%\nChannel Collect${extra}` });

  it("books a STAAH reservation into a free room of the named type, then cancels it from the cancellation email", async () => {
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", staah("7000000000000001"));
    expect(ing.status).toBe("approved"); expect(ing.auto.applied).toBe(true); expect(ing.auto.what).toBe("booked");
    const nights = await sql("SELECT room_id, night FROM room_nights WHERE booking_id = ? ORDER BY night", ing.booking_id);
    expect(nights.map((n: any) => n.room_id)).toEqual(["loc_r2", "loc_r2"]);
    const notes = await sql("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'inbox_auto_booked'");
    expect(notes[0].n).toBeGreaterThan(0);
    const audit = await sql("SELECT actor_email FROM audit_log WHERE action = 'inbox.auto_book' AND entity_id = ?", ing.id);
    expect(audit[0].actor_email).toBe("inbox-automation");
    // The cancellation email releases the room without anyone touching it.
    const canc = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "STAAH · Cancelled reservation · Booking.com", text: "Channel: Booking.com\nRef: 7000000000000001\nGuest: Meera Nair\nRoom: Premium ×1\nCheck-in: 12/12/2026\nCheck-out: 14/12/2026" });
    expect(canc.status).toBe("approved"); expect(canc.auto.what).toBe("cancelled");
    expect((await sql("SELECT status FROM bookings WHERE id = ?", ing.booking_id))[0].status).toBe("cancelled");
    expect((await sql("SELECT COUNT(*) AS n FROM room_nights WHERE booking_id = ?", ing.booking_id))[0].n).toBe(0);
  });

  it("leaves a card with the reason when the room type is taken or the channel is unknown", async () => {
    // Premium is the only Premium room: a second reservation for the same nights waits for a person.
    await ok("prachi", "POST", "/api/inbox/ingest", staah("7000000000000002"));
    const clash = await ok("prachi", "POST", "/api/inbox/ingest", staah("7000000000000003"));
    expect(clash.status).toBe("pending");
    expect(clash.auto.note).toMatch(/only 0 of 1 Premium/);
    const unknown = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "STAAH · New reservation · Trivago", text: "Channel: Trivago\nRef: 7000000000000004\nGuest: Arun K\nRoom: Deluxe ×1\nCheck-in: 20/12/2026\nCheck-out: 21/12/2026\nRoom Total: ₹6,000.00 (ex-GST)" });
    expect(unknown.status).toBe("pending");
    expect(unknown.auto.note).toMatch(/channel "Trivago" is not set up/);
    const list = await ok("prachi", "GET", "/api/inbox?status=pending");
    expect(list.items.find((i: any) => i.id === unknown.id).auto_note).toMatch(/Trivago/);
    // A person can still approve it the old way, picking the channel and room.
    const appr = await ok("prachi", "POST", `/api/inbox/${unknown.id}/approve`, { room_ids: ["loc_r1"], channel_code: "booking_com" });
    expect(appr.booking.status).toBe("approved");
  });

  it("a waiting card shows every room with who holds it, preselects the free ones, and a second copy of the email is a duplicate", async () => {
    const list = await ok("prachi", "GET", "/api/inbox?status=pending");
    const clash = list.items.find((i: any) => i.external_ref === "7000000000000003");
    expect(clash.room_options.map((o: any) => [o.name, o.free])).toEqual([["Deluxe", true], ["Premium", false], ["Superior", true], ["Executive", true]]);
    expect(clash.room_options[1].taken_by).toBe("Meera Nair");
    expect(clash.suggested_room_ids).toEqual([]);
    expect(clash.nightly_rate_paise).toBe(700000);
    const again = await ok("prachi", "POST", "/api/inbox/ingest", { ...staah("7000000000000003"), message_id: "<copy@staah>" });
    expect(again.status).toBe("duplicate");
    // A person books it into a free room of another type with one call; sales then see it in Reservations.
    const appr = await ok("prachi", "POST", `/api/inbox/${clash.id}/approve`, { room_ids: ["loc_r3"] });
    expect(appr.booking.status).toBe("approved");
    const mine = await ok("prachi", "GET", "/api/bookings");
    expect(mine.bookings.find((b: any) => b.id === appr.booking.id)).toBeTruthy();
    const first = (await ok("prachi", "GET", "/api/inbox?status=approved")).items.find((i: any) => i.external_ref === "7000000000000002");
    expect(mine.bookings.find((b: any) => b.id === first.booking_id)).toBeTruthy(); // auto-booked by the system, still on the sales list
  });

  it("books a SwiftBook direct stay and records the Airpay payment for it, once", async () => {
    const sb = await ok("prachi", "POST", "/api/inbox/ingest", { from: "bookings@swiftbook.io", subject: "SwiftBook · New booking confirmed", text: "Guest: Rashmi Shah\nItinerary No: 10609000001012\n1 room · 2 nights\nRoom: Deluxe ×1\nCheck-in: 2026-12-26\nCheck-out: 2026-12-28\nTotal: ₹14,700.00\nPaid online" });
    expect(sb.status).toBe("approved"); expect(sb.auto.what).toBe("booked");
    const bk = (await sql("SELECT channel_id, gross_paise FROM bookings WHERE id = ?", sb.booking_id))[0] as any;
    expect(bk.channel_id).toBe("ch_swiftbook");
    const pay = await ok("prachi", "POST", "/api/inbox/ingest", { from: "alerts@airpay.co.in", subject: "Airpay · transaction successful", text: "Order: 10609000001012399437\nAmount: ₹14,700.00\nPayer: Rashmi Shah\nStatus: success" });
    expect(pay.status).toBe("approved"); expect(pay.auto.what).toBe("paid");
    const p = (await sql("SELECT booking_id, amount_paise, status, fee_expense_id, account_id FROM payments WHERE id = ?", pay.payment_id))[0] as any;
    expect(p.booking_id).toBe(sb.booking_id); expect(p.amount_paise).toBe(1470000); expect(p.status).toBe("confirmed"); expect(p.fee_expense_id).toBeTruthy(); expect(p.account_id).toBe("acc_gw");
    // The same receipt again is a duplicate, not a second payment.
    const again = await ok("prachi", "POST", "/api/inbox/ingest", { from: "alerts@airpay.co.in", subject: "Airpay · transaction successful", text: "Order: 10609000001012399437\nAmount: ₹14,700.00\nPayer: Rashmi Shah\nStatus: success", message_id: "<second@airpay>" });
    expect(again.status).toBe("duplicate");
    expect((await sql("SELECT COUNT(*) AS n FROM payments WHERE reference = '10609000001012399437' AND status != 'void'"))[0].n).toBe(1);
    // A receipt for no stay we hold routes to the Payments screen for a person.
    const stray = await ok("prachi", "POST", "/api/inbox/ingest", { from: "alerts@airpay.co.in", subject: "Airpay · transaction successful", text: "Order: 99990000000000001\nAmount: ₹500.00\nPayer: Someone\nStatus: success" });
    expect(stray.status).toBe("routed"); expect(stray.auto.note).toMatch(/no stay matches/);
    const gw = await ok("sindhu", "GET", "/api/payments/gateway-inbox");
    expect(gw.items.find((i: any) => i.id === stray.id)).toBeTruthy();
  });

  it("reads Airpay's real receipt forwarded from Zoho, and knows a payment already recorded under the Airpay Id", async () => {
    const receipt = "Kind Regards,\nThe Meadows | Varkala\n============ Forwarded message ============\nINR 20000.00\nCollected Successfully\nPAYMENT DETAILS\nMerchant Name\nMeadows Varkala\nOrder ID\n10609000001099990000001\nCustomer Name\nTEST GUEST\nOrder Amount\nINR 20000.00\nSurcharge\nINR 0.00\nBilled Amount\nINR 20000.00\nAirpay Id\n2099999001\nhttps://nps.airpay.co.in/view.php?id=1";
    const parsed = parseInboundEmail("bookings@meadowsvarkala.com", "Fwd: Congratulations! Order ID 10609000001099990000001 Transaction is Successful", undefined, receipt);
    expect(parsed.source).toBe("airpay"); expect(parsed.confidence).toBe("high");
    expect(parsed.data).toMatchObject({ order_id: "10609000001099990000001", airpay_id: "2099999001", amount_paise: 2000000, payer_name: "TEST GUEST", success: true });
    // The desk had already recorded it by hand with the Airpay Id as the reference.
    const bk = await ok("shaji", "POST", "/api/bookings", { guest_name: "Test Guest", guest_phone: "9500000077", channel_code: "direct", check_in: "2027-06-01", check_out: "2027-06-03", rooms: [{ room_id: "loc_r1", nightly_rate_paise: 1000000 }] });
    await ok("sindhu", "POST", "/api/payments", { booking_id: bk.booking.id, method: "airpay", amount_paise: 2000000, reference: "2099999001" });
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "bookings@meadowsvarkala.com", subject: "Fwd: Congratulations! Order ID 10609000001099990000001 Transaction is Successful", text: receipt, message_id: "<zoho-fwd-airpay@test>" });
    expect(ing.status).toBe("duplicate");
    expect((await sql("SELECT COUNT(*) AS n FROM payments WHERE booking_id = ? AND status != 'void'", bk.booking.id))[0].n).toBe(1);
  });

  it("files a STAAH Max payment link with what it asked for, tied to the booking reference", async () => {
    const text = "The Meadows Varkala\nPAYMENT REQUEST\nReference: 10609000001061952136\n 27 Oct 2026\nDear Test Guest,\nThank you for choosing The Meadows Varkala! To confirm your upcoming stay, kindly complete your payment using the secure link below.\nBOOKING DETAILS\nBooking Reference:\t1060900000106195\nGuest Name:\tTest Guest\nRoom Type/Rate Plan:\tPremium Lawn View / Morning Bliss\nGuest Info:\t2 Adults / 0 Children\nStay Info:\t27 Oct 2026 to 28 Oct 2026 (1 night)\nAmount Due:\tINR 1.00\nPAYMENT INSTRUCTIONS\nThis payment link expires on 28-Oct-2026 16:55:22. Please ensure payment is completed before this time to secure your reservation.\nPROCEED TO PAYMENT\nhttps://www.swiftbook.io/inst/#securepayment?propertyId=x&tkn=y&sp=Y\nWarm Regards,\nThe Meadows Varkala";
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@mybookingsite.io", subject: "The Meadows Varkala - Payment link - reference 10609000001061952136", text });
    expect(ing.parsed).toMatchObject({ source: "staahmax", kind: "payment_request", external_ref: "10609000001061952136" });
    expect(ing.parsed.data).toMatchObject({ booking_ref: "1060900000106195", guest_name: "Test Guest", amount_due_paise: 100, check_in: "2026-10-27", check_out: "2026-10-28" });
    expect(ing.status).toBe("dismissed");
    expect((await sql("SELECT auto_note FROM inbox_items WHERE id = ?", ing.id))[0].auto_note).toMatch(/payment link sent to Test Guest for ₹1\.00 \(booking 1060900000106195\)/);
  });

  it("records a STAAH Max online payment against the booking once, whichever of it and Airpay's receipt comes first", async () => {
    const maxMail = (order: string, bookingRef: string, amount: string) => ({ from: "noreply@mybookingsite.io", subject: "The Meadows Varkala - You have received payment through STAAH Max Online Payment",
      text: `Property\tThe Meadows Varkala\nPAYMENT RECEIVED\t27 Oct 2026\nReference: ${order}\n\nDear The Meadows Varkala,\nYou have received payment through STAAH Max Online Payment of INR ${amount}.\n# PAYMENT DETAILS:\nEmail:\tguest@example.com\nContact Ph:\t+91 9000000000\nBOOKING DETAILS\nBooking Reference:\t${bookingRef}\nGuest Name:\tMax Guest\nRoom Type/Rate Plan:\tPremium Lawn View / Morning Bliss\nGuest Info:\t2 Adults / 0 Children\nStay Info:\t27 Oct 2026 to 28 Oct 2026 (1 night)\nAmount Paid:\tINR ${amount}.00\nKind Regards,\n\nSTAAH Team\nThe Meadows Varkala` });
    const airpayMail = (order: string, amount: string, id: string) => ({ from: "noreply@airpay.co.in", subject: `Congratulations! Order ID ${order} Transaction is Successful`, text: `INR ${amount}\nCollected Successfully\nOrder ID\n${order}\nCustomer Name\nMAX GUEST\nOrder Amount\nINR ${amount}\nAirpay Id\n${id}\nhttps://nps.airpay.co.in/view.php?id=9` });
    // 1. The booking carries the confirmation's reservation number (= the order id); STAAH Max first, Airpay second.
    const b1 = await ok("shaji", "POST", "/api/bookings", { guest_name: "Max Guest", guest_phone: "9000000001", channel_code: "direct", external_ref: "10609000001063720001", check_in: "2027-09-01", check_out: "2027-09-02", rooms: [{ room_id: "loc_r2", nightly_rate_paise: 650000 }] });
    const m1 = await ok("prachi", "POST", "/api/inbox/ingest", maxMail("10609000001063720001", "1060900000106372", "1000"));
    expect(m1.parsed).toMatchObject({ source: "staahmax", kind: "payment", external_ref: "10609000001063720001" });
    expect(m1.parsed.data).toMatchObject({ booking_ref: "1060900000106372", amount_paise: 100000, success: true });
    expect(m1.auto.what).toBe("paid");
    const a1 = await ok("prachi", "POST", "/api/inbox/ingest", airpayMail("10609000001063720001", "1000.00", "2099990001"));
    expect(a1.status).toBe("duplicate");
    expect((await sql("SELECT COUNT(*) AS n, SUM(amount_paise) AS s FROM payments WHERE booking_id = ? AND status != 'void'", b1.booking.id))[0]).toEqual({ n: 1, s: 100000 });
    // 2. The booking carries only the 16-digit booking reference; Airpay first, STAAH Max second.
    const b2 = await ok("shaji", "POST", "/api/bookings", { guest_name: "Max Guest Two", guest_phone: "9000000002", channel_code: "direct", external_ref: "1060900000106399", check_in: "2027-09-03", check_out: "2027-09-04", rooms: [{ room_id: "loc_r2", nightly_rate_paise: 650000 }] });
    const a2 = await ok("prachi", "POST", "/api/inbox/ingest", airpayMail("10609000001063990002", "500.00", "2099990002"));
    expect(a2.auto.what).toBe("paid");
    const m2 = await ok("prachi", "POST", "/api/inbox/ingest", maxMail("10609000001063990002", "1060900000106399", "500"));
    expect(m2.status).toBe("duplicate");
    expect((await sql("SELECT COUNT(*) AS n FROM payments WHERE booking_id = ? AND status != 'void'", b2.booking.id))[0].n).toBe(1);
  });

  it("never takes a failed or pending Airpay attempt for a payment", async () => {
    const mail = (subject: string, head: string) => parseInboundEmail("noreply@airpay.co.in", subject, undefined, `${head}\nOrder ID\n179000000000999\nCustomer Name\nSOME GUEST\nOrder Amount\nINR 5250.00\nAirpay Id\n2099999003\nhttps://nps.airpay.co.in/view.php?id=3`);
    for (const [subject, head] of [["Order ID 179000000000999 Transaction is Unsuccessful", "INR 5250.00\nTransaction Unsuccessful"], ["Order ID 179000000000999 Transaction Failed", "INR 5250.00\nPayment failed"], ["Order ID 179000000000999 Transaction Pending", "INR 5250.00\nYour transaction is pending"]]) {
      const p = mail(subject, head);
      expect(p.data.success).toBe(false); expect(p.confidence).toBe("low");
    }
    expect(mail("Congratulations! Order ID 179000000000999 Transaction is Successful", "INR 5250.00\nCollected Successfully").data.success).toBe(true);
  });

  it("dates an Airpay payment the day the receipt was sent, even when it is forwarded later", async () => {
    // Booked by hand with the website reservation number; Airpay's order id is that number.
    const bk = await ok("shaji", "POST", "/api/bookings", { guest_name: "Late Forward Guest", guest_phone: "9500000078", channel_code: "direct", external_ref: "179000000000888", check_in: "2027-07-01", check_out: "2027-07-02", rooms: [{ room_id: "loc_r3", nightly_rate_paise: 500000 }] });
    const sent = new Date(Date.now() - 2 * 86_400_000); // two days ago
    const day = new Date(sent.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const receipt = `Kind Regards,\nThe Meadows | Varkala\n============ Forwarded message ============\nFrom: Airpay <noreply@airpay.co.in>\nTo: <bookings@meadowsvarkala.com>\nDate: ${sent.toUTCString()}\nSubject: Congratulations! Order ID 179000000000888 Transaction is Successful\n============ Forwarded message ============\nINR 5250.00\nCollected Successfully\nOrder ID\n179000000000888\nCustomer Name\nLATE FORWARD GUEST\nOrder Amount\nINR 5250.00\nAirpay Id\n2099999002\nhttps://nps.airpay.co.in/view.php?id=2`;
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "bookings@meadowsvarkala.com", subject: "Fwd: Congratulations! Order ID 179000000000888 Transaction is Successful", text: receipt });
    expect(ing.auto.what).toBe("paid");
    const pay = (await sql("SELECT received_on, amount_paise FROM payments WHERE booking_id = ?", bk.booking.id))[0];
    expect(pay).toEqual({ received_on: day, amount_paise: 525000 });
  });

  it("reads a Gmail-forwarded STAAH notification in the real label-above-value layout and books it", async () => {
    // The forwarder's signature comes first; the STAAH sender and the table follow the "Forwarded message" marker.
    const text = `Kind Regards,\n\nShaji Anandan\nDirector - Sales & Marketing\nThe Meadows | Varkala\nGST - 32AARCM3606J1ZD\n\n============ Forwarded message ============\nFrom:  <noreply@staah.com>\nTo: <bookings@meadowsvarkala.com>\nDate: Mon, 19 Oct 2026 19:46:18 +0100\nSubject: New Reservation Goibibo for kumar Reservation No:0190589681 (1060900000001400) - The Meadows Varkala\n============ Forwarded message ============\nReservation Confirmation\nChannel Name: Goibibo\nBookings Status: Confirmed\nBooking Id#: 1060900000001400 (0190589681)\nGuest Details\nCONTACT NAME\nsaurav kumar\nCONTACT NUMBER\nALTERNATIVE NUMBER\nEMAIL\nBooking Details\nHOTEL\nThe Meadows Varkala\nBOOKING REFERENCE\n1060900000001400 (0190589681)\nADDRESS\n133/B, Marakkadamukku, Palachira PO.\nROOM TYPE\nPremium - Premium Room_CP\nNO OF ROOMS\n1\nCHECK-IN\n20 Jan 2027\nCHECK-OUT\n22 Jan 2027\nNO OF NIGHTS\n2\nDATE\n20 Jan 2027\nGUEST NAME\nsaurav kumar\nADULTS\n2\nCHILDREN\n1\nBEDDING\n--\nAMOUNT\nINR5,852.25\n21 Jan 2027\nsaurav kumar\n2\n1\n--\nINR5,852.25\n(Age of child 1:3)\nAdditional Information:\nChannel collect, Inclusions : Breakfast included , VendorName:: MakeMyTrip, Vendor BookingId:: NH7201234,\nPayment Type: Channel Collect\nCommission : INR 2,437.29\nRoom Total : INR 11,704.50\nTotal Taxes : INR 688.50\nTotal (All Inclusive): INR 12,393.00`;
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "bookings@meadowsvarkala.com", subject: "Fwd: New Reservation Goibibo for kumar Reservation No:0190589681 (1060900000001400) - The Meadows Varkala", text });
    expect(ing.parsed.source).toBe("staah"); expect(ing.parsed.kind).toBe("new_reservation");
    expect(ing.parsed.external_ref).toBe("1060900000001400"); expect(ing.parsed.data.ota_ref).toBe("0190589681");
    expect(ing.parsed.data).toMatchObject({ channel: "Goibibo", guest_name: "saurav kumar", room_name: "Premium", rooms: 1, nights: 2, adults: 2, children: 1, check_in: "2027-01-20", check_out: "2027-01-22", room_total_paise: 1170450, taxes_paise: 68850, total_incl_gst_paise: 1239300, commission_paise: 243729, collection_type: "channel_collect" });
    expect(ing.parsed.confidence).toBe("high");
    expect(ing.status).toBe("approved"); expect(ing.auto.what).toBe("booked");
    const bk = (await sql("SELECT channel_id, room_total_paise, external_ref FROM bookings WHERE id = ?", ing.booking_id))[0] as any;
    expect(bk.channel_id).toBe("ch_goibibo"); expect(bk.room_total_paise).toBe(1170450); expect(bk.external_ref).toBe("1060900000001400 (0190589681)");
    expect((await sql("SELECT room_id FROM room_nights WHERE booking_id = ?", ing.booking_id))[0].room_id).toBe("loc_r2");
    // Re-reading a waiting card re-runs the parser and automation; a done card is left alone.
    expect((await api("prachi", "POST", `/api/inbox/${ing.id}/reparse`)).status).toBe(409);
    const unknown = await ok("prachi", "POST", "/api/inbox/ingest", { from: "someone@example.com", subject: "hello", text: "nothing to see" });
    expect(unknown.status).toBe("pending");
    const re = await ok("prachi", "POST", `/api/inbox/${unknown.id}/reparse`);
    expect(re.status).toBe("pending"); expect(re.parsed.source).toBe("unknown");
  });

  it("books every room type of a multi-room STAAH email, each at its own price", async () => {
    // Booking.com through STAAH: one block per room type, nightly amounts printed with GST, one Room Total ex-GST.
    const block = (room: string, adults: number, n1: string, n2: string, tax: string) => `ROOM TYPE\n${room}\nNO OF ROOMS\n1\nCHECK-IN\n15 Mar 2027\tCHECK-OUT\n17 Mar 2027\tNO OF NIGHTS\n2\nDATE\n15 Mar 2027\tGUEST NAME\nMulti Room Guest\tADULTS\n${adults}\tCHILDREN\n0\tBEDDING\n--\tAMOUNT\nINR${n1}\n16 Mar 2027\tMulti Room Guest\t${adults}\t0\t--\tINR${n2}\nAdd ons\nName\nParking service (Included)\tRate\nQuantity\nNights\n\nINR0.00\nTaxes\nGoods & services tax\tINR${tax}\n\nSpecial Request\n\nsmoking preference :: Non-Smoking\n\nCancellation Policy\n\nThe guest can cancel free of charge until 7 days before arrival.\n`;
    const text = `Reservation Confirmation\nChannel Name: Booking.com\nBookings Status: Confirmed\nBooking Id#: 7000000000009901 (5600000001)\nBooking Details\n\nHOTEL\nThe Meadows Varkala\n\nBOOKING REFERENCE\n7000000000009901 (5600000001)\n`
      + block("Superior - Deluxe Double Room with Balcony - Standard Rate", 3, "17,390.25", "17,390.25", "5,305.50")
      + block("Deluxe - Double Room with Balcony - Standard Rate", 2, "13,706.44", "13,706.45", "4,181.63")
      + `\nAdditional Information:\n\n** THIS RESERVATION HAS BEEN PRE-PAID **\n\nPayment Type: Channel Collect\nCommission : INR 9,486.26\nRoom Total : INR 52,706.26\nTotal Taxes : INR 9,487.13\nTotal (All Inclusive): INR 62,193.39`;
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "New Reservation Booking.com for Guest Reservation No:5600000001 (7000000000009901) - The Meadows Varkala", text });
    expect(ing.parsed.data.room_types.map((t: any) => [t.name, t.count])).toEqual([["Superior", 1], ["Deluxe", 1]]);
    expect(ing.parsed.data).toMatchObject({ rooms: 2, adults: 5, room_total_paise: 5270626, total_incl_gst_paise: 6219339 });
    expect(ing.status).toBe("approved"); expect(ing.auto.what).toBe("booked");
    const rooms = await sql("SELECT room_id, nightly_rate_paise, room_total_paise FROM booking_rooms WHERE booking_id = ? ORDER BY room_id", ing.booking_id);
    expect(rooms).toEqual([
      { room_id: "loc_r1", nightly_rate_paise: 1161563, room_total_paise: 2323126 },
      { room_id: "loc_r3", nightly_rate_paise: 1473750, room_total_paise: 2947500 },
    ]);
    // The two rooms add up to the email's Room Total to the paisa (GST follows from the property's GSTIN).
    const bk = (await sql("SELECT room_total_paise, adults FROM bookings WHERE id = ?", ing.booking_id))[0];
    expect(bk).toEqual({ room_total_paise: 5270626, adults: 5 });
    expect((await sql("SELECT COUNT(*) AS n FROM room_nights WHERE booking_id = ?", ing.booking_id))[0].n).toBe(4);

    // Same two types again for the same nights: Superior is taken, so nothing books on its own and the card waits.
    const again = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "New Reservation Booking.com for Other Reservation No:5600000002 (7000000000009902) - The Meadows Varkala", text: text.replace(/7000000000009901 \(5600000001\)/g, "7000000000009902 (5600000002)") });
    expect(again.parsed.data.room_types).toHaveLength(2);
    expect(again.status).toBe("pending"); expect(again.auto.note).toMatch(/Superior/);
  });

  it("books a STAAH 'travelguruxml' reservation into Yatra, keeps both references, and explains an unmapped rate plan", async () => {
    await sql("INSERT OR IGNORE INTO channels (id, property_id, code, name, collection_type, commission_bp) VALUES ('ch_yatra', 'prop_meadows', 'yatra', 'Yatra / Travelguru', 'channel_collect', 2000)");
    const text = `Reservation Confirmation\nChannel Name: travelguruxml\nBookings Status: Confirmed\nBooking Id#: P0009999901 (1060900000009427)\nGuest Details\nCONTACT NAME\nTest Traveller\nBooking Details\nROOM TYPE\nSuperior - Deluxe Room(04 Apr 25 ~ 04 Apr 27) - B2C\nNO OF ROOMS\n1\nCHECK-IN\n21 Nov 2027\nCHECK-OUT\n22 Nov 2027\nNO OF NIGHTS\n1\nDATE\n21 Nov 2027\nGUEST NAME\nTest Traveller\nADULTS\n2\nCHILDREN\n0\nAMOUNT\nINR6,650.00\nAdditional Information:\nPayment Type: Channel Collect\nCommission : INR 1,330.00\nRoom Total : INR 6,650.00\nTotal Taxes : INR 333.00\nTotal (All Inclusive): INR 6,983.00`;
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "New Reservation travelguruxml for Traveller Reservation No:P0009999901 (1060900000009427) - The Meadows Varkala", text });
    expect(ing.parsed.data.channel).toBe("travelguruxml");
    expect(ing.status).toBe("approved"); expect(ing.auto.what).toBe("booked");
    const bk = (await sql("SELECT channel_id, external_ref FROM bookings WHERE id = ?", ing.booking_id))[0];
    expect(bk).toEqual({ channel_id: "ch_yatra", external_ref: "1060900000009427 (P0009999901)" });
    // STAAH's warning for the same reservation now says where the booking is and what to fix.
    const alert = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "The Meadows Varkala - P0009999901 Unmapped Rate Plan", text: "Dear Channel Manager.\nA reservation was received for a rate plan that is not mapped." });
    expect(alert.parsed).toMatchObject({ source: "staah", kind: "channel_alert", external_ref: "P0009999901" });
    expect(alert.status).toBe("pending");
    expect(alert.auto.note).toMatch(/could not map the OTA's rate plan for reservation P0009999901: the booking \(Test Traveller, 2027-11-21\) is in AVOS/);
  });

  it("matches a cancellation to a stay that carries the migrated 'STAAH id (OTA ref)' reference", async () => {
    const r = await ok("prachi", "POST", "/api/bookings", { guest_name: "Migrated Guest", guest_phone: "9222222222", channel_code: "agoda", external_ref: "1060900000001308 (2049201329)", check_in: "2027-02-10", check_out: "2027-02-11", rooms: [{ room_id: "loc_r4", nightly_rate_paise: 500000 }] });
    const canc = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "Cancelled Reservation Agoda for Migrated Reservation No:2049201329 (1060900000001308) - The Meadows Varkala", text: "Channel Name: Agoda\nBookings Status: Cancelled\nBooking Id#: 1060900000001308 (2049201329)\nGUEST NAME\nMigrated Guest\nCHECK-IN\n10 Feb 2027\nCHECK-OUT\n11 Feb 2027" });
    expect(canc.status).toBe("approved"); expect(canc.auto.what).toBe("cancelled");
    expect((await sql("SELECT status FROM bookings WHERE id = ?", r.booking.id))[0].status).toBe("cancelled");
  });

  it("files our own staff's mail as dismissed, but keeps what they forward on purpose", async () => {
    // A quote the sales desk sent from bookings@ that a mailbox copied to AVOS: not something to act on.
    const quote = "Dear Sir/Maam,\n\nGreetings from The Meadows Varkala!!\n\nFollowing your query for a 9th Dec check-in and 13th Dec check-out, I can offer you a Premium Room @ 5500+Taxes per night.\n\nKind Regards,\nSales & Reservations";
    const own = await ok("prachi", "POST", "/api/inbox/ingest", { from: "Bookings <bookings@meadowsvarkala.com>", subject: "Booking Query- Meadows Varkala-9th-13thDec", text: quote });
    expect(own.status).toBe("dismissed");
    expect((await sql("SELECT auto_note FROM inbox_items WHERE id = ?", own.id))[0].auto_note).toMatch(/own mailbox/);
    // The same address forwarding something it wants AVOS to see: kept for a person.
    const fwd = await ok("prachi", "POST", "/api/inbox/ingest", { from: "bookings@meadowsvarkala.com", subject: "Fwd: room request from a guest", text: "---------- Forwarded message ---------\nFrom: guest@example.com\nCan we book two rooms in March?" });
    expect(fwd.status).toBe("pending");
    // An outsider's email AVOS cannot read still waits for a person.
    const other = await ok("prachi", "POST", "/api/inbox/ingest", { from: "guest@example.com", subject: "Booking Query", text: quote });
    expect(other.status).toBe("pending");
  });

  it("does nothing on its own when the owner switches automation off", async () => {
    await ok("shaji", "PATCH", "/api/admin/property", { inbox_automation: false });
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "STAAH · New reservation · Agoda", text: "Channel: Agoda\nRef: 7000000000000009\nGuest: Lina P\nRoom: Executive ×1\nCheck-in: 05/01/2027\nCheck-out: 06/01/2027\nRoom Total: ₹5,000.00 (ex-GST)" });
    expect(ing.status).toBe("pending"); expect(ing.auto).toBeNull();
    await ok("shaji", "PATCH", "/api/admin/property", { inbox_automation: true });
    expect((await api("prachi", "PATCH", "/api/admin/property", { inbox_automation: false })).status).toBe(403);
  });
});

describe("STAAH booking engine (website) confirmations", () => {
  beforeAll(seed);
  const html = (id: string, guest: string, room: string, ci: string, co: string, total: string, paid = "0.00") => `<html><body><table><tr><td>Booking Confirmation &mdash; The Meadows Varkala</td></tr>
<tr><td>The Meadows Varkala</td></tr><tr><td>meadowsvarkala@gmail.com 133/B, Marakkadamukku, Varkala</td></tr>
<tr><td>Booking ID</td></tr><tr><td>${id}</td></tr><tr><td>Confirmed</td></tr>
<tr><td>Guest Information</td></tr><tr><td>${guest}</td></tr><tr><td>guest@example.com</td></tr><tr><td>+91 09920031314</td></tr>
<tr><td>Dear ${guest} , Greetings from The Meadows !</td></tr><tr><td>Thank you for booking with us.</td></tr>
<tr><td>${room} - </td></tr><tr><td>Check-in</td></tr><tr><td>${ci.split(" ").join("&zwnj; ")}</td></tr><tr><td>ETA 02&zwnj;:&zwnj;00&zwnj; PM</td></tr><tr><td>&rarr;</td></tr>
<tr><td>Check-out</td></tr><tr><td>${co.split(" ").join("&zwnj; ")}</td></tr><tr><td>12&zwnj;:&zwnj;00&zwnj; PM</td></tr>
<tr><td>${guest} &middot; 2 adults</td></tr><tr><td>${ci}</td></tr><tr><td>INR ${total}</td></tr><tr><td>Total</td></tr><tr><td>INR ${total}</td></tr>
<tr><td>Cancellation Policy Room 1 :- &bull; The guest shall be charged the total price if cancelled.</td></tr>
<tr><td>Rooms</td></tr><tr><td>${room}</td></tr><tr><td>INR ${total}</td></tr><tr><td>Sub Total</td></tr><tr><td>INR ${total}</td></tr><tr><td>Total</td></tr><tr><td>INR ${total}</td></tr>
<tr><td>Amount Paid</td></tr><tr><td>INR ${paid}</td></tr><tr><td>We are excited to host you !</td></tr></table></body></html>`;

  it("reads the template (zero-width joiners and all) and books a direct stay into the matching room type", async () => {
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@mybookingsite.io", subject: "(Confirmed) Anita Menon Reservation No:1060900000105200-The Meadows Varkala", html: html("1060900000105200", "Anita Menon", "Premium Lawn View", "12 Feb 2027", "14 Feb 2027", "13,650.00") });
    expect(ing.parsed.source).toBe("bookingengine"); expect(ing.parsed.kind).toBe("new_reservation");
    expect(ing.parsed.external_ref).toBe("1060900000105200");
    expect(ing.parsed.data).toMatchObject({ channel: "Direct", guest_name: "Anita Menon", guest_email: "guest@example.com", room_name: "Premium Lawn View", rooms: 1, adults: 2, check_in: "2027-02-12", check_out: "2027-02-14", total_incl_gst_paise: 1365000, amount_paid_paise: 0 });
    expect(ing.parsed.data.guest_phone).toMatch(/9920031314/);
    expect(ing.parsed.confidence).toBe("high");
    // ₹13,650 incl. GST for 2 nights → ₹6,500/night ex-GST on the unregistered seed = the Premium tariff → books itself.
    expect(ing.status).toBe("approved"); expect(ing.auto.what).toBe("booked");
    const bk = (await sql("SELECT channel_id, status, external_ref FROM bookings WHERE id = ?", ing.booking_id))[0];
    expect(bk).toMatchObject({ channel_id: "ch_direct", external_ref: "1060900000105200" });
    expect((await sql("SELECT room_id FROM room_nights WHERE booking_id = ?", ing.booking_id))[0].room_id).toBe("loc_r2");
  });

  it("two rooms in one confirmation: the booking total is the grand total, not the first room's line", async () => {
    // Each room line carries its own "Total"; the booking's Total comes last, after Sub Total.
    const two = html("179000000000777", "Two Rooms Guest", "Premium Lawn View", "21 Dec 2027", "22 Dec 2027", "5,292.00", "10,584.00")
      .replace('<tr><td>Cancellation Policy', '<tr><td>Two Rooms Guest &middot; 2 adults</td></tr><tr><td>21 Dec 2027</td></tr><tr><td>INR 5,292.00</td></tr><tr><td>Total</td></tr><tr><td>INR 5,292.00</td></tr><tr><td>Cancellation Policy')
      .replace('<tr><td>Rooms</td></tr><tr><td>Premium Lawn View</td></tr><tr><td>INR 5,292.00</td></tr><tr><td>Sub Total</td></tr><tr><td>INR 5,292.00</td></tr><tr><td>Total</td></tr><tr><td>INR 5,292.00</td></tr>',
        '<tr><td>Rooms</td></tr><tr><td>Premium Lawn View</td></tr><tr><td>INR 5,292.00</td></tr><tr><td>Premium Lawn View</td></tr><tr><td>INR 5,292.00</td></tr><tr><td>Sub Total</td></tr><tr><td>INR 10,584.00</td></tr><tr><td>Total</td></tr><tr><td>INR 10,584.00</td></tr>');
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@mybookingsite.io", subject: "(Confirmed) Two Rooms Guest Reservation No:179000000000777-The Meadows Varkala", html: two });
    expect(ing.parsed.data).toMatchObject({ rooms: 2, total_incl_gst_paise: 1058400, amount_paid_paise: 1058400 });
    // Only one Premium room exists, so the second cannot be booked on its own: the card waits with the reason.
    expect(ing.status).toBe("pending"); expect(ing.auto.note).toMatch(/only 1 of 2/);
    // Booked by hand from the card; the guest paid online but no Airpay receipt has come: the revenue desk is told.
    const bk = await ok("prachi", "POST", "/api/bookings", { guest_name: "Two Rooms Guest", guest_phone: "9560000001", channel_code: "direct", external_ref: "179000000000777", inbox_item_id: ing.id, check_in: "2027-12-21", check_out: "2027-12-22", rooms: [{ room_id: "loc_r1", nightly_rate_paise: 504000 }, { room_id: "loc_r2", nightly_rate_paise: 504000 }] });
    const work = await ok("trupti", "GET", "/api/work?all=1");
    const items = (work.items ?? work.mine ?? []) as any[];
    const flag = items.find((w) => w.key === `paidonline:${ing.id}`);
    expect(flag?.title).toMatch(/paid ₹10,584 online/);
    // The receipt arrives (Airpay order ids begin with the reservation number): the payment is recorded and the flag clears.
    await ok("trupti", "POST", "/api/payments", { booking_id: bk.booking.id, method: "airpay", amount_paise: 1058400, reference: "1790000000007770000001" });
    const after = await ok("trupti", "GET", "/api/work?all=1");
    expect(((after.items ?? after.mine ?? []) as any[]).some((w) => w.key === `paidonline:${ing.id}`)).toBe(false);
  });

  it("a room type AVOS does not know waits for a person, and 'book by hand' from Reservations closes the card", async () => {
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@mybookingsite.io", subject: "(Confirmed) Test Test Reservation No:1060900000105133-The Meadows Varkala", html: html("1060900000105133", "Test Test", "Garden Cottage", "20 Mar 2027", "21 Mar 2027", "1.00") });
    expect(ing.status).toBe("pending");
    expect(ing.parsed.data.room_name).toBe("Garden Cottage");
    const card = (await ok("prachi", "GET", "/api/inbox?status=pending")).items.find((i: any) => i.id === ing.id);
    expect(card.room_options.length).toBe(4); expect(card.suggested_room_ids).toEqual([]);
    // Sales books it by hand in Reservations, naming the email: the card is marked done with the booking.
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Test Test", guest_phone: "9920031314", check_in: "2027-03-20", check_out: "2027-03-21", channel_code: "direct", external_ref: "1060900000105133", rooms: [{ room_id: "loc_r4", nightly_rate_paise: 700000 }], inbox_item_id: ing.id });
    const after = (await sql("SELECT status, booking_id FROM inbox_items WHERE id = ?", ing.id))[0];
    expect(after).toMatchObject({ status: "approved", booking_id: b.booking.id });
    expect((await ok("prachi", "GET", "/api/inbox?status=pending")).items.find((i: any) => i.id === ing.id)).toBeUndefined();
  });

  it("a cancelled confirmation releases the stay", async () => {
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@mybookingsite.io", subject: "(Cancelled) Anita Menon Reservation No:1060900000105200-The Meadows Varkala", html: html("1060900000105200", "Anita Menon", "Premium Lawn View", "12 Feb 2027", "14 Feb 2027", "13,650.00").replace("<tr><td>Confirmed</td></tr>", "<tr><td>Cancelled</td></tr>") });
    expect(ing.parsed.kind).toBe("cancellation");
    expect(ing.status).toBe("approved"); expect(ing.auto.what).toBe("cancelled");
    expect((await sql("SELECT status FROM bookings WHERE external_ref = '1060900000105200'"))[0].status).toBe("cancelled");
  });
});

describe("booking engine · room line with the amount on the same line", () => {
  it("drops the INR amount from the room name", async () => {
    const { parseInboundEmail } = await import("../src/email/parsers");
    const r = parseInboundEmail("noreply@mybookingsite.io", "(Confirmed) X Y Reservation No:1060900000105310-The Meadows Varkala", undefined,
      "Booking Confirmation\nBooking ID\n1060900000105310\nConfirmed\nGuest Information\nX Y\nx@example.com\n+91 09920031314\nThank you for booking with us.\nPremium Lawn View -\nCheck-in\n28 Oct 2026\nCheck-out\n29 Oct 2026\nX Y · 2 adults\nTotal\nINR 1.00\nRooms\nPremium Lawn View INR 1.00\nSub Total\nINR 1.00\nTotal\nINR 1.00\nAmount Paid\nINR 0.00");
    expect(r.data.room_name).toBe("Premium Lawn View"); expect(r.data.rooms).toBe(1); expect(r.data.check_in).toBe("2026-10-28");
  });
});

describe("booking engine · whole villa", () => {
  beforeAll(seed);
  const villaMail = (id: string, ci: string, co: string, total: string) => ({ from: "noreply@mybookingsite.io", subject: `(Confirmed) Full House Reservation No:${id}-The Meadows Varkala`, text: `Booking Confirmation\nBooking ID\n${id}\nConfirmed\nGuest Information\nFull House\nfh@example.com\n+91 09920031314\nThank you for booking with us.\nVilla -\nCheck-in\n${ci}\nCheck-out\n${co}\nFull House · 8 adults\nTotal\nINR ${total}\nRooms\nVilla INR ${total}\nSub Total\nINR ${total}\nTotal\nINR ${total}\nAmount Paid\nINR 0.00` });
  it("'Villa' means every room: all four are booked under one stay at the total split per room-night", async () => {
    // 2 nights × 4 rooms; ₹2,00,000 incl. → ₹25,000 per room-night ex-GST on the unregistered seed (above tariff → approves itself)
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", villaMail("1060900000106001", "10 Apr 2027", "12 Apr 2027", "2,00,000.00"));
    expect(ing.parsed.data.room_name).toBe("Villa");
    expect(ing.status).toBe("approved"); expect(ing.auto.what).toBe("booked");
    const rooms = await sql("SELECT room_id, nightly_rate_paise FROM booking_rooms WHERE booking_id = ? ORDER BY room_id", ing.booking_id);
    expect(rooms.map((r: any) => r.room_id)).toEqual(["loc_r1", "loc_r2", "loc_r3", "loc_r4"]);
    expect(rooms[0].nightly_rate_paise).toBe(2500000);
    expect((await sql("SELECT COUNT(*) AS n FROM room_nights WHERE booking_id = ?", ing.booking_id))[0].n).toBe(8);
  });
  it("when one room is already taken the villa waits with every room shown and the reason", async () => {
    await ok("prachi", "POST", "/api/bookings", { guest_name: "In The Way", guest_phone: "9600000001", check_in: "2027-05-01", check_out: "2027-05-02", rooms: [{ room_id: "loc_r3", nightly_rate_paise: 550000 }] });
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", villaMail("1060900000106002", "01 May 2027", "02 May 2027", "80,000.00"));
    expect(ing.status).toBe("pending"); expect(ing.auto.note).toMatch(/whole villa .* 3 of 4/);
    const card = (await ok("prachi", "GET", "/api/inbox?status=pending")).items.find((i: any) => i.id === ing.id);
    expect(card.room_options.filter((o: any) => o.matches_type)).toHaveLength(4);
    expect(card.suggested_room_ids.sort()).toEqual(["loc_r1", "loc_r2", "loc_r4"]);
    expect(card.nightly_rate_paise).toBe(2000000);
  });
});

describe("booking engine · cancellation of a stay still awaiting approval", () => {
  beforeAll(seed);
  it("closes the pending rate approval along with the booking", async () => {
    const mail = (status: string) => ({ from: "noreply@mybookingsite.io", subject: `(${status}) Low Rate Reservation No:1060900000107001-The Meadows Varkala`, text: `Booking Confirmation\nBooking ID\n1060900000107001\n${status}\nGuest Information\nLow Rate\nlr@example.com\n+91 09920031314\nThank you for booking with us.\nPremium Lawn View -\nCheck-in\n15 Jun 2027\nCheck-out\n16 Jun 2027\nLow Rate · 2 adults\nTotal\nINR 1.00\nRooms\nPremium Lawn View INR 1.00\nSub Total\nINR 1.00\nTotal\nINR 1.00\nAmount Paid\nINR 0.00` });
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", mail("Confirmed"));
    expect(ing.status).toBe("approved");
    expect((await sql("SELECT status FROM bookings WHERE id = ?", ing.booking_id))[0].status).toBe("provisional");
    expect((await sql("SELECT status FROM approvals WHERE kind = 'booking' AND ref_id = ?", ing.booking_id))[0].status).toBe("pending");
    const canc = await ok("prachi", "POST", "/api/inbox/ingest", mail("Cancelled"));
    expect(canc.auto.what).toBe("cancelled");
    expect((await sql("SELECT status FROM bookings WHERE id = ?", ing.booking_id))[0].status).toBe("cancelled");
    const apr = (await sql("SELECT status, note FROM approvals WHERE kind = 'booking' AND ref_id = ?", ing.booking_id))[0];
    expect(apr.status).toBe("returned"); expect(apr.note).toMatch(/booking cancelled/);
    expect((await ok("trupti", "GET", "/api/work")).items.find((i: any) => i.key === `approval:${ing.booking_id}`)).toBeUndefined();
    expect((await ok("trupti", "GET", "/api/approvals")).approvals.find((a: any) => a.ref_id === ing.booking_id)).toBeUndefined();
  });
});
