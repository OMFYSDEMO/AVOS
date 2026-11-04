import { rupeesToPaise } from "../domain/money";
import { parseLooseDate } from "../domain/dates";

export const PARSER_VERSION = "2026-11-05c";

/** "Villa", "Entire villa", "Whole villa", "Full villa": the booking engine's name for all rooms together. */
export const isWholeVilla = (roomName: unknown) => /^(the\s+)?(entire|whole|full|complete|exclusive)?\s*villa\b/i.test(String(roomName ?? "").trim());

export interface ParsedEmail {
  source: "staah" | "swiftbook" | "airpay" | "bookingengine" | "staahmax" | "yatra" | "bank" | "unknown";
  kind: "new_reservation" | "modification" | "cancellation" | "payment" | "payment_request" | "bank_alert" | "channel_alert" | "unknown";
  external_ref: string | null;
  data: Record<string, unknown>;
  confidence: "high" | "low";
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function textOf(html: string | undefined, text: string | undefined): string {
  const fromHtml = html ? htmlText(html) : "";
  // Some senders (Airpay's own receipts) carry a stub plain-text part ("view this email in a browser") beside the
  // real HTML: when the text part is short and the HTML says much more, read the HTML first.
  if (text && text.trim()) return fromHtml && text.trim().length < 600 && fromHtml.trim().length > text.trim().length * 2 ? `${fromHtml}\n\n${text}` : text;
  return fromHtml;
}

function htmlText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&zwnj;|&zwj;|&#8204;|&#8205;|\u200c|\u200d/g, "").replace(/&middot;|&#183;/g, "·").replace(/&rarr;|&#8594;/g, "→").replace(/&mdash;|&#8212;/g, "—").replace(/&bull;|&#8226;/g, "•").replace(/&amp;/g, "&").replace(/&rsquo;|&#8217;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ");
}

function grab(body: string, re: RegExp): string | null {
  const m = body.match(re);
  return m ? clean(m[1]) : null;
}

/** "Fwd: Fwd: subject" → "subject". */
export function stripForwardPrefixes(subject: string): string {
  let s = subject.trim();
  for (;;) { const t = s.replace(/^\s*(?:fwd?|fw|re)\s*:\s*/i, ""); if (t === s) return s; s = t; }
}

/** A Gmail/Outlook forward carries the sender's signature first; the notification sits after the "Forwarded message" marker. */
export function forwardedPart(body: string): string {
  const parts = body.split(/[-=_]{3,}\s*Forwarded message\s*[-=_]{3,}/i);
  return parts.length > 1 ? parts[parts.length - 1] : body;
}

/** Amount after a label, e.g. "Room Total : INR 11,704.50" or "Total: ₹6,000". */
function money(body: string, label: string): string | null {
  return grab(body, new RegExp(label + "\\s*:?\\s*(?:₹|INR|Rs\\.?)?\\s*([\\d,]+(?:\\.\\d+)?)", "i"));
}

const DATE = "[0-9]{1,2}[\\/-][0-9]{1,2}[\\/-][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|\\d{1,2} [A-Za-z]{3,}(?: \\d{4})?";

export interface StaahRoom { name: string; full: string; count: number; adults: number | null; children: number | null; amount_paise: number | null }

/**
 * The rooms a STAAH email books. The table repeats one block per room type (ROOM TYPE, NO OF ROOMS, the dates, then a
 * row per night ending in its AMOUNT, then add-ons and taxes), so a Superior + Deluxe booking carries two blocks.
 * amount_paise is the sum of that block's nightly amounts: inclusive of GST on Booking.com, ex-GST on Goibibo, so it
 * is used only as each room's share of the email's Room Total.
 */
export function staahRooms(body: string): StaahRoom[] {
  const starts = [...body.matchAll(/^[ \t]*ROOM TYPE\b/gim)].map((m) => m.index!);
  if (!starts.length) return [];
  const tail = body.search(/Additional Information|Payment Type\s*:|Room Total\s*:/i);
  return starts.map((start, i) => {
    const stop = i + 1 < starts.length ? starts[i + 1] : tail > start ? tail : body.length;
    const block = body.slice(start, stop);
    const full = grab(block, /ROOM TYPE\s*\n?\s*([^\n]+)/i) ?? "";
    const nightsPart = block.slice(Math.max(0, block.search(/\bDATE\b/)), (() => { const k = block.search(/Add ons|\bTaxes\b|Special Request|Cancellation Policy/i); return k > 0 ? k : block.length; })());
    const amounts = [...nightsPart.matchAll(/(?:\bINR|₹|\bRs\.?)\s*([\d,]+(?:\.\d+)?)/gi)].map((m) => rupeesToPaise(m[1]));
    return {
      name: full.split(/\s+-\s+|\s*\(/)[0].trim(), full,
      count: Number(grab(block, /NO\.? OF ROOMS\s*\n?\s*(\d+)/i) ?? "1") || 1,
      adults: Number(grab(block, /ADULTS\s*\n?\s*(\d+)/i) ?? "") || null,
      children: ((c) => c === null ? null : Number(c))(grab(block, /CHILDREN\s*\n?\s*(\d+)/i)),
      amount_paise: amounts.length ? amounts.reduce((a, b) => a + b, 0) : null,
    };
  }).filter((r) => r.name);
}

/**
 * STAAH channel-manager notification ("New Reservation Goibibo for kumar Reservation No:0190589681 (1060900000001400)").
 * The body is a label-above-value table: CHANNEL NAME, BOOKING ID# <ota ref> (<staah ref>), ROOM TYPE, NO OF ROOMS,
 * CHECK-IN, CHECK-OUT, GUEST NAME, ADULTS, CHILDREN, then Payment Type / Commission / Room Total / Total Taxes / Total.
 * Older "Label: value" layouts are still read.
 */
export function parseStaah(rawSubject: string, body: string, year: number): ParsedEmail {
  const subject = stripForwardPrefixes(rawSubject);
  const cancelled = /cancel/i.test(subject) || /Bookings?\s*Status\s*:?\s*Cancel/i.test(body);
  const kind: ParsedEmail["kind"] = cancelled ? "cancellation" : /modif|amend|change/i.test(subject) ? "modification" : /new|reservation|booking/i.test(subject) ? "new_reservation" : "unknown";
  const channel = grab(body, /Channel Name\s*:?\s*([A-Za-z.\- ]+?)\s*(?:\n|Bookings?\s*Status|$)/i)
    ?? grab(subject, /(?:New|Modified|Amended|Cancelled|Cancel)\s+(?:Reservation|Booking)\s+([A-Za-z.\-]+)\s+for/i)
    ?? grab(body, /(?:Channel|Source|OTA)\s*:?\s*([A-Za-z.\- ]+?)(?:\n|Ref|Guest|$)/i)
    ?? grab(subject, /(Booking\.com|Agoda|Expedia|MakeMyTrip|Goibibo|Airbnb|Cleartrip|Yatra)/i);
  // Booking Id#: <OTA reference> (<STAAH reservation id>). The STAAH id is the one that stays stable across OTAs.
  const ids = body.match(/Booking\s*Id#?\s*:?\s*([A-Za-z0-9\-]+)\s*\(([A-Za-z0-9\-]{6,})\)/i) ?? subject.match(/Reservation\s*No\.?\s*:?\s*([A-Za-z0-9\-]+)\s*\(([A-Za-z0-9\-]{6,})\)/i);
  // The subject and the body list the two ids in opposite orders; the STAAH id is the long all-digit one (16 digits).
  const pair = ids ? [ids[1], ids[2]] : null;
  const ref = pair ? (pair.find((x) => /^\d{14,}$/.test(x)) ?? pair[1]) : grab(body, /(?:Ref(?:erence)?|Reservation (?:ID|No\.?)|Booking (?:ID|No\.?))\s*:?\s*#?\s*([0-9]{6,})/i);
  const otaRef = pair ? (pair.find((x) => x !== ref) ?? null) : null;
  const guest = grab(body, /GUEST NAME\s*\n?\s*([^\n]+)/i) ?? grab(body, /CONTACT NAME\s*\n?\s*([^\n]+)/i) ?? grab(body, /Guest(?: Name)?\s*:?\s*([^\n·]+?)(?:\s*·|\n|$)/i) ?? grab(subject, /for\s+(.+?)\s+Reservation\s*No/i);
  const roomFull = grab(body, /ROOM TYPE\s*\n?\s*([^\n]+)/i) ?? grab(body, /Room(?: Type)?\s*:?\s*([A-Za-z][A-Za-z ]*?)\s*(?:×|x|\n|·)/i);
  const room = roomFull ? roomFull.split(/\s+-\s+|\s*\(/)[0].trim() : null;
  const roomTypes = staahRooms(body);
  const roomsN = roomTypes.length > 1 ? roomTypes.reduce((n, r) => n + r.count, 0) : Number(grab(body, /NO\.? OF ROOMS\s*\n?\s*(\d+)/i) ?? grab(body, /(?:×|x)\s*(\d+)/) ?? "1");
  const sumOf = (k: "adults" | "children") => roomTypes.every((r) => r[k] !== null) ? roomTypes.reduce((n, r) => n + (r[k] ?? 0), 0) : null;
  const nightsN = Number(grab(body, /NO\.? OF NIGHTS\s*\n?\s*(\d+)/i) ?? "0") || null;
  const ci = grab(body, new RegExp("Check[- ]?in\\s*:?\\s*(" + DATE + ")", "i"));
  const co = grab(body, new RegExp("Check[- ]?out\\s*:?\\s*(" + DATE + ")", "i"));
  let checkIn = ci ? parseLooseDate(ci, year) : null, checkOut = co ? parseLooseDate(co, year) : null;
  if (!checkIn || !checkOut) {
    const dates = body.match(/(\d{1,2}(?:\s+[A-Za-z]{3,})?)\s*(?:→|->|to|–|-)\s*(\d{1,2}\s+[A-Za-z]{3,}(?:\s+\d{4})?)/);
    if (dates) { checkOut = parseLooseDate(dates[2], year); checkIn = parseLooseDate(/[A-Za-z]/.test(dates[1]) ? dates[1] : `${dates[1]} ${dates[2].split(" ").slice(1).join(" ")}`, year); }
  }
  const roomTotal = money(body, "Room Total") ?? money(body, "Total(?: Amount)?");
  const taxes = money(body, "Total Taxes");
  const totalIncl = money(body, "Total \\(All Inclusive\\)");
  const commissionPct = grab(body, /Commission\s*:?\s*([\d.]+)\s*%/i);
  const commissionAmt = commissionPct ? null : money(body, "Commission");
  const collect = /channel collect|prepaid|paid online|virtual card/i.test(body) ? "channel_collect" : /hotel collect|pay at (?:hotel|property)/i.test(body) ? "hotel_collect" : null;
  const data = {
    channel, ota_ref: otaRef, vendor: grab(body, /VendorName\s*::?\s*([A-Za-z.\- ]+?)\s*(?:,|\n|$)/i), guest_name: guest, room_name: room, room_name_full: roomFull, rooms: roomsN, nights: nightsN,
    // Several room types: every one is listed, with its count and its share of the price.
    room_types: roomTypes.length > 1 ? roomTypes : undefined,
    adults: (roomTypes.length > 1 ? sumOf("adults") : null) ?? (Number(grab(body, /ADULTS\s*\n?\s*(\d+)/i) ?? "0") || null),
    children: (roomTypes.length > 1 ? sumOf("children") || null : null) ?? (Number(grab(body, /CHILDREN\s*\n?\s*(\d+)/i) ?? "0") || null),
    check_in: checkIn, check_out: checkOut,
    room_total_paise: roomTotal ? rupeesToPaise(roomTotal) : null, room_total_is_ex_gst: taxes !== null || /ex[- ]?GST|excl/i.test(body),
    taxes_paise: taxes ? rupeesToPaise(taxes) : null, total_incl_gst_paise: totalIncl ? rupeesToPaise(totalIncl) : null,
    commission_bp: commissionPct ? Math.round(Number(commissionPct) * 100) : null, commission_paise: commissionAmt ? rupeesToPaise(commissionAmt) : null,
    collection_type: collect, status_text: grab(body, /Bookings?\s*Status\s*:?\s*([A-Za-z ]+?)\s*(?:\n|$)/i),
  };
  const confidence = guest && checkIn && checkOut && (kind === "cancellation" || data.room_total_paise !== null) ? "high" : "low";
  return { source: "staah", kind, external_ref: ref, data, confidence };
}

/** SwiftBook (direct website booking engine) confirmation. */
export function parseSwiftbook(subject: string, body: string, year: number): ParsedEmail {
  const kind: ParsedEmail["kind"] = /cancel/i.test(subject) ? "cancellation" : "new_reservation";
  const guest = grab(body, /Guest(?: Name)?\s*:?\s*([^\n·]+?)(?:\s*·|\n|$)/i);
  const itin = grab(body, /Itinerary(?: (?:No|Number|ID))?\.?\s*:?\s*#?\s*([0-9]{6,})/i) ?? grab(body, /Booking (?:ID|No\.?)\s*:?\s*#?\s*([0-9]{6,})/i);
  const rooms = Number(grab(body, /(\d+)\s*rooms?/i) ?? "1");
  const nights = Number(grab(body, /(\d+)\s*nights?/i) ?? "1");
  const rate = grab(body, /@\s*₹?\s*([\d,]+\.?\d*)\s*\/\s*night/i);
  const total = grab(body, /Total\s*:?\s*₹?\s*([\d,]+\.?\d*)/i);
  const ci = grab(body, /Check[- ]?in\s*:?\s*([0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|\d{1,2} [A-Za-z]{3,}(?: \d{4})?)/i);
  const co = grab(body, /Check[- ]?out\s*:?\s*([0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|\d{1,2} [A-Za-z]{3,}(?: \d{4})?)/i);
  const payOnline = /pay online|paid online|payment received/i.test(body);
  const data = { guest_name: guest, rooms, nights, nightly_rate_paise: rate ? rupeesToPaise(rate) : null, total_incl_gst_paise: total ? rupeesToPaise(total) : null,
    check_in: ci ? parseLooseDate(ci, year) : null, check_out: co ? parseLooseDate(co, year) : null, pay_online: payOnline, room_name: grab(body, /Room(?: Type)?\s*:?\s*([A-Za-z][A-Za-z ]*?)\s*(?:×|x|\n|·)/i) };
  const confidence = guest && itin && data.check_in && data.check_out ? "high" : "low";
  return { source: "swiftbook", kind, external_ref: itin, data, confidence };
}

/**
 * STAAH booking engine (mybookingsite.io) "Booking Confirmation": a direct booking made on the hotel's own
 * website. Subject "(Confirmed) <guest> Reservation No:<id>-<hotel>"; body carries Booking ID, guest name,
 * email and phone, the room type, check-in/out as "21 Oct 2026", "<guest> · 2 adults", Total and Amount Paid.
 * Channel is Direct; any online payment arrives separately as an Airpay email.
 */
export function parseBookingEngine(subject: string, body: string, year: number): ParsedEmail {
  const status = (subject.match(/^\s*\((Confirmed|Cancelled|Canceled|Modified|Amended)\)/i)?.[1] ?? grab(body, /Booking ID\s*\n?\s*[0-9]{6,}\s*\n?\s*(Confirmed|Cancelled|Canceled|Modified)/i) ?? "").toLowerCase();
  const kind: ParsedEmail["kind"] = /cancel/.test(status) || /cancel/i.test(subject) ? "cancellation" : /modif|amend/.test(status) ? "modification" : "new_reservation";
  const ref = grab(subject, /Reservation\s*No\.?\s*:?\s*([0-9]{6,})/i) ?? grab(body, /Booking ID\s*\n?\s*([0-9]{6,})/i);
  const guest = grab(subject, /^\s*\([A-Za-z]+\)\s*(.+?)\s+Reservation\s*No/i) ?? grab(body, /Guest Information\s*\n?\s*([^\n]+)/i);
  const email = grab(body, /Guest Information[\s\S]{0,200}?([\w.+-]+@[\w-]+\.[\w.-]+)/i);
  const phone = grab(body, /Guest Information[\s\S]{0,260}?(\+?[0-9][0-9 \-]{8,}[0-9])/i);
  const dateRe = /(\d{1,2}\s*[A-Za-z]{3,9}\.?,?\s*\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/;
  const ci = grab(body, new RegExp("Check[- ]?in\\s*\\n?\\s*" + dateRe.source, "i"));
  const co = grab(body, new RegExp("Check[- ]?out\\s*\\n?\\s*" + dateRe.source, "i"));
  const adults = grab(body, /(\d+)\s*adults?/i);
  const children = grab(body, /(\d+)\s*child(?:ren)?/i);
  // Room types are listed under "Rooms" each followed by an INR amount; the first "<Room> -" line names the type.
  const roomsBlock = body.match(/\n\s*Rooms\s*\n([\s\S]*?)\n\s*Sub\s*Total/i)?.[1] ?? "";
  const roomLines = roomsBlock.split(/\n|(?=INR\s*[\d,]+)/).map((l) => l.replace(/^\s*INR\s*[\d,]+\.?\d*\s*/i, "").trim()).filter((l) => l && !/^INR/i.test(l) && !/^[\d,.\s]+$/.test(l));
  const roomName = roomLines[0] ?? grab(body, /Thank you for booking with us\.?\s*\n?\s*([A-Za-z][^\n-]{2,40}?)\s*-\s*\n/i);
  // Each room line carries its own "Total"; the booking's total is the last one, after "Sub Total".
  const totals = [...body.matchAll(/\n\s*Total\s*\n?\s*INR\s*([\d,]+\.?\d*)/gi)];
  const total = totals.length ? clean(totals[totals.length - 1][1]) : null;
  const paid = grab(body, /Amount Paid\s*\n?\s*INR\s*([\d,]+\.?\d*)/i);
  const data = {
    channel: "Direct", collection_type: "direct", vendor: "booking engine", status_text: status || null,
    guest_name: guest, guest_email: email, guest_phone: phone, room_name: roomName ? clean(roomName).replace(/\s*INR\s*[\d,]+\.?\d*\s*$/i, "").trim() || null : null, rooms: Math.max(1, roomLines.length || 1),
    adults: adults ? Number(adults) : null, children: children ? Number(children) : null,
    check_in: ci ? parseLooseDate(ci.replace(/,/g, ""), year) : null, check_out: co ? parseLooseDate(co.replace(/,/g, ""), year) : null,
    total_incl_gst_paise: total ? rupeesToPaise(total) : null, amount_paid_paise: paid ? rupeesToPaise(paid) : null,
  };
  const confidence = guest && ref && data.check_in && data.check_out && (kind === "cancellation" || data.total_incl_gst_paise !== null) ? "high" : "low";
  return { source: "bookingengine", kind, external_ref: ref, data, confidence };
}

/**
 * Bank transaction alert (IDFC FIRST): "Your A/C XXXXXXX3390 has been credited with INR 32,729.33 on 21-10-2026
 * 17:02:09 vide NEFT payment reference CMS2942643026507 received from AIRPAY PAYMENT SERVICES PRIVATE . New balance is
 * INR 503,881.33." Debits read "has been debited with INR ... towards/to <party>". One alert = one statement line.
 */
export function parseBankAlert(subject: string, body: string): ParsedEmail {
  const flat = body.replace(/\s+/g, " ");
  // IDFC's follow-up to a transfer out: "Your beneficiary TEST PAYEE has received ₹1,234.00 on 03-11-2027
  // transferred via NEFT UTR IDFB0000T0000001." The money left on its own debit alert; this only confirms it arrived.
  const ben = flat.match(/Your beneficiary\s+(.+?)\s+has received\s+(?:INR|Rs\.?|₹)\s*([\d,]+\.?\d*)\s+on\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})(?:\s+transferred)?(?:\s+via\s+([A-Za-z]+))?(?:\s+UTR\s+([A-Za-z0-9]+))?/i);
  if (ben) return { source: "bank", kind: "bank_alert", external_ref: ben[5] ?? null, data: { bank: "IDFC FIRST", beneficiary_confirmation: true, counterparty: clean(ben[1]), amount_paise: rupeesToPaise(ben[2]), on_date: parseLooseDate(ben[3], new Date().getUTCFullYear()), method: ben[4] ?? null, reference: ben[5] ?? null }, confidence: "high" };
  // Read only the alert itself, from "Your A/C …" to the sign-off. The bank's disclaimer underneath
  // ("…links of look-alike websites to mislead into entering sensitive information") must never be read
  // as a payee, and a plain credit alert carries no payer, method or reference at all.
  const start = flat.search(/A\/C\s*(?:No\.?\s*)?[Xx*]*\d{3,6}\s+has been/i);
  const tail = start >= 0 ? flat.slice(start) : flat;
  const stop = tail.search(/Always You First|This is an auto[- ]?generated|\bDisclaimer\b|Team IDFC/i);
  const alertText = stop >= 0 ? tail.slice(0, stop) : tail;
  const m = alertText.match(/A\/C\s*(?:No\.?\s*)?[Xx*]*(\d{3,6})\s+has been\s+(credited|debited)\s+(?:with|by)\s+(?:INR|Rs\.?|₹)\s*([\d,]+\.?\d*)\s+on\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/i);
  const method = alertText.match(/vide\s+([A-Za-z\/]+)\s+(?:payment\s+)?reference/i)?.[1] ?? alertText.match(/\b(NEFT|IMPS|RTGS|UPI|ACH|NACH|ECS|CMS)\b/i)?.[1] ?? null;
  const reference = alertText.match(/reference\s*(?:no\.?|number|#)?\s*:?\s*([A-Za-z0-9\-\/]{6,})/i)?.[1] ?? null;
  const counterparty = alertText.match(/received from\s+(.+?)\s*\.(?:\s|$)/i)?.[1]?.trim() ?? alertText.match(/\b(?:towards|paid to|to|at)\s+(.+?)\s*\.(?:\s|$)/i)?.[1]?.trim() ?? null;
  const balance = alertText.match(/(?:New|Available|Closing)\s+balance\s+is\s+(?:INR|Rs\.?|₹)\s*([\d,]+\.?\d*)/i)?.[1] ?? null;
  const bank = /idfc/i.test(subject + " " + flat) ? "IDFC FIRST" : flat.match(/Greetings from\s+([A-Z][A-Za-z ]+Bank)/)?.[1] ?? null;
  const onDate = m ? parseLooseDate(m[4], new Date().getUTCFullYear()) : null;
  const data = {
    bank, account_last: m?.[1] ?? null, direction: m ? (m[2].toLowerCase() as "credited" | "debited") : null,
    amount_paise: m ? rupeesToPaise(m[3]) : null, on_date: onDate, at_time: m?.[5] ?? null, method: method ? method.toUpperCase() : null, reference, counterparty,
    balance_paise: balance ? rupeesToPaise(balance) : null,
  };
  const confidence = m && onDate && data.amount_paise ? "high" : "low";
  return { source: "bank", kind: "bank_alert", external_ref: reference, data, confidence };
}

/** Airpay payment-gateway "transaction successful" email → routes to the Payments screen, never the booking inbox. */
export function parseAirpay(subject: string, body: string): ParsedEmail {
  // A payment link the desk makes by hand carries a short order id (1106441); the website's are long.
  const order = grab(body, /Order(?: (?:ID|No\.?))?\s*:?\s*#?\s*([0-9]{5,})/i) ?? grab(subject, /Order ID\s*([0-9]{5,})/i) ?? grab(subject, /([0-9]{10,})/);
  // Airpay's receipt lays labels above values: "Order Amount / INR 20000.00", "Billed Amount", "Airpay Id / 2091754834".
  const money = "(?:INR|Rs\\.?|₹)?\\s*₹?\\s*([\\d,]+\\.?\\d*)";
  const amount = grab(body, new RegExp(`Order Amount\\s*:?\\s*${money}`, "i")) ?? grab(body, new RegExp(`Billed Amount\\s*:?\\s*${money}`, "i"))
    ?? grab(body, /(?:INR|Rs\.?|₹)\s*([\d,]+\.?\d*)\s*Collected Successfully/i) ?? grab(body, new RegExp(`(?:Amount|₹)\\s*:?\\s*${money}`, "i"));
  const airpayId = grab(body, /Airpay\s*Id\s*:?\s*([0-9]{6,})/i);
  // Labels start their line ("Customer Name<tab>KISHORE KS"); a name that contains "payer" must not read as the label.
  const payer = grab(body, /(?:^|\n)[ \t]*Payer Name[ \t]*:?[ \t]*\n?[ \t]*([^\n]+)/i) ?? grab(body, /(?:^|\n)[ \t]*Customer Name[ \t]*:?[ \t]*\n?[ \t]*([^\n]+)/i) ?? grab(body, /(?:^|\n)[ \t]*(?:Payer|Customer)[ \t]*:[ \t]*([^\n]+)/i);
  // Paid only when Airpay says so in its own words, and never when it reports a failed, declined or pending attempt
  // ("Unsuccessful" contains "success").
  const failed = /unsuccessful|\bfail(?:ed|ure)?\b|declined|\baborted\b|\bpending\b|\bcancell?ed\b|\brejected\b/i.test(`${subject}\n${body.slice(0, 1500)}`);
  const success = !failed && /Transaction is Successful|Transaction Successful|Collected Successfully|Payment (?:is )?Successful|Payment Received Successfully/i.test(`${subject}\n${body}`);
  const payerMobile = grab(body, /Mobile(?: No\.?)?\s*:?\s*\+?([0-9]{10,13})/i);
  const payerEmail = grab(body, /Email(?: Id)?\s*:?\s*([\w.+-]+@[\w-]+\.[\w.-]+)/i);
  const data = { order_id: order, airpay_id: airpayId, amount_paise: amount ? rupeesToPaise(amount) : null, payer_name: payer, payer_mobile: payerMobile, payer_email: payerEmail, success };
  return { source: "airpay", kind: "payment", external_ref: order, data, confidence: order && data.amount_paise && success ? "high" : "low" };
}

/**
 * When the notification itself was sent, from the header block a forward carries ("Date: Mon, 26 Oct 2026 14:02:05
 * +0530", Gmail's "Date: Sun, 25 Oct 2026 at 13:26"). A receipt forwarded a day late is still dated the day it was paid.
 */
export function forwardedSentAt(whole: string): string | null {
  const m = whole.match(/Forwarded message[^\n]*\n[\s\S]{0,800}?\bDate\s*:\s*([^\n]+)/i);
  if (!m) return null;
  const t = Date.parse(m[1].replace(/\s+at\s+/i, " ").replace(/\s*\(.*\)\s*$/, "").trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * STAAH Max online-payment request ("Payment link - reference 10609000001061952136"): the property sent the guest a
 * payment link. The reference is the booking reference plus four digits, the same form as Airpay's order id, so the
 * link, the payment confirmation and Airpay's receipt all point at one booking. A request is not money: it is filed.
 */
export function parseStaahMaxRequest(subject: string, body: string, year: number): ParsedEmail {
  const order = grab(body, /Reference\s*:?\s*([0-9]{18,})/i) ?? grab(subject, /reference\s*([0-9]{18,})/i);
  const bookingRef = grab(body, /Booking Reference\s*:?\s*([0-9]{10,17})\b/i);
  const guest = grab(body, /Guest Name\s*:?\s*([^\n]+)/i) ?? grab(body, /Dear\s+([^,\n]+),/i);
  const due = grab(body, /Amount Due\s*:?\s*(?:INR|Rs\.?|₹)?\s*([\d,]+\.?\d*)/i);
  const stay = body.match(/Stay Info\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})\s+to\s+(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/i);
  const expires = grab(body, /link expires on\s*([0-9]{1,2}-[A-Za-z]{3}-[0-9]{4}(?:\s+[0-9:]+)?)/i);
  const data = {
    order_id: order, booking_ref: bookingRef ?? (order && order.length > 16 ? order.slice(0, 16) : null), guest_name: guest,
    amount_due_paise: due ? rupeesToPaise(due) : null,
    check_in: stay ? parseLooseDate(stay[1], year) : null, check_out: stay ? parseLooseDate(stay[2], year) : null, link_expires: expires,
  };
  return { source: "staahmax", kind: "payment_request", external_ref: order, data, confidence: order ? "high" : "low" };
}

/**
 * STAAH Max online payment received ("You have received payment through STAAH Max Online Payment of INR 10"). The
 * reference is the order id the payment went through (booking reference + four digits, as on Airpay's receipt), so
 * the payment is recorded under it and Airpay's receipt for the same order is then a duplicate, whichever comes first.
 */
export function parseStaahMaxPayment(subject: string, body: string): ParsedEmail {
  const order = grab(body, /Reference\s*:?\s*([0-9]{14,})/i);
  const bookingRef = grab(body, /Booking Reference\s*:?\s*([0-9]{10,17})\b/i);
  const paid = grab(body, /Amount Paid\s*:?\s*(?:INR|Rs\.?|₹)?\s*([\d,]+\.?\d*)/i) ?? grab(body, /Online Payment of\s*(?:INR|Rs\.?|₹)\s*([\d,]+\.?\d*)/i);
  const failed = /unsuccessful|\bfail(?:ed|ure)?\b|declined|\bpending\b|\bcancell?ed\b|\brejected\b/i.test(`${subject}\n${body.slice(0, 600)}`);
  const data = {
    order_id: order, booking_ref: bookingRef ?? (order && order.length > 16 ? order.slice(0, 16) : null),
    amount_paise: paid ? rupeesToPaise(paid) : null, payer_name: grab(body, /Guest Name\s*:?\s*([^\n]+)/i),
    payer_email: grab(body, /Email\s*:?\s*([\w.+-]+@[\w-]+\.[\w.-]+)/i), via: "STAAH Max Online Payment",
    success: !failed && /PAYMENT RECEIVED|You have received payment/i.test(`${subject}\n${body}`),
  };
  return { source: "staahmax", kind: "payment", external_ref: order, data, confidence: order && data.amount_paise && data.success ? "high" : "low" };
}

/**
 * Yatra (Travelguru) hotel voucher from donotreply@yatra.com: "VOUCHER NUMBER P0002595785", the stay, the room,
 * the tariff and Yatra's own payout sum (gross − commission incl. GST − TCS − TDS). Pre-pay: Yatra collects.
 * The voucher number is the OTA reference STAAH also carries, so either email finds a booking made from the other.
 */
export function parseYatra(subject: string, body: string, year: number): ParsedEmail {
  const cancelled = /cancel/i.test(subject) || /booking (?:has been |is )?cancell?ed/i.test(body);
  const kind: ParsedEmail["kind"] = cancelled ? "cancellation" : /amend|modif/i.test(subject) ? "modification" : "new_reservation";
  const voucher = grab(body, /VOUCHER NUMBER\s*:?\s*([A-Z0-9]{6,})/i) ?? grab(subject, /\b(P\d{8,})\b/);
  const amount = (label: string) => { const v = grab(body, new RegExp(label + "\\s*:?\\s*(?:INR|Rs\\.?|₹)?\\s*([\\d,]+(?:\\.\\d+)?)", "i")); return v ? rupeesToPaise(v) : null; };
  const ci = grab(body, /Check in date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/i), co = grab(body, /Check out date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/i);
  const roomName = grab(body, /Room Name\s*:?\s*([^\n]+)/i);
  const data = {
    channel: "Yatra", ota_ref: voucher, vendor: "Yatra (Travelguru)",
    guest_name: grab(body, /Name of Guest\s*:?\s*([^\n]+)/i), guest_email: grab(body, /Guest Email Address\s*:?\s*([\w.+-]+@[\w-]+\.[\w.-]+)/i),
    guest_phone: grab(body, /Guest Phone Number\s*:?\s*([+\d][\d \-]{7,})/i),
    room_name: roomName ? roomName.replace(/\s+room$/i, "").trim() : null, room_name_full: grab(body, /Type of room\s*:?\s*([^\n]+)/i),
    rooms: Number(grab(body, /Number of rooms\s*:?\s*(\d+)/i) ?? "1") || 1,
    nights: Number(grab(body, /Duration\(Nights\/Hours\)\s*:?\s*(\d+)/i) ?? "0") || null,
    adults: Number(grab(body, /Adults\s*:?\s*(\d+)/i) ?? "0") || null, children: Number(grab(body, /Children\s*:?\s*(\d+)/i) ?? "0") || null,
    check_in: ci ? parseLooseDate(ci, year) : null, check_out: co ? parseLooseDate(co, year) : null,
    room_total_paise: amount("Total Room Charges"), room_total_is_ex_gst: true, taxes_paise: amount("Other Charges"),
    total_incl_gst_paise: amount("\\(A\\) Hotel Gross Charges") ?? amount("Hotel Gross Charges"),
    commission_paise: amount("Yatra \\(Travelguru\\) Commission"), commission_gst_paise: amount("GST @ 18%[^\\n]*?\\)"),
    tcs_paise: amount("\\(C\\) TCS[^\\n]*?\\)"), tds_paise: amount("\\(D\\) TDS[^\\n]*?194 ?O"),
    payout_paise: amount("to pay Hotel \\(A - B - C - D\\)"),
    collection_type: /PRE-?PAY/i.test(body) ? "channel_collect" : /pay at hotel|hotel collect/i.test(body) ? "hotel_collect" : "channel_collect",
    status_text: cancelled ? "Cancelled" : "Confirmed",
  };
  const confidence = voucher && data.guest_name && data.check_in && data.check_out && (kind === "cancellation" || data.room_total_paise !== null) ? "high" : "low";
  return { source: "yatra" as ParsedEmail["source"], kind, external_ref: voucher, data, confidence };
}

export function parseInboundEmail(from: string, rawSubject: string, html?: string, text?: string, now = new Date()): ParsedEmail {
  const whole = textOf(html, text);
  const body = forwardedPart(whole);          // a forwarded notification is read past the forwarder's signature
  const subject = stripForwardPrefixes(rawSubject);
  const year = now.getUTCFullYear();
  const f = from.toLowerCase();
  const fwdFrom = (body.match(/From\s*:\s*.*?([\w.+-]+@[\w-]+\.[\w.-]+)/i)?.[1] ?? "").toLowerCase();
  const looksStaah = f.includes("staah") || fwdFrom.includes("staah") || /staah/i.test(subject) || (/Channel Name\s*:/i.test(body) && /Booking\s*Id#?/i.test(body));
  const looksSwiftbook = f.includes("swiftbook") || fwdFrom.includes("swiftbook") || /swiftbook/i.test(subject) || /Itinerary(?: (?:No|Number|ID))?\.?\s*:?\s*#?\s*\d{6,}/i.test(body);
  // A Zoho forward hides the Airpay sender; the receipt's own "Airpay Id" line and airpay.co.in links still give it away.
  const looksAirpay = f.includes("airpay") || fwdFrom.includes("airpay") || /airpay/i.test(subject) || (/Airpay\s*Id/i.test(body) && /airpay\.co\.in/i.test(body));
  const looksBank = f.includes("idfcfirstbank") || fwdFrom.includes("idfcfirstbank") || /transaction alert from .*bank/i.test(subject) || (/has been (credited|debited) (with|by) (INR|Rs)/i.test(body) && /A\/C/i.test(body));
  // When a bank alert or a gateway receipt cannot be read, keep what the reader saw, so the layout can be taught.
  const seen = (r: ParsedEmail) => { if (r.confidence === "low") r.data.seen = { text_chars: (text ?? "").trim().length, html_chars: (html ?? "").length, preview: body.slice(0, 1500) }; return r; };
  if (looksBank) return seen(parseBankAlert(subject, body));
  // Yatra's own voucher (it also reaches us through STAAH; the shared voucher number keeps them one booking).
  if (f.includes("yatra.com") || fwdFrom.includes("yatra.com") || f.includes("travelguru") || (/VOUCHER NUMBER/i.test(body) && /Yatra \(Travelguru\)/i.test(body))) return parseYatra(subject, body, year);
  // STAAH Max payment received / payment request: sent from the booking engine's address, so they are told apart first.
  if (/received payment through STAAH Max/i.test(subject) || (/PAYMENT RECEIVED/.test(body) && /STAAH Max Online Payment/i.test(body))) return parseStaahMaxPayment(subject, body);
  if (/Payment link\s*-\s*reference/i.test(subject) || (/PAYMENT REQUEST/.test(body) && /Amount Due/i.test(body))) return parseStaahMaxRequest(subject, body, year);
  const looksEngine = f.includes("mybookingsite") || fwdFrom.includes("mybookingsite") || (/^\s*\((Confirmed|Cancelled|Canceled|Modified)\)/i.test(subject) && /Reservation\s*No/i.test(subject)) || (/Booking Confirmation/i.test(body) && /Booking ID/i.test(body) && /Guest Information/i.test(body));
  if (looksEngine) return parseBookingEngine(subject, body, year);
  // STAAH warning that an OTA sent a rate plan it has no mapping for: the booking still comes through, but the
  // channel manager may not have moved availability for it. It needs a person, with the reservation it is about.
  if (looksStaah && /Unmapped Rate Plan/i.test(subject)) {
    const ota = grab(subject, /-\s*([A-Za-z0-9]{6,})\s+Unmapped Rate Plan/i) ?? grab(body, /Reservation\s*(?:No\.?|Id|#)?\s*:?\s*([A-Za-z0-9]{6,})/i);
    return { source: "staah", kind: "channel_alert", external_ref: ota, data: { alert: "unmapped_rate_plan", ota_ref: ota, rate_plan: grab(body, /Rate\s*Plan\s*:?\s*([^\n]+)/i), channel: grab(body, /Channel(?: Name)?\s*:?\s*([^\n]+)/i) }, confidence: ota ? "high" : "low" };
  }
  if (looksStaah) return parseStaah(subject, body, year);
  if (looksSwiftbook) return parseSwiftbook(subject, body, year);
  if (looksAirpay) { const r = parseAirpay(subject, body); const sent = forwardedSentAt(whole); if (sent) r.data.sent_at = sent; return seen(r); }
  return { source: "unknown", kind: "unknown", external_ref: null, data: { preview: body.slice(0, 500) }, confidence: "low" };
}
