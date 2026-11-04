import { slabBpForRoomNight } from "../domain/gst";
import { all, one } from "../db";
import { periodRange } from "../domain/dates";
import { applyBp } from "../domain/money";

/** Revenue for a period, recognised on books_date (= check-out), ex-GST, net of credit notes. */
export async function revenueSummary(db: D1Database, propertyId: string, period: string) {
  const { from, to } = periodRange(period);
  const rev = await one<any>(db, `SELECT COALESCE(SUM(b.room_total_paise),0) AS taxable_paise, COALESCE(SUM(b.gst_paise),0) AS gst_paise, COALESCE(SUM(b.gross_paise),0) AS gross_paise, COUNT(*) AS stays,
      COALESCE(SUM(CASE WHEN ch.collection_type = 'direct' THEN b.room_total_paise ELSE 0 END),0) AS direct_taxable_paise
     FROM bookings b JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ?`, propertyId, from, to);
  const cn = await one<any>(db, "SELECT COALESCE(SUM(taxable_paise),0) AS taxable_paise, COALESCE(SUM(gst_paise),0) AS gst_paise FROM credit_notes WHERE property_id = ? AND issued_on BETWEEN ? AND ?", propertyId, from, to);
  const bySource = await all<any>(db, `SELECT ch.name AS channel, ch.collection_type, COUNT(*) AS stays, SUM(b.room_total_paise) AS taxable_paise, SUM(b.gross_paise) AS gross_paise FROM bookings b JOIN channels ch ON ch.id = b.channel_id
     WHERE b.property_id = ? AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ? GROUP BY ch.id ORDER BY taxable_paise DESC`, propertyId, from, to);
  const bySlab = await all<any>(db, `SELECT br.gst_rate_bp, SUM(br.room_total_paise) AS taxable_paise, SUM(br.gst_paise) AS gst_paise FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
     WHERE b.property_id = ? AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ? GROUP BY br.gst_rate_bp`, propertyId, from, to);
  const otaClearing = await one<any>(db, `SELECT COALESCE(SUM(b.gross_paise),0) AS paise, COUNT(*) AS stays FROM bookings b JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND ch.collection_type = 'channel_collect' AND b.status = 'checked_out'
     AND b.id NOT IN (SELECT si.booking_id FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id WHERE s.status = 'settled')`, propertyId);
  const advances = await one<any>(db, `SELECT COALESCE(SUM(p.amount_paise),0) AS paise, COUNT(*) AS n FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.property_id = ? AND p.kind = 'advance' AND p.status != 'void' AND p.received_on BETWEEN ? AND ? AND b.books_date > ?`, propertyId, from, to, to);
  // Other income (meals, photoshoots, events) is revenue too: it joins the totals, the slab table and the P&L.
  const other = await one<any>(db, "SELECT COALESCE(SUM(taxable_paise),0) AS taxable_paise, COALESCE(SUM(gst_paise),0) AS gst_paise, COALESCE(SUM(amount_paise),0) AS gross_paise, COUNT(*) AS n FROM other_income WHERE property_id = ? AND voided_at IS NULL AND on_date BETWEEN ? AND ?", propertyId, from, to);
  const otherByCat = await all<any>(db, "SELECT category, COUNT(*) AS n, SUM(taxable_paise) AS taxable_paise, SUM(amount_paise) AS gross_paise FROM other_income WHERE property_id = ? AND voided_at IS NULL AND on_date BETWEEN ? AND ? GROUP BY category ORDER BY taxable_paise DESC", propertyId, from, to);
  const otherBySlab = await all<any>(db, "SELECT gst_rate_bp, SUM(taxable_paise) AS taxable_paise, SUM(gst_paise) AS gst_paise FROM other_income WHERE property_id = ? AND voided_at IS NULL AND on_date BETWEEN ? AND ? GROUP BY gst_rate_bp", propertyId, from, to);
  const slabs = new Map<number, { gst_rate_bp: number; taxable_paise: number; gst_paise: number }>();
  for (const s of [...bySlab, ...otherBySlab]) { const g = slabs.get(s.gst_rate_bp) ?? { gst_rate_bp: s.gst_rate_bp, taxable_paise: 0, gst_paise: 0 }; g.taxable_paise += s.taxable_paise; g.gst_paise += s.gst_paise; slabs.set(s.gst_rate_bp, g); }
  const taxable = rev.taxable_paise - cn.taxable_paise + other.taxable_paise;
  return {
    period, stays: rev.stays, taxable_paise: taxable, gst_paise: rev.gst_paise - cn.gst_paise + other.gst_paise, gross_paise: rev.gross_paise - cn.taxable_paise - cn.gst_paise + other.gross_paise,
    rooms_taxable_paise: rev.taxable_paise - cn.taxable_paise,
    direct_share_pct: rev.taxable_paise ? Math.round((rev.direct_taxable_paise * 100) / rev.taxable_paise) : 0,
    credit_notes: cn, by_source: bySource, by_slab: [...slabs.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp), ota_clearing: otaClearing,
    other_income: { ...other, by_category: otherByCat },
    advances_for_future_stays: advances, // GST time-of-supply note for the CA (F2)
  };
}

export async function expenseSummary(db: D1Database, propertyId: string, period: string) {
  const { from, to } = periodRange(period);
  const byCat = await all<any>(db, `SELECT category, kind, SUM(amount_paise) AS amount_paise, SUM(gst_paise) AS gst_paise, COUNT(*) AS n FROM expenses WHERE property_id = ? AND voided_at IS NULL AND on_date BETWEEN ? AND ? GROUP BY category, kind ORDER BY amount_paise DESC`, propertyId, from, to);
  const total = byCat.reduce((a, r) => a + r.amount_paise, 0);
  const otaCosts = byCat.filter((r) => r.kind !== "normal").reduce((a, r) => a + r.amount_paise, 0);
  return { period, total_paise: total, ota_and_gateway_costs_paise: otaCosts, operating_paise: total - otaCosts, by_category: byCat };
}

/** The pre-close exceptions the revenue desk clears before the CA locks (W9). */
export async function precloseExceptions(db: D1Database, propertyId: string, period: string) {
  const { from, to } = periodRange(period);
  const unreconciled = await all<any>(db, "SELECT id, on_date, description, amount_paise, status FROM bank_statement_lines WHERE property_id = ? AND on_date BETWEEN ? AND ? AND status IN ('unmatched','proposed') ORDER BY on_date", propertyId, from, to);
  const partPaid = await all<any>(db, `SELECT b.id, g.name AS guest_name, b.gross_paise, b.check_out, ch.collection_type,
      (SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END),0) FROM payments WHERE booking_id = b.id AND status != 'void') AS paid_paise
     FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ? AND ch.collection_type != 'channel_collect'`, propertyId, from, to);
  const missingBills = await all<any>(db, "SELECT id, on_date, category, amount_paise, vendor_name, bill_no, bill_photo_key FROM expenses WHERE property_id = ? AND kind = 'normal' AND voided_at IS NULL AND on_date BETWEEN ? AND ? AND (vendor_name IS NULL OR bill_no IS NULL)", propertyId, from, to);
  const pendingApprovals = await all<any>(db, "SELECT id, kind, summary, amount_paise, created_at FROM approvals WHERE property_id = ? AND status = 'pending'", propertyId);
  const unsettled = await all<any>(db, `SELECT b.id, g.name AS guest_name, b.external_ref, b.check_out, b.gross_paise FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND ch.collection_type = 'channel_collect' AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ?
     AND b.id NOT IN (SELECT si.booking_id FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id WHERE s.status = 'settled')`, propertyId, from, to);
  const uninvoiced = await all<any>(db, `SELECT b.id, g.name AS guest_name, b.check_out FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ? AND ch.collection_type = 'direct' AND b.id NOT IN (SELECT booking_id FROM invoices)`, propertyId, from, to);
  const inHouseOverdue = await all<any>(db, "SELECT b.id, g.name AS guest_name, b.check_out FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.status = 'checked_in' AND b.check_out <= ?", propertyId, to);
  // Stays that ended in the month without a check-in: either the guest came (check in and out after the fact) or a no-show.
  const neverCheckedIn = await all<any>(db, "SELECT b.id, g.name AS guest_name, b.check_in, b.check_out FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.status IN ('provisional','approved') AND b.check_out <= ?", propertyId, to);
  // Refunds approved but not paid: money owed to a guest.
  const refundsToPay = await all<any>(db, "SELECT a.id, a.summary, a.amount_paise FROM approvals a WHERE a.property_id = ? AND a.kind = 'refund' AND a.status = 'approved' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.refund_approval_id = a.id AND p.status != 'void')", propertyId);
  // Room-nights in the month taxed on a slab that does not match the price charged.
  const prop = await one<any>(db, "SELECT gstin, gst_nil_upto_paise, gst_threshold_paise, gst_rate_below_bp, gst_rate_above_bp FROM properties WHERE id = ?", propertyId);
  const pol = { gstin: prop?.gstin ?? null, nilUptoPaise: prop?.gst_nil_upto_paise ?? 100_000, thresholdPaise: prop?.gst_threshold_paise ?? 750_000, belowBp: prop?.gst_rate_below_bp ?? 500, aboveBp: prop?.gst_rate_above_bp ?? 1800 };
  const slabRows = await all<any>(db, `SELECT b.id, g.name AS guest_name, b.check_out, br.nightly_rate_paise, br.gst_rate_bp FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN booking_rooms br ON br.booking_id = b.id
     WHERE b.property_id = ? AND b.status NOT IN ('cancelled','no_show') AND b.books_date BETWEEN ? AND ?`, propertyId, from, to);
  const wrongSlab = [...new Map(slabRows.filter((r) => r.gst_rate_bp !== slabBpForRoomNight(pol, r.nightly_rate_paise)).map((r) => [r.id, { id: r.id, guest_name: r.guest_name, check_out: r.check_out, charged_bp: r.gst_rate_bp, due_bp: slabBpForRoomNight(pol, r.nightly_rate_paise) }])).values()];
  return {
    period,
    unreconciled_bank_lines: unreconciled,
    part_paid_stays: partPaid.filter((x) => x.gross_paise !== x.paid_paise),
    expenses_missing_bill_details: missingBills,
    pending_approvals: pendingApprovals,
    unsettled_ota_stays: unsettled,
    uninvoiced_direct_stays: uninvoiced,
    stays_not_checked_out: inHouseOverdue,
    stays_never_checked_in: neverCheckedIn,
    refunds_to_pay: refundsToPay,
    stays_on_wrong_gst_slab: wrongSlab,
  };
}

/** GST filing sheet (W10): taxable by slab, output GST, TCS to accept, TDS for 26AS, credit notes, advances. */
export async function gstSheet(db: D1Database, propertyId: string, period: string) {
  const rev = await revenueSummary(db, propertyId, period);
  const credits = await all<any>(db, "SELECT kind, status, SUM(amount_paise) AS amount_paise, COUNT(*) AS n FROM statutory_credits WHERE property_id = ? AND period = ? GROUP BY kind, status", propertyId, period);
  const { from, to } = periodRange(period);
  const purchaseGst = await one<any>(db, "SELECT COALESCE(SUM(gst_paise),0) AS gst_paise, COUNT(*) AS n FROM expenses WHERE property_id = ? AND voided_at IS NULL AND gst_paise > 0 AND on_date BETWEEN ? AND ?", propertyId, from, to);
  // Reverse charge: a foreign OTA's commission and payment charge, deducted from a payout settled this month
  // (the date the OTA took its charges is the time of supply for an import of services).
  const rcmRows = await all<any>(db, `SELECT s.id, s.payout_ref, s.payout_on, ch.name AS channel, ch.commission_rcm_bp AS bp, s.commission_paise + s.payment_fee_paise AS value_paise
     FROM settlements s JOIN channels ch ON ch.id = s.channel_id
     WHERE s.property_id = ? AND s.status = 'settled' AND ch.commission_rcm_bp > 0 AND s.payout_on BETWEEN ? AND ? ORDER BY s.payout_on`, propertyId, from, to);
  const rcmLines = rcmRows.map((r) => ({ settlement_id: r.id, channel: r.channel, payout_ref: r.payout_ref, payout_on: r.payout_on, rate_pct: r.bp / 100, value_paise: r.value_paise, igst_paise: applyBp(r.value_paise, r.bp) }));
  const changeLog = await all<any>(db, "SELECT id, actor_email, action, entity, entity_id, before_json, after_json, at FROM audit_log WHERE property_id = ? AND substr(at,1,7) = ? AND action LIKE '%.update' OR (property_id = ? AND substr(at,1,7) = ? AND action LIKE '%.void') ORDER BY at", propertyId, period, propertyId, period);
  return {
    period,
    by_slab: rev.by_slab.map((s) => ({ rate_pct: s.gst_rate_bp / 100, taxable_paise: s.taxable_paise, gst_paise: s.gst_paise })),
    credit_notes: rev.credit_notes,
    taxable_total_paise: rev.taxable_paise, output_gst_paise: rev.gst_paise,
    tcs: credits.filter((c) => c.kind === "tcs"), tds: credits.filter((c) => c.kind === "tds"),
    input_gst_on_purchases: { ...purchaseGst, note: "Not creditable while rooms are supplied at the 5% slab; shown for the register." },
    advances_received_for_future_stays: rev.advances_for_future_stays,
    reverse_charge: {
      lines: rcmLines,
      value_paise: rcmLines.reduce((t, l) => t + l.value_paise, 0),
      igst_paise: rcmLines.reduce((t, l) => t + l.igst_paise, 0),
      note: "IGST on the foreign OTA's commission and payment charge (import of services), paid by the hotel in cash: GSTR-3B table 3.1(d). Input credit (table 4A(2)) only as far as the CA confirms: rooms at the 5% slab carry none.",
    },
    change_log: changeLog,
  };
}

/**
 * Marketing scorecard: what the agency's work turns into, measured from the books. Leads by month and
 * source (with how many were answered inside the one-hour tolerance), the bookings they became, the
 * room-nights and gross revenue of those bookings, and marketing spend from the expense book; the same
 * cut by campaign, where the campaign came in on the lead (UTM, Meta campaign name, or typed by sales)
 * and on the expense line.
 */
export async function marketingScorecard(db: D1Database, propertyId: string, months: string[]) {
  const from = `${months[0]}-01`, to = `${months[months.length - 1]}-31`;
  const leadCols = `COUNT(*) AS leads,
        SUM(CASE WHEN l.first_response_at IS NOT NULL AND (julianday(replace(l.first_response_at,' ','T')) - julianday(replace(l.created_at,' ','T'))) * 24 <= 1 THEN 1 ELSE 0 END) AS answered_1h,
        SUM(CASE WHEN l.status IN ('quoted','hold','won') OR l.quote_total_paise IS NOT NULL THEN 1 ELSE 0 END) AS quoted,
        SUM(CASE WHEN l.status = 'won' AND b.id IS NOT NULL AND b.status NOT IN ('cancelled','no_show') THEN 1 ELSE 0 END) AS won,
        SUM(CASE WHEN l.status = 'lost' THEN 1 ELSE 0 END) AS lost,
        COALESCE(SUM(CASE WHEN l.status = 'won' AND b.status NOT IN ('cancelled','no_show') THEN b.nights ELSE 0 END), 0) AS room_nights,
        COALESCE(SUM(CASE WHEN l.status = 'won' AND b.status NOT IN ('cancelled','no_show') THEN b.gross_paise ELSE 0 END), 0) AS revenue_paise`;
  const bySource = await all<any>(db, `SELECT substr(datetime(l.created_at, '+330 minutes'),1,7) AS month, l.source, ${leadCols}
     FROM leads l LEFT JOIN bookings b ON b.id = l.booking_id
     WHERE l.property_id = ? AND substr(datetime(l.created_at, '+330 minutes'),1,10) BETWEEN ? AND ? GROUP BY month, l.source ORDER BY month, l.source`, propertyId, from, to);
  const byCampaign = await all<any>(db, `SELECT COALESCE(NULLIF(l.campaign,''), '(no campaign)') AS campaign, l.source, ${leadCols}
     FROM leads l LEFT JOIN bookings b ON b.id = l.booking_id
     WHERE l.property_id = ? AND substr(datetime(l.created_at, '+330 minutes'),1,10) BETWEEN ? AND ? GROUP BY campaign, l.source ORDER BY leads DESC`, propertyId, from, to);
  const spend = await all<any>(db, `SELECT substr(on_date,1,7) AS month, COALESCE(NULLIF(campaign,''), '(no campaign)') AS campaign, SUM(amount_paise) AS spend_paise, COUNT(*) AS lines
     FROM expenses WHERE property_id = ? AND category = 'marketing' AND voided_at IS NULL AND on_date BETWEEN ? AND ? GROUP BY month, campaign ORDER BY month`, propertyId, from, to);
  const perMonth = months.map((m) => {
    const rows = bySource.filter((r) => r.month === m);
    const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    const sp = spend.filter((r) => r.month === m).reduce((a, r) => a + Number(r.spend_paise), 0);
    const leads = sum("leads"), won = sum("won");
    return { month: m, leads, answered_1h: sum("answered_1h"), quoted: sum("quoted"), won, lost: sum("lost"), room_nights: sum("room_nights"), revenue_paise: sum("revenue_paise"), spend_paise: sp,
      cost_per_lead_paise: leads ? Math.round(sp / leads) : null, cost_per_booking_paise: won ? Math.round(sp / won) : null, revenue_per_rupee: sp ? Math.round((sum("revenue_paise") / sp) * 100) / 100 : null };
  });
  const sources = [...new Set(bySource.map((r) => r.source))].map((source) => {
    const rows = bySource.filter((r) => r.source === source);
    const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    return { source, leads: sum("leads"), answered_1h: sum("answered_1h"), quoted: sum("quoted"), won: sum("won"), lost: sum("lost"), room_nights: sum("room_nights"), revenue_paise: sum("revenue_paise") };
  }).sort((a, b) => b.leads - a.leads);
  const campaignNames = [...new Set([...byCampaign.map((r) => r.campaign), ...spend.map((r) => r.campaign)])];
  const campaigns = campaignNames.map((campaign) => {
    const rows = byCampaign.filter((r) => r.campaign === campaign);
    const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    const sp = spend.filter((r) => r.campaign === campaign).reduce((a, r) => a + Number(r.spend_paise), 0);
    const leads = sum("leads"), won = sum("won");
    return { campaign, sources: [...new Set(rows.map((r) => r.source))], leads, answered_1h: sum("answered_1h"), won, room_nights: sum("room_nights"), revenue_paise: sum("revenue_paise"), spend_paise: sp,
      cost_per_lead_paise: leads && sp ? Math.round(sp / leads) : null, cost_per_booking_paise: won && sp ? Math.round(sp / won) : null };
  }).sort((a, b) => (b.spend_paise + b.revenue_paise) - (a.spend_paise + a.revenue_paise));
  const totals = perMonth.reduce((t, m) => ({ leads: t.leads + m.leads, won: t.won + m.won, revenue_paise: t.revenue_paise + m.revenue_paise, spend_paise: t.spend_paise + m.spend_paise, room_nights: t.room_nights + m.room_nights, answered_1h: t.answered_1h + m.answered_1h }), { leads: 0, won: 0, revenue_paise: 0, spend_paise: 0, room_nights: 0, answered_1h: 0 });
  return { months, per_month: perMonth, by_source: sources, by_campaign: campaigns, totals: { ...totals, cost_per_lead_paise: totals.leads ? Math.round(totals.spend_paise / totals.leads) : null, cost_per_booking_paise: totals.won ? Math.round(totals.spend_paise / totals.won) : null } };
}
