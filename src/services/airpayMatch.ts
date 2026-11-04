import { all } from "../db";
import { addDays, todayIn } from "../domain/dates";

/** A stay a gateway payment could be for, with how well it fits and why. */
export interface StayCandidate {
  id: string; guest_name: string; check_in: string; check_out: string; gross_paise: number; owing_paise: number; created_at: string;
  score: number; identity: "mobile" | "email" | "name" | "partial_name" | null; why: string[];
}

export interface PaymentClues {
  amount_paise?: number | null; payer_name?: string | null; payer_mobile?: string | null; payer_email?: string | null; paid_at?: string | null;
}

const STOP = new Set(["mr", "mrs", "ms", "miss", "dr", "the", "and", "kumar", "devi", "bhai", "ben"]);
/** "MR. ARUN  K." → ["arun"]: lower-case name tokens of three letters or more, without titles and common suffixes. */
export function nameTokens(name: string | null | undefined): string[] {
  return String(name ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));
}

/** How the payer's name compares with the guest's: every token of the shorter name in the longer one, or only some. */
export function nameFit(payer: string | null | undefined, guest: string | null | undefined): "name" | "partial_name" | null {
  const a = nameTokens(payer), b = nameTokens(guest);
  if (!a.length || !b.length) return null;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const hits = short.filter((t) => long.some((u) => u === t || (t.length >= 5 && u.length >= 5 && (u.startsWith(t) || t.startsWith(u)))));
  if (hits.length === short.length) return "name";
  return hits.length ? "partial_name" : null;
}

const digits10 = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "").slice(-10);

/**
 * Rank the open stays a gateway payment could belong to, when its order id names no booking (a link made by hand,
 * or a booking made in AVOS with no reference). Only stays the guest pays us directly, still owing money, from a
 * month back onwards. A payment larger than what a stay still owes cannot be for that stay alone.
 */
export async function rankStaysForPayment(db: D1Database, propertyId: string, timezone: string, clues: PaymentClues): Promise<StayCandidate[]> {
  const rows = await all<any>(db, `SELECT b.id, g.name AS guest_name, g.phone, g.email, b.check_in, b.check_out, b.gross_paise, b.created_at,
      b.gross_paise - COALESCE((SELECT SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END) FROM payments WHERE booking_id = b.id AND status != 'void'), 0) AS owing_paise
    FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id
    WHERE b.property_id = ? AND ch.collection_type != 'channel_collect' AND b.status IN ('provisional','approved','checked_in','checked_out') AND b.check_out >= ?`,
    propertyId, addDays(todayIn(timezone), -30));
  const amount = Number(clues.amount_paise ?? 0);
  const mobile = digits10(clues.payer_mobile), email = String(clues.payer_email ?? "").toLowerCase();
  const paidAt = Date.parse(String(clues.paid_at ?? "")) || Date.now();
  const out: StayCandidate[] = [];
  for (const r of rows) {
    if (r.owing_paise <= 0) continue;
    if (amount && amount > r.owing_paise) continue; // more than the stay still owes
    const why: string[] = []; let score = 0; let identity: StayCandidate["identity"] = null;
    if (mobile.length === 10 && digits10(r.phone) === mobile) { score += 100; identity = "mobile"; why.push("same mobile"); }
    else if (email && String(r.email ?? "").toLowerCase() === email) { score += 100; identity = "email"; why.push("same email"); }
    const nf = nameFit(clues.payer_name, r.guest_name);
    if (nf === "name") { score += 80; identity = identity ?? "name"; why.push("payer's name matches the guest"); }
    else if (nf === "partial_name") { score += 40; identity = identity ?? "partial_name"; why.push("part of the name matches"); }
    if (amount) {
      if (amount === r.owing_paise) { score += 30; why.push("amount is the balance due"); }
      else if (amount === r.gross_paise) { score += 30; why.push("amount is the full stay"); }
      else { score += 5; why.push("amount fits within the balance"); }
    }
    const made = Date.parse(String(r.created_at).replace(" ", "T") + (String(r.created_at).endsWith("Z") ? "" : "Z"));
    if (Number.isFinite(made) && paidAt - made >= -3_600_000 && paidAt - made <= 3 * 86_400_000) { score += 10; why.push("booked in the days before the payment"); }
    out.push({ id: r.id, guest_name: r.guest_name, check_in: r.check_in, check_out: r.check_out, gross_paise: r.gross_paise, owing_paise: r.owing_paise, created_at: r.created_at, score, identity, why });
  }
  return out.sort((a, b) => b.score - a.score || a.check_in.localeCompare(b.check_in));
}

/**
 * The one stay the payment can safely be posted to without a person: exactly one stay matched on who paid (mobile,
 * email or the full name). The amount alone never decides: two guests can owe the same.
 */
export function confidentStay(cands: StayCandidate[]): StayCandidate | null {
  const strong = cands.filter((c) => c.identity === "mobile" || c.identity === "email" || c.identity === "name");
  return strong.length === 1 ? strong[0] : null;
}
