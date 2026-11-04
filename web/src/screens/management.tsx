import { useState } from "react";
import { get, post, patch, del } from "../api";
import { Card, Row, Btn, Chips, Field, Status, Empty, Loading, BankPick, defaultBankId, inr, fmtDate, fmtDateTime, useLoad, run, toast, thisPeriod, todayIso, CategoryPicker, ask, askConfirm, askText, tell, ScrollX, actionLabel } from "../ui";
import { DriveSettings } from "./ids";
import { Icon } from "../icons";
import { canOpen, catLabel, type Me, type Ref } from "../app";

export function Approvals({ me, refs }: { me: Me; refs: Ref }) {
  const [refundBank, setRefundBank] = useState(defaultBankId(refs.accounts));
  const q = useLoad(() => get("/approvals"), []);
  const refunds = useLoad(() => get("/approvals?status=approved"), []);
  const decide = (id: string, verb: string, body?: unknown) => run(async () => { await post(`/approvals/${id}/${verb}`, body); await Promise.all([q.reload(), refunds.reload()]); }, verb === "approve" ? "Approved · audited" : "Returned");
  if (!q.data) return <Loading error={q.error} />;
  const toPay = (refunds.data?.approvals ?? []).filter((a: any) => a.kind === "refund");
  return <>
    <h1>Approvals <small>exceptions only — on-tariff bookings approve themselves</small></h1>
    {q.data.approvals.length === 0 ? <Empty>Nothing waiting. On-tariff bookings, parsed OTA reservations and settlements pass straight through, audited.</Empty> : q.data.approvals.map((a: any) => <Card key={a.id} tone="amb" title={<>{a.kind} · {a.summary}</>} sub={<>requested by {a.requested_name ?? "system"} · {fmtDateTime(a.created_at)} · {a.note ? `reason: ${a.note.replace(/_/g, " ")}` : ""}</>}>
      {a.amount_paise != null && <Row strong label="Amount" value={inr(a.amount_paise)} />}
      <div className="actions end"><Btn kind="danger" onClick={async () => { const note = await askText("Return to the desk", "Note for the person who asked", { ok: "Return" }); if (note) await decide(a.id, "return", { note }); }}>Return</Btn><Btn kind="primary" onClick={() => decide(a.id, "approve", {})}>Approve</Btn></div></Card>)}
    {me.actor.role === "owner" && toPay.length > 0 && <Card title="Refunds approved · make the bank transfer and record it"><BankPick accounts={refs.accounts} value={refundBank} onChange={setRefundBank} label="Refund paid from" />{toPay.map((a: any) => <div className="row" key={a.id}><div><div>{a.summary}</div><div className="sub">approved {fmtDateTime(a.decided_at)}</div></div><div className="actions"><b className="num">{inr(a.amount_paise)}</b><Btn small kind="primary" onClick={async () => { const r = await askText("Record the refund transfer", "NEFT/UPI reference", { ok: "Record" }); if (r) await run(async () => { const res = await post(`/approvals/refunds/${a.id}/pay`, { reference: r, account_id: refundBank || undefined }); if (res.invoice_to_credit) { await post(`/invoices/${res.invoice_to_credit.id}/credit-notes`, { reason: "refund on cancellation", total_paise: res.invoice_to_credit.suggested_total_paise, refund_payment_id: res.id }); toast("Refund recorded · credit note issued"); } else toast("Refund recorded"); await refunds.reload(); }); }}>Record transfer</Btn></div></div>)}</Card>}
    <Card title="Recent decisions · audit trail">{q.data.recent.length === 0 ? <Empty>None yet.</Empty> : q.data.recent.map((a: any) => <div className="row" key={a.id}><div><div>{a.summary}</div><div className="sub">{a.decided_name} · {fmtDateTime(a.decided_at)}{a.note ? ` · ${a.note}` : ""}</div></div><Status s={a.status} /></div>)}</Card>
  </>;
}

export function Payouts({ me, refs }: { me: Me; refs: Ref }) {
  const otaChannels = refs.channels.filter((c) => c.collection_type === "channel_collect");
  const [channel, setChannel] = useState(otaChannels[0]?.code ?? "booking_com");
  const un = useLoad(() => get(`/settlements/unsettled?channel=${channel}`), [channel]);
  const list = useLoad(() => get("/settlements"), []);
  const [sel, setSel] = useState<string[]>([]); const [preview, setPreview] = useState<any>(null); const [refn, setRefn] = useState(""); const [recv, setRecv] = useState(""); const [on, setOn] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [bankId, setBankId] = useState(defaultBankId(refs.accounts));
  const detail = useLoad(() => open ? get(`/settlements/${open}`) : Promise.resolve(null), [open]);
  const doPreview = () => run(async () => setPreview((await post("/settlements", { channel_code: channel, booking_ids: sel, preview: true })).preview));
  const create = () => run(async () => { const s = await post("/settlements", { channel_code: channel, booking_ids: sel, payout_ref: refn, payout_on: on || null, received_paise: recv ? Math.round(Number(recv) * 100) : undefined }); setSel([]); setPreview(null); setRefn(""); await Promise.all([un.reload(), list.reload()]); setOpen(s.id); }, "Settlement drafted · nothing posted yet");
  // A payout received before the bank's opening balance is already in it: the owner closes it against the opening instead.
  const settle = async (id: string) => {
    const go = (extra: object = {}) => post(`/settlements/${id}/settle`, { account_id: bankId || undefined, ...extra });
    try { await go(); toast("Settled · commission & fee posted once, stays settled"); }
    catch (e: any) {
      if (!e?.detail?.before_opening) { toast(e?.message ?? String(e), "bad"); return; }
      if (!me.capabilities.includes("admin")) { await tell("Paid before AVOS started", `${e.message} Ask the owner to close it.`); return; }
      const ok = await askConfirm("Close this payout as paid before AVOS started?", `The money is already in the bank's opening balance of ${fmtDate(e.detail.opening_date)}. AVOS books the commission and settles the stays, and takes the same amount out of the opening, so the bank balance does not change. Undo puts it back.`, { ok: "Close against the opening balance" });
      if (!ok) return;
      await run(() => go({ before_opening: true }), "Closed against the opening balance · bank balance unchanged");
    }
    await Promise.all([list.reload(), un.reload(), detail.reload()]);
  };
  const undo = async (id: string) => { const reason = await askText("Undo this settlement?", "Reason", { ok: "Undo", danger: true, body: "Every expense the settlement created is removed." }); if (reason) await run(async () => { await post(`/settlements/${id}/undo`, { reason }); await Promise.all([list.reload(), un.reload(), detail.reload()]); }, "Undone · every expense the settlement created removed"); };
  const ch = refs.channels.find((c) => c.code === channel);
  return <>
    <h1>OTA payouts <small>what each channel paid in, checked to the paisa: gross − commission − fees − TCS − TDS = received</small></h1>
    <Chips value={channel} options={otaChannels.map((c) => ({ value: c.code, label: c.name }))} onChange={(v) => { setChannel(v); setSel([]); setPreview(null); }} />
    {ch && <div className="muted">Terms: commission {ch.commission_bp / 100}%{ch.commission_gst_bp ? ` + ${ch.commission_gst_bp / 100}% GST on it` : ""} · payment fee {ch.payment_fee_bp / 100}% · TCS {ch.tcs_bp / 100}% · TDS {ch.tds_bp / 100}% (owner changes these under Settings)</div>}
    <div className="grid two">
      <Card title="Stays awaiting payout" sub="tick the stays on the OTA statement">{!un.data ? <Loading /> : un.data.stays.length === 0 ? <Empty>Nothing unsettled.</Empty> : un.data.stays.map((s: any) => <label className="row" key={s.id}><div><input type="checkbox" checked={sel.includes(s.id)} onChange={() => setSel(sel.includes(s.id) ? sel.filter((x) => x !== s.id) : [...sel, s.id])} /> {s.guest_name} · {fmtDate(s.check_in)}→{fmtDate(s.check_out)}<div className="sub">ref {s.external_ref}</div></div><b className="num">{inr(s.gross_paise)}</b></label>)}
        <div className="actions end"><Btn disabled={!sel.length} onClick={doPreview}>Compute</Btn></div></Card>
      <Card title={preview ? "Expected payout" : "Compute first"}>{preview && <>
        <Row label="Gross" value={inr(preview.grossPaise)} /><Row label={`Commission ${ch!.commission_bp / 100}%`} value={`− ${inr(preview.commissionPaise)}`} />{preview.commissionGstPaise > 0 && <Row label={`GST on commission ${(ch!.commission_gst_bp ?? 0) / 100}%`} sub="input GST, on the OTA's commission invoice" value={`− ${inr(preview.commissionGstPaise)}`} />}<Row label={`Payment fee ${ch!.payment_fee_bp / 100}% of gross`} value={`− ${inr(preview.paymentFeePaise)}`} />
        {preview.tcsPaise > 0 && <Row label="TCS (recoverable credit)" value={`− ${inr(preview.tcsPaise)}`} />}{preview.tdsPaise > 0 && <Row label="TDS 194-O (recoverable credit)" value={`− ${inr(preview.tdsPaise)}`} />}
        <Row strong label="Expected" value={inr(preview.expectedPaise)} />
        <div className="grid two"><Field label="Payout reference"><input value={refn} onChange={(e: any) => setRefn(e.currentTarget.value)} placeholder="010649992418" /></Field><Field label="Payout date"><input type="date" value={on} onChange={(e: any) => setOn(e.currentTarget.value)} /></Field><Field label="Received (₹) — blank = expected"><input inputMode="decimal" value={recv} onChange={(e: any) => setRecv(e.currentTarget.value)} /></Field></div>
        <div className="actions end"><Btn kind="primary" disabled={!refn} onClick={create}>Draft settlement</Btn></div></>}</Card>
    </div>
    <BankPick accounts={refs.accounts} value={bankId} onChange={setBankId} label="Payouts land in" />
    <Card title="Settlements">{!list.data ? <Loading /> : list.data.settlements.length === 0 ? <Empty>None yet.</Empty> : <ScrollX><table className="t"><thead><tr><th>Payout</th><th>Channel</th><th className="num">Stays</th><th className="num">Expected</th><th className="num">Received</th><th className="num">Variance</th><th>Status</th><th></th></tr></thead><tbody>{list.data.settlements.map((s: any) => <tr key={s.id}><td className="mono">{s.payout_ref}</td><td>{s.channel_name}</td><td className="num">{s.stays}</td><td className="num">{inr(s.expected_paise)}</td><td className="num">{inr(s.received_paise)}</td><td className="num">{inr(s.variance_paise)}</td><td><Status s={s.status} />{s.opening_adjusted_paise > 0 && s.status === "settled" && <div className="sub">paid before AVOS started</div>}</td><td className="actions"><Btn small onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Close" : "Open"}</Btn>{s.status === "draft" && <Btn small kind="primary" onClick={() => settle(s.id)}>Mark settled</Btn>}{s.status === "draft" && <Btn small kind="danger" onClick={async () => { if (await askConfirm(`Delete the draft for payout ${s.payout_ref}?`, "Nothing has been posted from it; its stays go back to awaiting payout.", { ok: "Delete draft", danger: true })) await run(async () => { await del(`/settlements/${s.id}`); if (open === s.id) setOpen(null); await Promise.all([list.reload(), un.reload()]); }, "Draft deleted"); }}>Delete</Btn>}{s.status === "settled" && <Btn small kind="danger" onClick={() => undo(s.id)}>Undo</Btn>}</td></tr>)}</tbody></table></ScrollX>}</Card>
    {open && detail.data && <Card title={`Payout ${detail.data.settlement.payout_ref}`} sub={<>{detail.data.settlement.channel_name} · <Status s={detail.data.settlement.status} /></>}>
      <ScrollX><table className="t"><thead><tr><th>Stay</th><th className="num">Gross</th><th className="num">Commission</th><th className="num">Fee</th><th className="num">TCS</th><th className="num">TDS</th><th className="num">Net</th></tr></thead><tbody>{detail.data.items.map((i: any) => <tr key={i.booking_id}><td>{i.guest_name} · {fmtDate(i.check_out)}</td><td className="num">{inr(i.gross_paise)}</td><td className="num">{inr(i.commission_paise)}</td><td className="num">{inr(i.payment_fee_paise)}</td><td className="num">{inr(i.tcs_paise)}</td><td className="num">{inr(i.tds_paise)}</td><td className="num">{inr(i.net_paise)}</td></tr>)}</tbody></table></ScrollX>
      {detail.data.expenses.length > 0 && <div className="muted" style={{ marginTop: "8px" }}>Expenses this settlement created: {detail.data.expenses.map((e: any) => `${e.kind} ${inr(e.amount_paise)}${e.voided_at ? " (void)" : ""}`).join(" · ")}</div>}
    </Card>}
  </>;
}

export function Reconcile({ me, refs }: { me: Me; refs: Ref }) {
  const [bankId, setBankId] = useState(defaultBankId(refs.accounts));
  const bank = refs.accounts.find((a) => a.id === bankId) ?? refs.accounts.find((a) => a.kind === "bank");
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/recon?period=${period}`), [period]);
  const [text, setText] = useState("");
  const paste = () => run(async () => { const r = await post("/recon/paste", { account_id: bank?.id, text }); toast(`${r.inserted} line(s) read · ${r.duplicates} already seen · ${r.rejected.length} unreadable`); setText(""); await q.reload(); });
  const acceptAll = () => run(async () => { const ids = q.data.lines.filter((l: any) => l.status === "proposed").map((l: any) => l.id); const r = await post("/recon/accept", { line_ids: ids }); toast(`${r.accepted} accepted · written`); await q.reload(); });
  const tierLabel = (t: number | null) => ({ 1: "Tier 1 · UTR", 2: "Tier 2 · exact", 3: "Tier 3 · fee-tolerant", 4: "Tier 4 · OTA subset", 0: "manual" } as any)[t ?? -1] ?? "";
  return <>
    <h1>Smart Reconcile <small>bank lines matched to the books automatically; nothing is written until you accept it</small></h1>
    {me.actor.role === "revenue" && <div className="muted">You see bank credits. Debits (bank-paid expenses, refunds) are reconciled by the owner or the CA.</div>}
    <Card title={`Paste bank statement · ${bank?.name ?? "bank"}`} sub="date, description, debit, credit — tab, comma or pipe separated; lines already seen are skipped">
      <BankPick accounts={refs.accounts} value={bankId} onChange={setBankId} label="Statement of" />
      <Field label=""><textarea rows={5} value={text} onChange={(e: any) => setText(e.currentTarget.value)} placeholder={"14/10/2026\tNEFT BOOKING.COM 010649992418\t\t30836.26"} /></Field><div className="actions end"><Btn onClick={() => setText("")}>Clear</Btn><Btn kind="primary" disabled={!text.trim()} onClick={paste}>Match</Btn></div></Card>
    <div className="actions" style={{ marginBottom: "10px" }}><Field label="Month"><input type="month" value={period} onChange={(e: any) => setPeriod(e.currentTarget.value)} /></Field>{q.data && <div className="kpi" style={{ flex: 1 }}><div className="k"><small>Lines</small><b>{q.data.stats.total}</b></div><div className="k"><small>Matched</small><b>{q.data.stats.matched}</b></div><div className="k"><small>Proposed</small><b>{q.data.stats.proposed}</b></div><div className="k"><small>Auto rate</small><b>{q.data.stats.auto_rate}%</b></div></div>}</div>
    {!q.data ? <Loading error={q.error} /> : q.data.lines.length === 0 ? <Empty>No statement lines in {period}.</Empty> : <>
      <div className="actions end"><Btn kind="primary" disabled={!q.data.stats.proposed} onClick={acceptAll}>Accept all proposed ({q.data.stats.proposed})</Btn></div>
      {q.data.lines.map((l: any) => <Card key={l.id} tone={l.status === "matched" ? "ok" : l.status === "proposed" ? "amb" : l.status === "unmatched" ? "bad" : undefined} title={<>{l.description} <Status s={l.status} /></>} sub={<>{fmtDate(l.on_date)}{l.tier != null ? ` · ${tierLabel(l.tier)}` : ""}{l.match ? ` · ${l.match.label}` : ""}{l.match?.implied_fee_bp != null ? ` · implied fee ${(l.match.implied_fee_bp / 100).toFixed(2)}% (variance ${inr(l.match.variance_paise)} vs contracted)` : ""}{l.match?.stays ? ` · ${l.match.stays.length} stay(s)${l.match.partial ? " (subset)" : ""}` : ""}{l.reason ? ` · carried: ${l.reason}` : ""}</>} actions={<b className="num">{inr(l.amount_paise)}</b>}>
        <div className="actions end">{l.status === "proposed" && <Btn small kind="primary" onClick={() => run(async () => { await post("/recon/accept", { line_ids: [l.id] }); await q.reload(); }, "Accepted")}>Accept</Btn>}{l.status === "unmatched" && <Btn small onClick={async () => { const reason = await askText("Explain or carry forward", "Reason", { ok: "Carry" }); if (reason) await run(async () => { await post(`/recon/${l.id}/carry`, { reason }); await q.reload(); }, "Carried"); }}>Explain / carry</Btn>}{l.status === "unmatched" && <Btn small onClick={async () => { const id = await askText("Match manually", "Record id (payment, transfer, settlement or expense)", { ok: "Next" }); const kind = id && await askText("What kind of record is it?", "payment, transfer, settlement or expense", { ok: "Propose match" }); if (id && kind) await run(async () => { await post(`/recon/${l.id}/match`, { kind, id }); await q.reload(); }, "Proposed · accept to write"); }}>Match manually</Btn>}{l.status === "matched" && <Btn small kind="danger" onClick={() => run(async () => { await post(`/recon/${l.id}/unmatch`); await q.reload(); }, "Unmatched")}>Unmatch</Btn>}</div></Card>)}</>}
  </>;
}

/**
 * The pre-close checks in words: what each one means, who fixes it, where, and whether it blocks the close or can
 * be carried with a note (the server's rule in routes/close.ts).
 */
const CHECKS: Record<string, { label: string; why: string; fix: string; screen: string; blocks?: boolean }> = {
  pending_approvals: { label: "Approvals waiting", why: "bookings below tariff and refunds need a decision", fix: "Approvals", screen: "appr", blocks: true },
  stays_not_checked_out: { label: "Guests still checked in after their stay", why: "check them out so the stay lands in this month", fix: "Front desk", screen: "desk", blocks: true },
  uninvoiced_direct_stays: { label: "Direct stays without an invoice", why: "every stay paid to us needs a GST invoice", fix: "Guest invoices", screen: "invoice", blocks: true },
  stays_never_checked_in: { label: "Stays never checked in", why: "check the guest in and out after the fact, or mark a no-show", fix: "Front desk", screen: "desk" },
  part_paid_stays: { label: "Stays with money still owed", why: "collect it, or record what was already collected", fix: "Payments", screen: "pay" },
  refunds_to_pay: { label: "Approved refunds not yet paid", why: "make the transfer and record it", fix: "Approvals", screen: "appr" },
  unsettled_ota_stays: { label: "OTA stays not yet paid out", why: "match the channel's payout when it arrives", fix: "OTA payouts", screen: "payouts" },
  unreconciled_bank_lines: { label: "Bank lines not matched", why: "every bank line should match a record in the books", fix: "Smart Reconcile", screen: "recon" },
  expenses_missing_bill_details: { label: "Expenses without bill details", why: "add the vendor and bill number for the accountant", fix: "Expenses", screen: "pexp" },
  stays_on_wrong_gst_slab: { label: "Stays taxed on the wrong GST slab", why: "amend the booking so GST follows the price charged", fix: "Reservations", screen: "resv" },
};
const itemName = (x: any): string | null => x.guest_name ?? x.description ?? x.summary ?? x.vendor_name ?? (x.external_ref ? `ref ${x.external_ref}` : null) ?? (x.category ? String(x.category).replace(/_/g, " ") : null);

const names = (list: any[]) => { const n = list.map(itemName).filter(Boolean) as string[]; return n.length ? ` · ${n.slice(0, 4).join(", ")}${list.length > 4 ? ` and ${list.length - 4} more` : ""}` : ""; };

function CloseChecklist({ me, period, counts }: { me: Me; period: string; counts: Record<string, number> }) {
  const items = useLoad(() => get(`/reports/preclose?period=${period}`).catch(() => null), [period]);
  const keys = Object.keys(counts).sort((a, b) => Number(!!CHECKS[b]?.blocks) - Number(!!CHECKS[a]?.blocks));
  const open = keys.filter((k) => counts[k] > 0), clear = keys.filter((k) => !counts[k]);
  return <>
    {open.length === 0 ? <div className="allclear"><Icon name="tick" /> All {keys.length} checks are clear for {period}.</div> : <ul className="checklist">{open.map((k) => {
      const c = CHECKS[k] ?? { label: k.replace(/_/g, " "), why: "", fix: "", screen: "" };
      const list: any[] = items.data?.[k] ?? [];
      return <li key={k} className={c.blocks ? "blocks" : ""}>
        <span className="count" aria-label={`${counts[k]} item${counts[k] > 1 ? "s" : ""}`}>{counts[k]}</span>
        <div className="what"><b>{c.label}</b> <span className={`status ${c.blocks ? "bad" : "amb"}`}>{c.blocks ? "must be fixed" : "can be carried"}</span>
          <div className="sub">{c.why}{names(list)}</div></div>
        {c.screen && canOpen(me, c.screen) ? <a className="btn small" href={`#${c.screen}`}>Open {c.fix}</a> : c.fix ? <span className="sub">in {c.fix}</span> : null}
      </li>;
    })}</ul>}
    {open.length > 0 && clear.length > 0 && <details className="clearlist"><summary>{clear.length} check{clear.length > 1 ? "s" : ""} already clear</summary>{clear.map((k) => <div key={k} className="sub">✓ {CHECKS[k]?.label ?? k.replace(/_/g, " ")}</div>)}</details>}
  </>;
}

/** The month's three steps and where it stands: pre-close (revenue desk) → lock (accountant) → GST filed. */
function CloseSteps({ lock, period }: { lock: any; period: string }) {
  const at = ["open", "precleared", "locked", "filed"].indexOf(lock.status);
  const [y, m] = period.split("-").map(Number); const next = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 4)).toLocaleString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const steps = [
    { title: "Pre-close", who: "Revenue desk", note: at >= 1 ? `cleared ${fmtDateTime(lock.precleared_at)}` : "clear or carry the checks below" },
    { title: "Lock the month", who: "Accountant", note: at >= 2 ? `locked ${fmtDateTime(lock.locked_at)} · pack v${lock.version}` : `due by ${next}` },
    { title: "GST filed", who: "Accountant", note: at >= 3 ? `filed ${fmtDateTime(lock.filed_at)}` : "file from the GST filing sheet" },
  ];
  return <ol className="steps" aria-label={`${period} close progress`}>{steps.map((s, i) => { const st = i < at ? "done" : i === at ? "now" : "todo"; return <li key={s.title} className={st} aria-current={st === "now" ? "step" : undefined}>
    <span className="dot" aria-hidden="true">{st === "done" ? "✓" : i + 1}</span>
    <div><b>{s.title}</b><span className="sub">{s.who} · {s.note}</span>{st === "now" && <span className="sr-only"> (current step)</span>}{st === "done" && <span className="sr-only"> (done)</span>}</div>
  </li>; })}</ol>;
}

export function RevenueOverview({ me }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/reports/revenue?period=${period}`), [period]);
  const close = useLoad(() => get(`/close/${period}`), [period]);
  const preclear = (ack: boolean) => run(async () => { const note = ack ? await askText("Carry the open checks into the close?", "Note for the accountant", { ok: "Hand to the accountant", body: "Checks marked “must be fixed” cannot be carried. The rest go to the accountant with your note." }) : null; if (ack && !note) return; await post(`/close/${period}/preclear`, ack ? { acknowledge: true, note } : {}); await close.reload(); }, "Pre-close cleared · handed to the CA");
  return <>
    <h1>Revenue overview <small>revenue oversight and the pre-close; full P&amp;L stays with the owner and the CA</small></h1>
    <Field label="Month"><input type="month" value={period} onChange={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    {!q.data ? <Loading error={q.error} /> : <>
      <div className="kpi"><div className="k"><small>Revenue (ex-GST)</small><b>{inr(q.data.taxable_paise)}</b></div><div className="k"><small>Direct share</small><b>{q.data.direct_share_pct}%</b></div><div className="k"><small>OTA clearing</small><b>{inr(q.data.ota_clearing.paise)}</b></div><div className="k"><small>Pending approvals</small><b>{q.data.pending_approvals}</b></div><div className="k"><small>Stays</small><b>{q.data.stays}</b></div></div>
      <Card title="By channel">{q.data.by_source.length === 0 ? <Empty>No checked-out stays in {period}.</Empty> : q.data.by_source.map((s: any) => <div className="row" key={s.channel}><div style={{ flex: 1 }}><div>{s.channel} <span className="sub">· {s.stays} stay(s)</span></div><div className="bar"><i style={{ width: `${Math.max(2, Math.round((s.taxable_paise * 100) / Math.max(1, q.data.by_source[0].taxable_paise)))}%` }} /></div></div><div className="num">{inr(s.taxable_paise)}</div></div>)}{q.data.other_income && q.data.other_income.n > 0 && <Row label={`Other income · ${q.data.other_income.by_category.map((c: any) => `${c.category} ${c.n}`).join(", ")}`} value={inr(q.data.other_income.taxable_paise)} sub={`GST ${inr(q.data.other_income.gst_paise)} · rooms alone ${inr(q.data.rooms_taxable_paise)}`} />}{q.data.advances_for_future_stays.n > 0 && <div className="muted">Advances received this month for later stays: {inr(q.data.advances_for_future_stays.paise)} — GST time-of-supply item for the CA.</div>}</Card></>}
    {close.data && <Card title={`Close ${period}`} sub="fix what must be fixed, then hand the month to the accountant">
      <CloseSteps lock={close.data.lock} period={period} />
      <CloseChecklist me={me} period={period} counts={close.data.exception_counts} />
      {close.data.lock.status === "open" && <div className="actions end">{!close.data.clear && <Btn onClick={() => preclear(true)}>Carry the rest with a note</Btn>}<Btn kind="primary" disabled={!close.data.clear} title={close.data.clear ? undefined : "Every check must be clear, or carried with a note"} onClick={() => preclear(false)}>Hand to the accountant</Btn></div>}
    </Card>}
  </>;
}

export function OwnerDashboard({ refs }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/reports/owner?period=${period}`), [period]);
  const pnl = useLoad(() => get(`/reports/pnl?period=${period}`), [period]);
  const acc = useLoad(() => get("/payments/accounts"), []);
  return <>
    <h1>Owner dashboard <small>oversight · entries: bank payments only</small></h1>
    <Field label="Month"><input type="month" value={period} onChange={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    {!q.data ? <Loading error={q.error} /> : <>
      <div className="hero"><div className="top"><div className="lbl">Operating result, {new Date(period + "-01T00:00:00").toLocaleString("en-IN", { month: "long", year: "numeric" })}</div><Status s={q.data.month.status} /></div><div className="big">{inr(q.data.operating_result_paise)}</div>
        <div className="meta"><div><small>Revenue (ex-GST)</small><b>{inr(q.data.revenue_paise)}</b></div><div><small>Expenses</small><b>{inr(q.data.expenses_paise)}</b></div><div><small>Awaiting OTA payout</small><b>{inr(q.data.ota_clearing.paise)}</b></div><div><small>Direct share</small><b>{q.data.direct_share_pct}%</b></div></div></div>
      <div className="grid two">
        <Card title="Expenses by category">{!pnl.data ? <Loading /> : pnl.data.expenses.by_category.length === 0 ? <Empty>None.</Empty> : pnl.data.expenses.by_category.map((e: any) => <Row key={e.category + e.kind} label={`${catLabel(refs, e.category)}${e.kind !== "normal" ? ` · ${e.kind.replace(/_/g, " ")}` : ""} · ${e.n}`} value={inr(e.amount_paise)} />)}{pnl.data && <Row strong label="OTA & gateway costs within the above" value={inr(pnl.data.expenses.ota_and_gateway_costs_paise)} />}</Card>
        <Card title="Cash position" sub="AVOS balance per account; where the bank has sent an alert, what the bank says is underneath">{!acc.data ? <Loading /> : acc.data.accounts.map((a: any) => <Row key={a.id} label={a.name} sub={a.reported_balance_paise != null ? <>bank says {inr(a.reported_balance_paise)} at {fmtDateTime(a.reported_at)}{Math.abs(a.reported_balance_paise - a.balance_paise) > 100 ? <span style={{ color: "var(--amb)" }}> · differs by {inr(a.reported_balance_paise - a.balance_paise)}</span> : <span style={{ color: "var(--ok)" }}> · agrees</span>}</> : a.holder_role} value={inr(a.balance_paise)} />)}</Card>
      </div>
      <Card title="Who does what" sub="this org in one table">{q.data.who_does_what.map((u: any) => <Row key={u.name} label={{ sales: "Bookings & reservations", property: "Check-in/out, collections, tasks, petty cash", revenue: "Approvals, payouts, reconciliation, pre-close", owner: "Bank-paid expenses, oversight", accountant: "Month lock & GST filing" }[u.role as string]} value={u.name} />)}</Card></>}
  </>;
}

export function BankExpenses({ refs }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/expenses?scope=bank&period=${period}`), [period]);
  const [bankId, setBankId] = useState(defaultBankId(refs.accounts));
  const bank = refs.accounts.find((a) => a.id === bankId) ?? refs.accounts.find((a) => a.kind === "bank"); const petty = refs.accounts.find((a) => a.kind === "petty_cash");
  const banks = refs.accounts.filter((a) => a.kind === "bank");
  const [f, setF] = useState<any>({ category: "utilities", description: "", vendor_name: "", vendor_gstin: "", amount: "", reference: "", gst_rate_bp: 0 });
  const [top, setTop] = useState("");
  const [mv, setMv] = useState<any>({ from_account_id: banks.find((b) => !b.is_default)?.id ?? banks[0]?.id ?? "", to_account_id: defaultBankId(refs.accounts), amount: "", on_date: todayIso(), reference: "", note: "" });
  const balances = useLoad(() => get("/payments/accounts"), []);
  return <>
    <h1>Bank expenses <small>the owner's one entry duty · each carries its NEFT reference and auto-matches at reconciliation</small></h1>
    <div className="grid two">
      <Card title="New expense · paid by bank transfer" sub="pick a category, type the amount and the bank reference; it matches itself at reconciliation">
        <BankPick accounts={refs.accounts} value={bankId} onChange={setBankId} label="Paid from" />
        <CategoryPicker label="Category" value={f.category} onChange={(v) => setF({ ...f, category: v })} categories={refs.expense_categories.filter((c) => c.bank)} common={refs.common_categories.bank} families={refs.expense_families} />
        <div className="form-grid">
          <Field label="Description"><input value={f.description} onChange={(e: any) => setF({ ...f, description: e.currentTarget.value })} placeholder="KSEB electricity · Sep" /></Field>
          <Field label="Amount incl. GST (₹)"><input inputMode="decimal" value={f.amount} onChange={(e: any) => setF({ ...f, amount: e.currentTarget.value })} /></Field>
          <Field label="Vendor"><input value={f.vendor_name} onChange={(e: any) => setF({ ...f, vendor_name: e.currentTarget.value })} /></Field>
          <Field label="Vendor GSTIN" hint="15 characters, when the bill carries one"><input value={f.vendor_gstin} onChange={(e: any) => setF({ ...f, vendor_gstin: e.currentTarget.value })} /></Field>
          <Field label="GST rate on the bill"><select value={f.gst_rate_bp} onChange={(e: any) => setF({ ...f, gst_rate_bp: Number(e.currentTarget.value) })}><option value={0}>none</option><option value={500}>5%</option><option value={1200}>12%</option><option value={1800}>18%</option><option value={2800}>28%</option></select></Field>
          <Field label="Bank reference (NEFT/UPI)"><input value={f.reference} onChange={(e: any) => setF({ ...f, reference: e.currentTarget.value })} /></Field>
          {f.category === "marketing" && <Field label="Campaign" hint="same name the agency uses on the ads, so the scorecard can match spend to leads"><input value={f.campaign ?? ""} onChange={(e: any) => setF({ ...f, campaign: e.currentTarget.value })} placeholder="Diwali 2026 · Meta" /></Field>}
        </div>
        <div className="actions end"><Btn kind="primary" disabled={!f.amount} onClick={() => run(async () => { await post("/expenses", { ...f, amount_paise: Math.round(Number(f.amount) * 100), account_id: bank?.id }); setF({ ...f, description: "", amount: "", reference: "" }); await q.reload(); }, "Recorded")}>Record expense</Btn></div></Card>
      <Card title="Petty-cash top-up" sub={`a transfer from ${bank?.name ?? "the bank"} to the property manager — not an expense`}><Field label="Amount (₹)"><input inputMode="decimal" value={top} onChange={(e: any) => setTop(e.currentTarget.value)} /></Field><div className="actions end"><Btn kind="primary" disabled={!top} onClick={() => run(async () => { await post("/payments/transfers", { from_account_id: bank?.id, to_account_id: petty?.id, amount_paise: Math.round(Number(top) * 100) }); setTop(""); }, "Top-up recorded as a transfer")}>Top up petty cash</Btn></div></Card>
    </div>
    {banks.length > 1 && <Card title="Move money between accounts" sub="Yes Bank → IDFC, or a bank → cash: a transfer, not income or expense; each side matches its own statement line at reconciliation"
      actions={balances.data && <span className="sub">{balances.data.accounts.filter((a: any) => a.kind === "bank").map((a: any) => `${a.name} ${inr(a.balance_paise)}`).join(" · ")}</span>}>
      <div className="form-grid four">
        <Field label="From"><select value={mv.from_account_id} onChange={(e: any) => setMv({ ...mv, from_account_id: e.currentTarget.value })}>{refs.accounts.filter((a) => a.kind !== "gateway").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="To"><select value={mv.to_account_id} onChange={(e: any) => setMv({ ...mv, to_account_id: e.currentTarget.value })}>{refs.accounts.filter((a) => a.kind !== "gateway").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Amount (₹)"><input inputMode="decimal" value={mv.amount} onChange={(e: any) => setMv({ ...mv, amount: e.currentTarget.value })} /></Field>
        <Field label="Date"><input type="date" value={mv.on_date} onChange={(e: any) => setMv({ ...mv, on_date: e.currentTarget.value })} /></Field>
        <Field label="Bank reference (NEFT/IMPS/UTR)"><input value={mv.reference} onChange={(e: any) => setMv({ ...mv, reference: e.currentTarget.value })} /></Field>
        <Field label="Note"><input value={mv.note} onChange={(e: any) => setMv({ ...mv, note: e.currentTarget.value })} placeholder="moving the float to IDFC" /></Field>
      </div>
      <div className="actions end"><Btn kind="primary" disabled={!mv.amount || mv.from_account_id === mv.to_account_id} onClick={() => run(async () => { await post("/payments/transfers", { ...mv, amount_paise: Math.round(Number(mv.amount) * 100) }); setMv({ ...mv, amount: "", reference: "", note: "" }); await balances.reload(); }, "Transfer recorded")}>Record transfer</Btn></div>
    </Card>}
    <Field label="Month"><input type="month" value={period} onChange={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    <Card title="This month · bank-paid">{!q.data ? <Loading error={q.error} /> : q.data.expenses.length === 0 ? <Empty>None in {period}.</Empty> : q.data.expenses.map((e: any) => <div className="row" key={e.id}><div><div>{e.description ?? catLabel(refs, e.category)} <span className="muted">· {catLabel(refs, e.category)}</span> {e.kind !== "normal" && <Status s={e.kind} />}{e.voided_at && <Status s="void" />}</div><div className="sub">{fmtDate(e.on_date)} · {e.vendor_name ?? "—"}{e.vendor_gstin ? " · GSTIN ✓" : ""}{e.reference ? ` · ${e.reference}` : ""}</div></div><div className="actions"><b className="num">{inr(e.amount_paise)}</b>{!e.voided_at && e.kind === "normal" && <Btn small kind="danger" onClick={async () => { const reason = await askText("Void this expense?", "Reason", { ok: "Void", danger: true }); if (reason) await run(async () => { await post(`/expenses/${e.id}/void`, { reason }); await q.reload(); }, "Voided"); }}>Void</Btn>}</div></div>)}</Card>
  </>;
}

export function Admin({ refs }: { me: Me; refs: Ref }) {
  const users = useLoad(() => get("/admin/users"), []);
  const prop = useLoad(() => get("/admin/property"), []);
  const [nu, setNu] = useState({ email: "", name: "", role: "sales" });
  const [p, setP] = useState<any>(null);
  const cur = p ?? prop.data?.property;
  const [rc, setRc] = useState({ room_id: refs.locations.find((l) => l.kind === "room")?.id ?? "", name: "Peak", rate: "", from_date: "", to_date: "", priority: 10 });
  return <>
    <h1>Settings &amp; users <small>owner only</small></h1>
    <div className="grid two">
      <Card title="Users" sub="each person signs in with their email and password; new people get a temporary password or a set-password link">{!users.data ? <Loading /> : users.data.users.map((u: any) => <div className="row" key={u.id}><div><div>{u.name} <span className="muted">· {u.role}</span>{!u.active && <Status s="inactive" />}</div><div className="sub">{u.email}</div></div><div className="actions"><select aria-label={`Role for ${u.name}`} value={u.role} onChange={(e: any) => run(async () => { await patch(`/admin/users/${u.id}`, { role: e.currentTarget.value }); await users.reload(); }, "Role updated")}>{["sales", "property", "revenue", "owner", "accountant"].map((r) => <option value={r}>{r}</option>)}</select><Btn small onClick={() => run(async () => { await patch(`/admin/users/${u.id}`, { active: !u.active }); await users.reload(); })}>{u.active ? "Deactivate" : "Activate"}</Btn>
        <Btn small onClick={async () => { const pw = await askText(`Temporary password for ${u.name}`, "Temporary password", { ok: "Set password", minLength: 10, body: "They must change it at first sign-in.", input: { label: "Temporary password", type: "password", minLength: 10 } }); if (pw) await run(async () => { await post(`/admin/users/${u.id}/set-password`, { password: pw }); }, "Temporary password set"); }}>Set password</Btn>
        <Btn small onClick={() => run(async () => { const r = await post(`/admin/users/${u.id}/password-link`); try { await navigator.clipboard.writeText(r.link); } catch {} await ask({ title: `Set-password link for ${u.name}`, body: `Valid for 72 hours and copied to the clipboard. Send it to ${r.email}.`, input: { label: "Link", value: r.link, readOnly: true }, ok: "Done", cancel: null }); })}>Password link</Btn>
        <Btn small kind="danger" onClick={() => run(async () => { await post(`/admin/users/${u.id}/sign-out-everywhere`); }, "Signed out on every device")}>Sign out all</Btn></div></div>)}
        <details><summary>Add user (their Cloudflare Access email)</summary><Field label="Email"><input value={nu.email} onChange={(e: any) => setNu({ ...nu, email: e.currentTarget.value })} /></Field><Field label="Name"><input value={nu.name} onChange={(e: any) => setNu({ ...nu, name: e.currentTarget.value })} /></Field><Field label="Role"><select value={nu.role} onChange={(e: any) => setNu({ ...nu, role: e.currentTarget.value })}>{["sales", "property", "revenue", "owner", "accountant"].map((r) => <option value={r}>{r}</option>)}</select></Field><div className="actions end"><Btn kind="primary" onClick={() => run(async () => { await post("/admin/users", nu); setNu({ email: "", name: "", role: "sales" }); await users.reload(); }, "User added")}>Add</Btn></div></details></Card>
      {cur && <Card title="Property & GST" sub={cur.gstin ? `GSTIN ${cur.gstin} · invoices carry GST` : "No GSTIN: invoices carry no GST. Register before go-live if turnover exceeds the threshold."}>
        <Field label="Legal name"><input value={cur.legal_name ?? ""} onChange={(e: any) => setP({ ...cur, legal_name: e.currentTarget.value })} /></Field><Field label="Address"><input value={cur.address ?? ""} onChange={(e: any) => setP({ ...cur, address: e.currentTarget.value })} /></Field>
        <Field label="GSTIN (blank until registered)"><input value={cur.gstin ?? ""} onChange={(e: any) => setP({ ...cur, gstin: e.currentTarget.value })} /></Field>
        <div className="grid two"><Field label="Nil GST up to, per room-night (₹)" hint="a room-night charged at or below this is nil-rated"><input inputMode="decimal" value={cur.gst_nil_upto_paise / 100} onChange={(e: any) => setP({ ...cur, gst_nil_upto_paise: Math.round(Number(e.currentTarget.value) * 100) })} /></Field><Field label="Lower slab up to, per room-night (₹)"><input inputMode="decimal" value={cur.gst_threshold_paise / 100} onChange={(e: any) => setP({ ...cur, gst_threshold_paise: Math.round(Number(e.currentTarget.value) * 100) })} /></Field><Field label="Rate at/below threshold (bp)"><input type="number" value={cur.gst_rate_below_bp} onChange={(e: any) => setP({ ...cur, gst_rate_below_bp: Number(e.currentTarget.value) })} /></Field><Field label="Rate above threshold (bp)"><input type="number" value={cur.gst_rate_above_bp} onChange={(e: any) => setP({ ...cur, gst_rate_above_bp: Number(e.currentTarget.value) })} /></Field><Field label="Auto-approve on-tariff bookings"><select value={cur.auto_approve_on_tariff ? "1" : "0"} onChange={(e: any) => setP({ ...cur, auto_approve_on_tariff: e.currentTarget.value === "1" ? 1 : 0 })}><option value="1">yes — exceptions only go to the revenue desk</option><option value="0">no — every booking waits</option></select></Field><Field label="Inbox automation"><select value={cur.inbox_automation ? "1" : "0"} onChange={(e: any) => setP({ ...cur, inbox_automation: e.currentTarget.value === "1" ? 1 : 0 })}><option value="1">on — STAAH / SwiftBook / Airpay emails apply themselves when the facts line up</option><option value="0">off — every email waits for a person</option></select></Field><Field label="Quote valid (h)"><input type="number" value={cur.quote_valid_hours} onChange={(e: any) => setP({ ...cur, quote_valid_hours: Number(e.currentTarget.value) })} /></Field><Field label="Hold (h)"><input type="number" value={cur.hold_hours} onChange={(e: any) => setP({ ...cur, hold_hours: Number(e.currentTarget.value) })} /></Field></div>
        <div className="actions end"><Btn kind="primary" onClick={() => run(async () => { const { id, created_at, name, timezone, fy_start_month, ...rest } = cur; await patch("/admin/property", { ...rest, auto_approve_on_tariff: !!rest.auto_approve_on_tariff, inbox_automation: !!rest.inbox_automation }); setP(null); await prop.reload(); }, "Saved · audited")}>Save</Btn></div></Card>}
    </div>
    <div className="grid two">
      <Card title="Channels · payout terms" sub="commission and the GST on it, payment fee, TCS and TDS per channel — the payout formula reads these">{refs.channels.map((c) => <details key={c.id}><summary>{c.name} · {c.collection_type.replace("_", " ")} · {c.commission_bp / 100}%{c.commission_gst_bp ? ` + ${c.commission_gst_bp / 100}% GST` : ""}{c.commission_rcm_bp ? ` (${c.commission_rcm_bp / 100}% RCM)` : ""} / fee {c.payment_fee_bp / 100}% / TCS {c.tcs_bp / 100}% / TDS {c.tds_bp / 100}%</summary><ChannelEdit c={c} /></details>)}</Card>
      <AreasEquipment refs={refs} />
      <Card title="Tariff card" sub="per room; a dated card with higher priority overrides the standard rate">{refs.locations.filter((l) => l.kind === "room").map((r) => <div key={r.id}><b>{r.name}</b>{refs.rate_cards.filter((c) => c.room_id === r.id).map((c) => <div className="row" key={c.id}><div>{c.name}{c.from_date ? ` · ${fmtDate(c.from_date)} → ${fmtDate(c.to_date)}` : " · always"} · p{c.priority}</div><div className="actions"><b className="num">{inr(c.rate_paise)}</b><Btn small kind="danger" title="Remove this rate" onClick={async () => { if (await askConfirm("Remove this rate card?", "Bookings already made keep their price; new bookings use the next card that applies.", { ok: "Remove", danger: true })) await run(async () => { await del(`/admin/rate-cards/${c.id}`); location.reload(); }, "Removed"); }}>Remove</Btn></div></div>)}</div>)}
        <details><summary>Add card</summary><Field label="Room"><select value={rc.room_id} onChange={(e: any) => setRc({ ...rc, room_id: e.currentTarget.value })}>{refs.locations.filter((l) => l.kind === "room").map((r) => <option value={r.id}>{r.name}</option>)}</select></Field><div className="grid two"><Field label="Name"><input value={rc.name} onChange={(e: any) => setRc({ ...rc, name: e.currentTarget.value })} /></Field><Field label="Rate ex-GST (₹)"><input inputMode="decimal" value={rc.rate} onChange={(e: any) => setRc({ ...rc, rate: e.currentTarget.value })} /></Field><Field label="From"><input type="date" value={rc.from_date} onChange={(e: any) => setRc({ ...rc, from_date: e.currentTarget.value })} /></Field><Field label="To"><input type="date" value={rc.to_date} onChange={(e: any) => setRc({ ...rc, to_date: e.currentTarget.value })} /></Field></div><div className="actions end"><Btn kind="primary" onClick={() => run(async () => { await post("/admin/rate-cards", { room_id: rc.room_id, name: rc.name, rate_paise: Math.round(Number(rc.rate) * 100), from_date: rc.from_date || null, to_date: rc.to_date || null, priority: rc.priority }); location.reload(); }, "Card added")}>Add</Btn></div></details></Card>
    </div>
  <AccountsSettings />
  <DriveSettings />
  </>;
}
/** Banks and cash accounts: names, opening balances, which bank is the default, and closing a bank once it is empty. */
function AccountsSettings() {
  const q = useLoad(() => get("/admin/accounts"), []);
  const prop = useLoad(() => get("/admin/property"), []);
  const bal = useLoad(() => get("/payments/accounts"), []);
  const [edit, setEdit] = useState<any>(null);
  const [na, setNa] = useState<any>({ name: "", account_no: "", opening: "", opening_date: todayIso(), is_default: false });
  const balanceOf = (id: string) => bal.data?.accounts.find((a: any) => a.id === id)?.balance_paise;
  const save = (a: any) => run(async () => { await patch(`/admin/accounts/${a.id}`, { name: a.name, account_no: a.account_no || null, opening_paise: Math.round(Number(a.opening) * 100), opening_date: a.opening_date || null, note: a.note || null }); setEdit(null); await Promise.all([q.reload(), bal.reload()]); }, "Account saved · reload to see it in the pickers");
  const banks = (q.data?.accounts ?? []).filter((a: any) => a.kind === "bank" && a.active);
  const setPos = (v: string) => run(async () => { await patch("/admin/property", { pos_account_id: v || null }); await prop.reload(); }, "Card machine bank saved");
  return <Card title="Bank & cash accounts" sub="each bank is its own ledger with its own statement; the default bank is where payouts, gateway settlements and bank receipts land unless someone picks another">
    {prop.data && banks.length > 0 && <Field label="Card machine (POS) settles into" hint="card payments at the front desk land in this bank, net of its charge; change it when the new machine arrives">
      <select value={prop.data.property.pos_account_id ?? ""} onChange={(e: any) => setPos(e.currentTarget.value)}><option value="">the default bank</option>{banks.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
    {!q.data ? <Loading error={q.error} /> : q.data.accounts.map((a: any) => <div className="row" key={a.id}><div>
      <div><b>{a.name}</b> <span className="muted">· {a.kind.replace("_", " ")}{a.account_no ? ` · ${a.account_no}` : ""}</span> {a.is_default ? <Status s="default" /> : null}{!a.active && <Status s="inactive" />}</div>
      <div className="sub">opening {inr(a.opening_paise)} on {a.opening_date ?? "—"}{balanceOf(a.id) !== undefined ? ` · balance today ${inr(balanceOf(a.id))}` : ""}{a.reported_balance_paise != null ? ` · bank reported ${inr(a.reported_balance_paise)} at ${fmtDateTime(a.reported_at)}` : ""}{a.note ? ` · ${a.note}` : ""}</div>
      {edit?.id === a.id && <div className="form-grid four" style={{ marginTop: "8px" }}>
        <Field label="Name"><input value={edit.name} onChange={(e: any) => setEdit({ ...edit, name: e.currentTarget.value })} /></Field>
        <Field label="Account no. (last digits)"><input value={edit.account_no ?? ""} onChange={(e: any) => setEdit({ ...edit, account_no: e.currentTarget.value })} /></Field>
        <Field label="Opening balance (₹)"><input inputMode="decimal" value={edit.opening} onChange={(e: any) => setEdit({ ...edit, opening: e.currentTarget.value })} /></Field>
        <Field label="Opening date"><input type="date" value={edit.opening_date ?? ""} onChange={(e: any) => setEdit({ ...edit, opening_date: e.currentTarget.value })} /></Field>
        <Field label="Note"><input value={edit.note ?? ""} onChange={(e: any) => setEdit({ ...edit, note: e.currentTarget.value })} /></Field>
        <div className="actions end" style={{ gridColumn: "1 / -1" }}><Btn onClick={() => setEdit(null)}>Discard</Btn><Btn kind="primary" onClick={() => save(edit)}>Save</Btn></div>
      </div>}
    </div><div className="actions">
      {a.active && edit?.id !== a.id && <Btn small onClick={() => setEdit({ ...a, opening: String(a.opening_paise / 100) })}>Edit</Btn>}
      {a.kind === "bank" && a.active && !a.is_default && <Btn small onClick={() => run(async () => { await patch(`/admin/accounts/${a.id}`, { is_default: true }); await q.reload(); }, `${a.name} is now the default bank · reload to update the pickers`)}>Make default</Btn>}
      {a.kind === "bank" && a.active && !a.is_default && <Btn small kind="danger" onClick={async () => { if (await askConfirm(`Close ${a.name}?`, "It stays in history; nothing new can be recorded against it.", { ok: "Close account", danger: true })) await run(async () => { await patch(`/admin/accounts/${a.id}`, { active: false }); await q.reload(); }, "Closed"); }}>Close</Btn>}
      {!a.active && <Btn small onClick={() => run(async () => { await patch(`/admin/accounts/${a.id}`, { active: true }); await q.reload(); }, "Reopened")}>Reopen</Btn>}
    </div></div>)}
    <details><summary>Add a bank account</summary><div className="form-grid four" style={{ marginTop: "8px" }}>
      <Field label="Name"><input value={na.name} onChange={(e: any) => setNa({ ...na, name: e.currentTarget.value })} placeholder="IDFC First" /></Field>
      <Field label="Account no. (last digits)"><input value={na.account_no} onChange={(e: any) => setNa({ ...na, account_no: e.currentTarget.value })} /></Field>
      <Field label="Opening balance (₹)"><input inputMode="decimal" value={na.opening} onChange={(e: any) => setNa({ ...na, opening: e.currentTarget.value })} /></Field>
      <Field label="Opening date"><input type="date" value={na.opening_date} onChange={(e: any) => setNa({ ...na, opening_date: e.currentTarget.value })} /></Field>
      <Field label="Default bank"><select value={na.is_default ? "1" : "0"} onChange={(e: any) => setNa({ ...na, is_default: e.currentTarget.value === "1" })}><option value="0">no</option><option value="1">yes — payouts and receipts land here</option></select></Field>
      <div className="actions end" style={{ gridColumn: "1 / -1" }}><Btn kind="primary" disabled={!na.name.trim()} onClick={() => run(async () => { await post("/admin/accounts", { ...na, opening_paise: Math.round(Number(na.opening || 0) * 100) }); setNa({ name: "", account_no: "", opening: "", opening_date: todayIso(), is_default: false }); await q.reload(); }, "Bank added · reload to see it in the pickers")}>Add bank</Btn></div>
    </div></details>
  </Card>;
}

const TERM_LABELS = { commission_bp: "Commission %", commission_gst_bp: "GST on commission %", commission_rcm_bp: "GST under reverse charge %", payment_fee_bp: "Payment fee %", tcs_bp: "TCS %", tds_bp: "TDS %" } as const;
const TERM_HINTS: Partial<Record<keyof typeof TERM_LABELS, string>> = { commission_gst_bp: "18 for Indian OTAs; 0 if the commission already includes GST", commission_rcm_bp: "18 for a foreign OTA that invoices without GST (Booking.com B.V.): the hotel pays it; shown on the GST sheet, not deducted from the payout" };

/** Channel payout terms, typed as percentages (stored as basis points: 18% = 1800). */
/** Common areas and the equipment in each, so the desks can book maintenance against the right machine. */
function AreasEquipment({ refs }: { refs: Ref }) {
  const areas = refs.locations.filter((l) => l.kind === "area");
  const [newArea, setNewArea] = useState(""); const [add, setAdd] = useState<Record<string, string>>({});
  const reload = () => location.reload();
  return <Card title="Areas & equipment" sub="common areas, and the equipment in each that maintenance tasks can name">
    {areas.map((a) => { const eq = (refs.equipment ?? []).filter((e) => e.location_id === a.id); return <div className="row" key={a.id}><div style={{ flex: 1 }}><div><b>{a.name}</b></div>
      <div className="chips" style={{ marginTop: "6px" }}>{eq.length === 0 ? <span className="sub">no equipment listed</span> : eq.map((e) => <span key={e.id} className="status muted">{e.name} <button type="button" className="linkbtn" aria-label={`Retire ${e.name}`} onClick={async () => { if (await askConfirm(`Retire ${e.name}?`, "It stops being offered for new tasks; past tasks keep it.", { ok: "Retire", danger: true })) await run(async () => { await patch(`/admin/equipment/${e.id}`, { active: false }); reload(); }); }}>×</button></span>)}</div>
      <div className="actions" style={{ marginTop: "8px" }}><input aria-label={`Add equipment to ${a.name}`} className="noteinput" placeholder="Add equipment, e.g. Dishwasher" value={add[a.id] ?? ""} onChange={(ev: any) => setAdd({ ...add, [a.id]: ev.currentTarget.value })} /><Btn small disabled={!(add[a.id] ?? "").trim()} onClick={() => run(async () => { await post("/admin/equipment", { location_id: a.id, names: (add[a.id] ?? "").split(",").map((x) => x.trim()).filter(Boolean) }); reload(); }, "Equipment added")}>Add</Btn></div></div></div>; })}
    <div className="actions" style={{ marginTop: "12px" }}><input aria-label="New common area" className="noteinput" placeholder="New common area, e.g. Laundry" value={newArea} onChange={(e: any) => setNewArea(e.currentTarget.value)} /><Btn small disabled={!newArea.trim()} onClick={() => run(async () => { await post("/admin/locations", { name: newArea.trim() }); reload(); }, "Area added")}>Add area</Btn></div>
  </Card>;
}

function ChannelEdit({ c }: { c: any }) {
  const [f, setF] = useState({ commission_bp: c.commission_bp, commission_gst_bp: c.commission_gst_bp ?? 0, commission_rcm_bp: c.commission_rcm_bp ?? 0, payment_fee_bp: c.payment_fee_bp, tcs_bp: c.tcs_bp, tds_bp: c.tds_bp });
  return <div className="grid two">{(Object.keys(TERM_LABELS) as (keyof typeof TERM_LABELS)[]).map((k) => <Field key={k} label={TERM_LABELS[k]} hint={TERM_HINTS[k]}><input type="number" inputMode="decimal" step="0.01" min="0" value={f[k] / 100} onChange={(e: any) => setF({ ...f, [k]: Math.round(Number(e.currentTarget.value) * 100) })} /></Field>)}<div className="actions end"><Btn small kind="primary" onClick={() => run(async () => { await patch(`/admin/channels/${c.id}`, f); }, "Terms updated · audited")}>Save</Btn></div></div>;
}

export function MonthClose({ me }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/close/${period}`), [period]);
  const lock = () => run(async () => { const r = await post(`/close/${period}/lock`); toast(`Locked · pack v${r.version} stored`); await q.reload(); });
  const unlock = async () => { const reason = await askText("Unlock this month?", "Reason", { ok: "Unlock", danger: true, body: "Re-locking creates a revised pack." }); if (reason) await run(async () => { const r = await post(`/close/${period}/unlock`, { reason }); if (r.warning) await tell("GST was already filed for this period", "The next lock produces a revised pack and an amendment will be needed."); await q.reload(); }, "Unlocked"); };
  return <>
    <div className="pagehead"><h1>Month close <small>three steps each month; once locked, nobody can change the month without unlocking it</small></h1><MonthPick value={period} onChange={setPeriod} /></div>
    {!q.data ? <Loading error={q.error} /> : <>
      <Card><CloseSteps lock={q.data.lock} period={period} />
        <div className="actions end">{q.data.lock.status === "precleared" && <Btn kind="primary" onClick={lock}>Lock {period}</Btn>}{["locked", "filed"].includes(q.data.lock.status) && <Btn kind="danger" onClick={unlock}>Unlock {period}</Btn>}</div></Card>
      <Card title="Checks before the close" sub={q.data.lock.status === "open" ? "the revenue desk fixes these, or carries them with a note" : "as they stand now"}><CloseChecklist me={me} period={period} counts={q.data.exception_counts} /></Card>
      <Card title="Statement packs" sub="the month's registers as files, kept for every version">{q.data.packs.length === 0 ? <Empty>The pack is made when the month is locked.</Empty> : q.data.packs.map((pk: any) => <div className="row" key={pk.id}><div><div>Pack v{pk.version}{pk.revised ? " · revised" : ""}</div><div className="sub">{fmtDateTime(pk.created_at)}</div></div><div className="actions">{Object.keys(JSON.parse(pk.keys_json)).map((f) => <a key={f} className="btn small" href={`/api/close/${period}/pack/${pk.version}/${f}`} download>{f}</a>)}</div></div>)}</Card></>}
  </>;
}

/** Month picker that sits beside a page title. */
function MonthPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <label className="monthpick"><span>Month</span><input type="month" value={value} onChange={(e: any) => e.currentTarget.value && onChange(e.currentTarget.value)} /></label>;
}

export function GstSheet({ me }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/close/${period}/gst`), [period]);
  const lock = useLoad(() => get(`/close/${period}`), [period]);
  const st = lock.data?.lock.status;
  return <>
    <div className="pagehead"><h1>GST filing sheet <small>the GSTR-1 and GSTR-3B figures, ready to check and file</small></h1><MonthPick value={period} onChange={setPeriod} /></div>
    {!me.property.gstin && <div className="queue">No GSTIN on the property: nothing to file yet. Invoices carry no GST until the owner enters the GSTIN under Settings.</div>}
    {!q.data ? <Loading error={q.error} /> : <>
      <div className="kpi">
        <div className="k"><small>Output GST payable</small><b>{inr(q.data.output_gst_paise)}</b></div>
        {q.data.reverse_charge.igst_paise > 0 && <div className="k"><small>IGST under reverse charge</small><b>{inr(q.data.reverse_charge.igst_paise)}</b><span className="sub">on foreign OTA commission</span></div>}
        <div className="k"><small>Taxable value</small><b>{inr(q.data.by_slab.reduce((t: number, x: any) => t + x.taxable_paise, 0) - q.data.credit_notes.taxable_paise)}</b></div>
        <div className="k"><small>Filing status</small><b>{st ? <Status s={st === "open" || st === "precleared" ? "waiting" : st} /> : "—"}</b>
          <span className="sub">{st === "filed" ? "filed" : st === "locked" ? "locked · ready to file" : "lock the month before filing"}</span>
          {st === "locked" && <div style={{ marginTop: "10px" }}><Btn kind="primary" small onClick={() => run(async () => { await post(`/close/${period}/file`, {}); await lock.reload(); }, "Marked filed")}>Mark filed</Btn></div>}</div>
      </div>
      <Card title="Output tax" sub="GSTR-1 and table 3.1 of GSTR-3B">{q.data.by_slab.length === 0 ? <Empty>No taxable supplies in {period}.</Empty> : q.data.by_slab.map((s: any) => <Row key={s.rate_pct} label={`Taxable value @ ${s.rate_pct}%`} value={inr(s.taxable_paise)} sub={`GST ${inr(s.gst_paise)}`} />)}{q.data.credit_notes.taxable_paise > 0 && <Row label="Less credit notes" value={`− ${inr(q.data.credit_notes.taxable_paise)}`} sub={`GST − ${inr(q.data.credit_notes.gst_paise)}`} />}<Row strong label="Output GST" value={inr(q.data.output_gst_paise)} />
        {q.data.advances_received_for_future_stays.n > 0 && <div className="note" style={{ marginTop: "12px" }}>Advances received this month for later stays: <b>{inr(q.data.advances_received_for_future_stays.paise)}</b>. Confirm the time-of-supply treatment.</div>}</Card>
      <div className="grid two"><Card title="TCS deducted by OTAs" sub="accept on the GST portal">{q.data.tcs.length === 0 ? <Empty>None this month.</Empty> : q.data.tcs.map((t: any) => <Row key={t.status} label={`${t.n} settlement${t.n > 1 ? "s" : ""} · ${t.status}`} value={inr(t.amount_paise)} />)}</Card><Card title="TDS under 194-O" sub="verify in 26AS / AIS">{q.data.tds.length === 0 ? <Empty>None this month.</Empty> : q.data.tds.map((t: any) => <Row key={t.status} label={`${t.n} settlement${t.n > 1 ? "s" : ""} · ${t.status}`} value={inr(t.amount_paise)} />)}</Card></div>
      <Card title="GST under reverse charge (RCM)" sub={q.data.reverse_charge.note}>{q.data.reverse_charge.lines.length === 0 ? <Empty>No foreign OTA charges in {period}.</Empty> : <>
        {q.data.reverse_charge.lines.map((l: any) => <Row key={l.settlement_id} label={`${l.channel} · payout ${l.payout_ref}`} sub={`${fmtDate(l.payout_on)} · commission and payment charge ${inr(l.value_paise)} · IGST @ ${l.rate_pct}%`} value={inr(l.igst_paise)} />)}
        <Row strong label="IGST payable under reverse charge" sub={`on ${inr(q.data.reverse_charge.value_paise)} of OTA charges`} value={inr(q.data.reverse_charge.igst_paise)} /></>}</Card>
      <Card title="GST on purchases" sub={q.data.input_gst_on_purchases.note}><Row label={`${q.data.input_gst_on_purchases.n} bill${q.data.input_gst_on_purchases.n === 1 ? "" : "s"} with GST`} value={inr(q.data.input_gst_on_purchases.gst_paise)} /></Card>
      <Card title="Corrections in the month" sub="records edited or voided after they were made, for review before filing" actions={canOpen(me, "audit") ? <a className="btn small" href="#audit">Open the change log</a> : undefined}><Row label={`${q.data.change_log.length} correction${q.data.change_log.length === 1 ? "" : "s"} in ${period}`} value={q.data.change_log.length ? `latest ${fmtDateTime(q.data.change_log[q.data.change_log.length - 1].at)}` : "none"} /></Card></>}
  </>;
}

export function AuditLog({ }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const [limit, setLimit] = useState(100);
  const q = useLoad(() => get(`/reports/audit?period=${period}`), [period]);
  return <>
    <div className="pagehead"><h1>Change log <small>every change to the books: who, when, before and after</small></h1><MonthPick value={period} onChange={(v) => { setPeriod(v); setLimit(100); }} /></div>
    {!q.data ? <Loading error={q.error} /> : q.data.audit.length === 0 ? <Empty>Nothing in {period}.</Empty> : <Card title={`${q.data.audit.length} entries`} actions={q.data.audit.length > limit && <Btn small onClick={() => setLimit(limit + 200)}>Show {Math.min(200, q.data.audit.length - limit)} more</Btn>}>{q.data.audit.slice(0, limit).map((a: any) => <div className="row" key={a.id}><div><div><b>{actionLabel(a.action)}</b> <span className="mono muted">{a.entity_id}</span></div><div className="sub">{a.actor_email} · {fmtDateTime(a.at)}</div>{(a.before_json || a.after_json) && <details><summary>detail</summary><div className="pre">{a.before_json && `before: ${a.before_json}\n`}{a.after_json && `after: ${a.after_json}`}</div></details>}</div></div>)}</Card>}
  </>;
}
