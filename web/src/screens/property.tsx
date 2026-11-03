import { useEffect, useState } from "react";
import { get, post, patch, uploadFile } from "../api";
import { submit, readQueue, onQueueChange, dropQueued, flush } from "../offline";
import { Card, Row, Btn, Chips, Field, Status, Empty, Loading, Keypad, inr, fmtDate, useLoad, run, toast, todayIso, thisPeriod, CategoryPicker, BankPick, defaultBankId, askConfirm, askText, ScrollX } from "../ui";
import { catLabel, type Me, type Ref } from "../app";
import { idsHref } from "./ids";
import { Icon } from "../icons";

// Times typed at the front desk are the property's local time (India, +05:30), whatever time zone the
// computer or phone entering them is set to (the owner may be abroad).
const PROPERTY_OFFSET = "+05:30";
const atProperty = (local: string) => `${local}:00${PROPERTY_OFFSET}`;
const nowAtProperty = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 16);

export function FrontDesk({ }: { me: Me; refs: Ref }) {
  const q = useLoad(() => get("/bookings/frontdesk/today"), []);
  const [result, setResult] = useState<any>(null);
  const act = (id: string, verb: string, msg: string, payload?: any) => run(async () => { const r = await post(`/bookings/${id}/${verb}`, payload); setResult(verb === "check-out" ? { id, ...r } : null); await q.reload(); }, msg);
  // No-show cancels the stay, releases the room and blocks payments; it cannot be undone from the desk.
  const noShow = async (b: any) => { if (await askConfirm(`Mark ${b.guest_name} as a no-show?`, "The room is released and payments can no longer be recorded on this booking. This cannot be undone from the front desk.", { ok: "Mark no-show", danger: true })) await act(b.id, "no-show", "No-show recorded"); };
  const [arrived, setArrived] = useState<Record<string, string>>({});
  const [left, setLeft] = useState<Record<string, string>>({});
  // A stay that has already ended: record arrival and departure in one go (check-in, then check-out with the real times).
  const inAndOut = (b: any, arrivedAt: string, leftAt: string) => run(async () => {
    await post(`/bookings/${b.id}/check-in`, { arrived_at: atProperty(arrivedAt) });
    const r = await post(`/bookings/${b.id}/check-out`, { departed_at: atProperty(leftAt) });
    setResult({ id: b.id, ...r }); await q.reload();
  }, "Checked in and out ✓");
  const List = ({ title, rows, verb, label }: any) => <Card title={title}>{rows.length === 0 ? <Empty>None today.</Empty> : rows.map((b: any) => <div className="row" key={b.id}><div><div>{b.guest_name} · {b.room_names}</div><div className="sub">{b.channel_name} · {b.collection_type === "channel_collect" ? "OTA collect — nothing to take" : b.paid_paise >= b.gross_paise ? "paid ✓" : `balance ${inr(b.gross_paise - b.paid_paise)}`} · {fmtDate(b.check_in)}→{fmtDate(b.check_out)}</div></div><div className="actions"><Status s={b.status} /><a className={`btn small${b.doc_count ? "" : " gold"}`} href={idsHref(b.id)}>{b.doc_count ? `ID ✓ ${b.doc_count}` : "ID proof"}</a>{verb && <Btn small kind="primary" onClick={() => act(b.id, verb, label + " ✓")}>{label}</Btn>}{verb === "check-in" && <Btn small kind="danger" onClick={() => noShow(b)}>No-show</Btn>}</div></div>)}</Card>;
  if (!q.data) return <Loading error={q.error} />;
  return <>
    <h1>Front desk <small>{fmtDate(q.data.date)} · one-tap check-in/out</small></h1>
    {result && <Card tone="ok" title="Checked out" sub={result.collection_type === "channel_collect" ? "OTA collect: housekeeping task created, nothing to collect" : result.balance_due_paise > 0 ? `Collect the balance, then issue the invoice` : "Fully paid — issue the invoice"}>
      <Row label="Gross" value={inr(result.gross_paise)} /><Row label="Paid" value={inr(result.paid_paise)} /><Row strong label="Balance due" value={inr(result.balance_due_paise)} />
      <div className="actions end">{result.balance_due_paise > 0 && <a className="btn gold" href={`#pay`} onClick={() => sessionStorage.setItem("avos.collect", result.id)}>Collect {inr(result.balance_due_paise)}</a>}{result.collection_type !== "channel_collect" && <Btn kind="primary" onClick={() => run(async () => { const inv = await post(`/invoices/bookings/${result.id}`); window.open(`/api/invoices/${inv.id}/html`, "_blank"); }, "Invoice issued")}>Issue invoice</Btn>}</div></Card>}
    {(q.data.late_arrivals ?? []).length > 0 && <Card tone="amb" title="Not checked in yet" sub="the stay has started (or already ended) but nobody checked the guest in · set when they arrived, and when they left if the stay is over">
      {q.data.late_arrivals.map((b: any) => { const val = arrived[b.id] ?? `${b.check_in}T14:00`; const ended = b.check_out < q.data.date; const leftVal = left[b.id] ?? `${b.check_out}T11:00`; const nowLocal = nowAtProperty(); return <div className="row lrow" key={b.id}>
        <div><div><b>{b.guest_name}</b> · {b.room_names}</div><div className="sub">{b.channel_name} · {b.collection_type === "channel_collect" ? "OTA collect — nothing to take" : b.paid_paise >= b.gross_paise ? "paid ✓" : `balance ${inr(b.gross_paise - b.paid_paise)}`} · {fmtDate(b.check_in)}→{fmtDate(b.check_out)}</div></div>
        <div className="actions"><Status s={b.status} /><a className={`btn small${b.doc_count ? "" : " gold"}`} href={idsHref(b.id)}>{b.doc_count ? `ID ✓ ${b.doc_count}` : "ID proof"}</a>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>Arrived <input type="datetime-local" value={val} min={`${b.check_in}T00:00`} max={nowLocal} onChange={(e: any) => setArrived({ ...arrived, [b.id]: e.currentTarget.value })} /></label>
          {ended && <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>Left <input type="datetime-local" value={leftVal} min={val} max={nowLocal} onChange={(e: any) => setLeft({ ...left, [b.id]: e.currentTarget.value })} /></label>}
          {ended
            ? <Btn small kind="primary" disabled={b.status !== "approved" || leftVal < val} title={b.status === "provisional" ? "awaiting approval by the revenue desk" : undefined} onClick={() => inAndOut(b, val, leftVal)}>Check in &amp; out</Btn>
            : <Btn small kind="primary" disabled={b.status !== "approved"} title={b.status === "provisional" ? "awaiting approval by the revenue desk" : undefined} onClick={() => act(b.id, "check-in", "Checked in ✓", { arrived_at: atProperty(val) })}>Check in</Btn>}
          <Btn small kind="danger" onClick={() => noShow(b)}>No-show</Btn></div>
      </div>; })}
    </Card>}
    <List title="Arrivals · today" rows={q.data.arrivals} verb="check-in" label="Check in" />
    <List title="Departures · today" rows={q.data.departures} verb="check-out" label="Check out" />
    <List title="In house" rows={q.data.in_house} verb="check-out" label="Check out" />
  </>;
}

const METHODS = [["upi", "UPI"], ["cash", "Cash"], ["card", "Card (POS)"], ["airpay", "Airpay link"], ["bank", "Bank"]] as const;

export function Payments({ me, refs }: { me: Me; refs: Ref }) {
  const due = useLoad(() => get("/payments/due"), []);
  const gw = useLoad(() => get("/payments/gateway-inbox"), []);
  const recent = useLoad(() => get("/payments"), []);
  const seeBalances = me.capabilities.includes("balances");
  const takesCash = me.actor.role !== "sales"; // sales take UPI, bank, card or Airpay; cash is collected at the property
  const accounts = useLoad(() => seeBalances ? get("/payments/accounts") : Promise.resolve(null), []);
  const [sel, setSel] = useState<any>(null); const [amt, setAmt] = useState(0); const [method, setMethod] = useState<string>("upi"); const [refn, setRefn] = useState("");
  const [bankId, setBankId] = useState(defaultBankId(refs.accounts));
  useEffect(() => { const pre = sessionStorage.getItem("avos.collect"); if (pre && due.data) { const d = due.data.due.find((x: any) => x.booking_id === pre); if (d) { setSel(d); setAmt(d.balance_paise); } sessionStorage.removeItem("avos.collect"); } }, [due.data]);
  const record = () => run(async () => {
    const r = await submit("POST", "/payments", { booking_id: sel?.booking_id ?? null, method, amount_paise: amt, reference: refn || null, account_id: ["upi", "bank"].includes(method) ? bankId || undefined : undefined }, `Collect ${inr(amt)} · ${sel?.guest_name ?? "walk-in"}`);
    if (r.queued) toast("Saved offline · will sync"); else toast(`Posted · ${r.result.fee_expense_id ? "fee booked once" : "no fee"} · balance ${inr(r.result.balance_paise)}`);
    setSel(null); setAmt(0); setRefn(""); await Promise.all([due.reload(), recent.reload(), accounts.reload()]);
  });
  const confirmGw = (it: any) => run(async () => { await post("/payments", { booking_id: it.suggested_booking?.id ?? null, method: "airpay", amount_paise: it.parsed.amount_paise, reference: it.parsed.order_id, inbox_item_id: it.id }); await Promise.all([gw.reload(), recent.reload(), due.reload()]); }, "Confirmed · matched to stay");
  const [trf, setTrf] = useState({ from_account_id: "", to_account_id: "", amount_paise: 0, reference: "" });
  return <>
    <h1>Payments <small>advances and part-payments welcome; gateway fees are booked automatically</small></h1>
    <div className="grid two">
      <Card title={takesCash ? "Collect at property" : "Balances due"} sub="pre-filtered to who owes money">{!due.data ? <Loading /> : due.data.due.length === 0 ? <Empty>Nobody owes money.</Empty> : due.data.due.map((d: any) => <div className="row" key={d.booking_id}><div><div>{d.guest_name} {d.overdue ? <Status s="left owing" /> : d.due_today && <Status s="due today" />}</div><div className="sub">{fmtDate(d.check_in)}→{fmtDate(d.check_out)} · {d.status.replace("_", " ")} · balance of {inr(d.gross_paise)} stay</div></div><div className="actions"><b className="num">{inr(d.balance_paise)}</b><Btn small kind="primary" onClick={() => { setSel(d); setAmt(d.balance_paise); }}>Collect</Btn></div></div>)}</Card>
      <Card title={sel ? `${sel.guest_name} · ${inr(sel.balance_paise)}` : "Record a payment"} sub={sel ? "exact balance = one tap; tap the figure for a different amount" : "pick a guest on the left, or record a walk-in collection"}>
        <Keypad value={amt} onChange={setAmt} />
        <Chips value={method} options={METHODS.filter(([v]) => v !== "cash" || takesCash).map(([v, l]) => ({ value: v, label: l }))} onChange={setMethod} />
        {["upi", "bank"].includes(method) && <BankPick accounts={refs.accounts} value={bankId} onChange={setBankId} label="Received into" />}
        <Field label="Reference (optional — UPI apps show it)"><input value={refn} onChange={(e: any) => setRefn(e.currentTarget.value)} /></Field>
        <div className="actions end">{sel && <Btn onClick={() => { setSel(null); setAmt(0); }}>Clear</Btn>}<Btn kind="gold" disabled={amt <= 0} onClick={record}>Collected {inr(amt)}</Btn></div></Card>
    </div>
    {gw.data && gw.data.items.length > 0 && <Card title="From inbox · Airpay" sub="order-id prefix match to the SwiftBook itinerary">{gw.data.items.map((it: any) => <div className="row" key={it.id}><div><div>Order <span className="mono">{it.parsed.order_id}</span> · {inr(it.parsed.amount_paise)} · payer {it.parsed.payer_name ?? "?"}</div><div className="sub">{it.suggested_booking ? `Matched — ${it.suggested_booking.guest_name} (itinerary ${it.suggested_booking.external_ref})` : "No stay matched: confirm as an unlinked receipt or dismiss"}</div></div><div className="actions"><Btn small kind="primary" onClick={() => confirmGw(it)}>Confirm</Btn><Btn small onClick={() => run(async () => { await post(`/inbox/${it.id}/dismiss`, { reason: "not ours" }); await gw.reload(); }, "Dismissed")}>Dismiss</Btn></div></div>)}</Card>}
    <div className="grid two">
      {(seeBalances || me.capabilities.includes("transfers")) && <Card title={seeBalances ? "Money accounts" : "Cash deposits and top-ups"} sub={seeBalances ? "who holds the money records it" : "count the cash you hold and record what you deposit; the revenue desk checks it against the books"}>{seeBalances && (!accounts.data ? <Loading /> : accounts.data.accounts.map((a: any) => <Row key={a.id} label={a.name} sub={`${a.kind.replace("_", " ")} · ${a.holder_role}`} value={inr(a.balance_paise)} />))}
        {me.capabilities.includes("transfers") && <details><summary>Deposit cash / top up petty cash (a transfer, never an expense)</summary>
          <Field label="From"><select value={trf.from_account_id} onChange={(e: any) => setTrf({ ...trf, from_account_id: e.currentTarget.value })}><option value="">—</option>{refs.accounts.map((a) => <option value={a.id}>{a.name}</option>)}</select></Field>
          <Field label="To"><select value={trf.to_account_id} onChange={(e: any) => setTrf({ ...trf, to_account_id: e.currentTarget.value })}><option value="">—</option>{refs.accounts.map((a) => <option value={a.id}>{a.name}</option>)}</select></Field>
          <Field label="Amount (₹)"><input inputMode="decimal" onChange={(e: any) => setTrf({ ...trf, amount_paise: Math.round(Number(e.currentTarget.value) * 100) })} /></Field><Field label="Reference"><input value={trf.reference} onChange={(e: any) => setTrf({ ...trf, reference: e.currentTarget.value })} /></Field>
          <div className="actions end"><Btn kind="primary" onClick={() => run(async () => { await post("/payments/transfers", trf); await accounts.reload(); }, "Transfer recorded")}>Record transfer</Btn></div></details>}</Card>}
      {me.capabilities.includes("other_income") && <OtherIncome onChange={() => accounts.reload()} />}
      <Card title="Recent payments">{!recent.data ? <Loading /> : recent.data.payments.length === 0 ? <Empty>None yet.</Empty> : recent.data.payments.slice(0, 15).map((p: any) => <div className="row" key={p.id}><div><div>{p.guest_name ?? "—"} · {p.method} · {p.kind} {p.status === "void" && <Status s="void" />}</div><div className="sub">{fmtDate(p.received_on)} · {p.account_name}{p.reference ? ` · ${p.reference}` : ""}{p.fee_paise ? ` · fee ${inr(p.fee_paise)}` : ""}</div></div><div className="actions"><b className="num">{p.kind === "refund" ? "−" : ""}{inr(p.amount_paise)}</b>{p.status !== "void" && p.status !== "matched" && <Btn small kind="danger" onClick={async () => { const reason = await askText("Void this payment?", "Reason", { ok: "Void", danger: true, body: "Any gateway fee booked with it is reversed too." }); if (reason) await run(async () => { await post(`/payments/${p.id}/void`, { reason }); await Promise.all([recent.reload(), accounts.reload(), due.reload()]); }, "Voided · fee followed"); }}>Void</Btn>}</div></div>)}</Card>
    </div>
  </>;
}

const INCOME_CATEGORIES = [["dining", "Meals / dining"], ["photo", "Photoshoot"], ["events", "Event / venue"], ["transport", "Transport"], ["other", "Other"]] as const;
const GST_CHOICES = [["0", "No GST"], ["500", "5%"], ["1800", "18%"]] as const;

/** Money earned outside room stays — day-guest meals, photoshoots, events. Lands in the cash ledger, the revenue overview and the GST sheet. */
export function OtherIncome({ onChange }: { onChange: () => void }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/income?period=${period}`), [period]);
  const [f, setF] = useState({ on_date: todayIso(), category: "dining" as string, description: "", payer_name: "", amount_paise: 0, gst_rate_bp: "0", method: "cash" as string, reference: "" });
  const save = () => run(async () => {
    await post("/income", { ...f, gst_rate_bp: Number(f.gst_rate_bp), payer_name: f.payer_name || null, reference: f.reference || null });
    setF({ ...f, description: "", payer_name: "", amount_paise: 0, reference: "" }); await q.reload(); onChange();
  }, "Income recorded");
  return <Card title="Other income" sub="meals for day guests, photoshoots, events — not room stays">
    <details><summary>Record other income</summary>
      <Field label="Date"><input type="date" value={f.on_date} onChange={(e: any) => setF({ ...f, on_date: e.currentTarget.value })} /></Field>
      <Chips value={f.category} options={INCOME_CATEGORIES.map(([v, l]) => ({ value: v, label: l }))} onChange={(v) => setF({ ...f, category: v })} />
      <Field label="What"><input value={f.description} placeholder="Lunch sadhya × 9" onChange={(e: any) => setF({ ...f, description: e.currentTarget.value })} /></Field>
      <Field label="Who paid (optional)"><input value={f.payer_name} onChange={(e: any) => setF({ ...f, payer_name: e.currentTarget.value })} /></Field>
      <Field label="Amount collected (₹, incl. GST)"><input inputMode="decimal" value={f.amount_paise ? String(f.amount_paise / 100) : ""} onChange={(e: any) => setF({ ...f, amount_paise: Math.round(Number(e.currentTarget.value) * 100) })} /></Field>
      <Field label="GST"><Chips value={f.gst_rate_bp} options={GST_CHOICES.map(([v, l]) => ({ value: v, label: l }))} onChange={(v) => setF({ ...f, gst_rate_bp: v })} /></Field>
      <Field label="Received by"><Chips value={f.method} options={METHODS.map(([v, l]) => ({ value: v, label: l }))} onChange={(v) => setF({ ...f, method: v })} /></Field>
      <Field label="Reference (optional)"><input value={f.reference} onChange={(e: any) => setF({ ...f, reference: e.currentTarget.value })} /></Field>
      <div className="actions end"><Btn kind="gold" disabled={f.amount_paise <= 0 || !f.description} onClick={save}>Record {inr(f.amount_paise)}</Btn></div>
    </details>
    <Field label="Month"><input type="month" value={period} onChange={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    {!q.data ? <Loading error={q.error} /> : q.data.income.length === 0 ? <Empty>No other income in {period}.</Empty> : q.data.income.map((i: any) => <div className="row" key={i.id}><div><div>{i.description}{i.payer_name ? ` · ${i.payer_name}` : ""} {i.voided_at && <Status s="void" />}</div><div className="sub">{fmtDate(i.on_date)} · {i.category} · {i.method} · {i.account_name}{i.gst_paise ? ` · GST ${inr(i.gst_paise)} @ ${i.gst_rate_bp / 100}%` : " · no GST"}</div></div><div className="actions"><b className="num">{inr(i.amount_paise)}</b>{!i.voided_at && <Btn small kind="danger" onClick={async () => { const reason = await askText("Void this income?", "Reason", { ok: "Void", danger: true }); if (reason) await run(async () => { await post(`/income/${i.id}/void`, { reason }); await q.reload(); onChange(); }, "Voided"); }}>Void</Btn>}</div></div>)}
  </Card>;
}

export function Invoices({ }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/invoices?period=${period}`), [period]);
  const out = useLoad(() => get("/bookings?status=checked_out"), []);
  return <>
    <h1>Guest invoices <small>numbered in sequence each financial year; a cancellation issues a credit note</small></h1>
    <Field label="Month"><input type="month" value={period} onChange={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    {out.data && out.data.bookings.filter((b: any) => !b.invoice_number && b.collection_type !== "channel_collect").length > 0 && <Card tone="amb" title="Checked out, not yet invoiced">{out.data.bookings.filter((b: any) => !b.invoice_number && b.collection_type !== "channel_collect").map((b: any) => <div className="row" key={b.id}><div>{b.guest_name} · {fmtDate(b.check_out)} · {inr(b.gross_paise)}</div><Btn small kind="primary" onClick={() => run(async () => { const inv = await post(`/invoices/bookings/${b.id}`); window.open(`/api/invoices/${inv.id}/html`, "_blank"); await Promise.all([q.reload(), out.reload()]); }, "Issued")}>Issue invoice</Btn></div>)}</Card>}
    <Card>{!q.data ? <Loading error={q.error} /> : q.data.invoices.length === 0 ? <Empty>No invoices in {period}.</Empty> : <ScrollX><table className="t"><thead><tr><th>Number</th><th>Date</th><th>Guest</th><th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th><th className="num">Balance</th><th></th></tr></thead><tbody>{q.data.invoices.map((i: any) => <tr key={i.id}><td className="mono">{i.number}</td><td>{fmtDate(i.issued_on)}</td><td>{i.guest_name}</td><td className="num">{inr(i.taxable_paise)}</td><td className="num">{inr(i.gst_paise)}</td><td className="num">{inr(i.total_paise)}</td><td className="num">{inr(i.balance_paise)}</td><td className="actions"><a className="btn small" href={`/api/invoices/${i.id}/html`} target="_blank">PDF / print</a><a className="btn small" href={`https://wa.me/${i.guest_phone ?? ""}?text=${encodeURIComponent(`Invoice ${i.number} for your stay: total ${inr(i.total_paise)}. Thank you!`)}`} target="_blank">WhatsApp</a>{i.status === "issued" && <Btn small kind="danger" onClick={async () => { const reason = await askText(`Issue a credit note against ${i.number}?`, "Reason", { ok: "Issue credit note", danger: true }); if (reason) await run(async () => { await post(`/invoices/${i.id}/credit-notes`, { reason }); await q.reload(); }, "Credit note issued"); }}>Credit note</Btn>}</td></tr>)}</tbody></table></ScrollX>}</Card>
  </>;
}

/** A task's notes log (each line: when · who: what) and a box to add the next note. */
function TaskNotes({ t, onAdded }: { t: any; onAdded: () => Promise<void> | void }) {
  const [text, setText] = useState("");
  const add = () => run(async () => { await post(`/tasks/${t.id}/notes`, { text }); setText(""); await onAdded(); }, "Note added");
  return <div className="tasknotes">
    {t.notes ? <div className="pre">{t.notes}</div> : <div className="muted">No notes yet.</div>}
    <div className="actions" style={{ marginTop: "8px" }}><input aria-label={`Add a note to ${t.title}`} placeholder="Add a note: what was found, who came, parts ordered…" value={text} onChange={(e: any) => setText(e.currentTarget.value)} style={{ flex: 1, minWidth: "200px" }} className="noteinput" /><Btn small disabled={!text.trim()} onClick={add}>Add note</Btn></div>
  </div>;
}

export function Tasks({ refs }: { me: Me; refs: Ref }) {
  const q = useLoad(() => get("/tasks"), []);
  const done = useLoad(() => get("/tasks?status=done"), []);
  const [bill, setBill] = useState<Record<string, { amount: string; vendor: string; gstin: string; photo?: string }>>({});
  const setStatus = (id: string, status: string, extra?: any) => run(async () => { await post(`/tasks/${id}/status`, { status, ...extra }); await Promise.all([q.reload(), done.reload()]); }, status === "done" ? "Done · logged" : "Started");
  return <>
    <h1>Tasks <small>housekeeping and maintenance; marking one done can attach the bill and record the expense</small></h1>
    {!q.data ? <Loading error={q.error} /> : q.data.tasks.length === 0 ? <Empty>No open tasks. Use + to add one.</Empty> : q.data.tasks.map((t: any) => <Card key={t.id} tone={t.priority === "high" ? "bad" : undefined} title={<>{t.kind} · {t.location_name}{t.equipment_name ? ` · ${t.equipment_name}` : ""} {t.priority === "high" && <Status s="high" />}<Status s={t.status} /></>} sub={<>{t.title}{t.due_on ? ` · due ${fmtDate(t.due_on)}` : ""}{t.photo_key ? " · photo attached" : ""}</>}>
      <TaskNotes t={t} onAdded={() => q.reload()} />
      {t.status !== "done" && <details><summary>Done + attach bill (posts from petty cash)</summary>
        <div className="grid two"><Field label="Amount incl. GST (₹)"><input inputMode="decimal" value={bill[t.id]?.amount ?? ""} onChange={(e: any) => setBill({ ...bill, [t.id]: { ...(bill[t.id] ?? { vendor: "", gstin: "" }), amount: e.currentTarget.value } })} /></Field><Field label="Vendor"><input value={bill[t.id]?.vendor ?? ""} onChange={(e: any) => setBill({ ...bill, [t.id]: { ...(bill[t.id] ?? { amount: "", gstin: "" }), vendor: e.currentTarget.value } })} /></Field>
        <Field label="Vendor GSTIN (format-validated)"><input value={bill[t.id]?.gstin ?? ""} onChange={(e: any) => setBill({ ...bill, [t.id]: { ...(bill[t.id] ?? { amount: "", vendor: "" }), gstin: e.currentTarget.value } })} /></Field><Field label="Bill photo"><input type="file" accept="image/*" capture="environment" onChange={async (e: any) => { const f = e.currentTarget.files?.[0]; if (f) { const key = await uploadFile(f, "bill"); setBill({ ...bill, [t.id]: { ...(bill[t.id] ?? { amount: "", vendor: "", gstin: "" }), photo: key } }); toast("Photo attached"); } }} /></Field></div>
        <div className="actions end"><Btn kind="primary" onClick={() => setStatus(t.id, "done", bill[t.id]?.amount ? { expense: { amount_paise: Math.round(Number(bill[t.id].amount) * 100), category: "repairs", vendor_name: bill[t.id].vendor || null, vendor_gstin: bill[t.id].gstin || null, bill_photo_key: bill[t.id].photo ?? null, gst_rate_bp: bill[t.id].gstin ? 1800 : 0 } } : {})}>Done{bill[t.id]?.amount ? ` + post ₹${bill[t.id].amount}` : ""}</Btn></div></details>}
      <div className="actions end">{t.status === "open" && <Btn onClick={() => setStatus(t.id, "in_progress")}>Start</Btn>}{t.status !== "done" && <Btn kind="primary" onClick={() => setStatus(t.id, "done")}>Done</Btn>}</div>
    </Card>)}
    {q.data && q.data.notes.length > 0 && <Card title="Notes · observations, no status flow">{q.data.notes.map((n: any) => <div className="row" key={n.id}><div><div>{n.location_name}{n.equipment_name ? ` · ${n.equipment_name}` : ""} — {n.title}</div>{n.notes && <div className="pre muted">{n.notes}</div>}<div className="sub">{fmtDate(n.created_at)}</div></div><Status s="noted" /></div>)}</Card>}
    {done.data && done.data.tasks.length > 0 && <details><summary>Done ({done.data.tasks.length})</summary>{done.data.tasks.map((t: any) => <div className="row" key={t.id}><div>{t.kind} · {t.location_name}{t.equipment_name ? ` · ${t.equipment_name}` : ""} · {t.title}{t.notes && <div className="pre muted">{t.notes}</div>}</div><div className="sub">{fmtDate(t.done_at)}{t.expense_id ? " · bill posted" : ""}</div></div>)}</details>}
  </>;
}


const SCOPES = [["petty", "Petty cash"], ["bank", "Bank-paid"], ["all", "All"]] as const;
export function Expenses({ me, refs }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const canSeeAll = me.capabilities.includes("pnl_reports"); const canSeeBank = me.capabilities.includes("bank_expenses");
  const [scope, setScope] = useState<"petty" | "bank" | "all">(canSeeAll ? "all" : "petty");
  const q = useLoad(() => get(`/expenses?scope=${scope}&period=${period}`), [period, scope]);
  const stmt = useLoad(() => get(`/expenses/petty-statement?period=${period}`), [period]);
  const seeBalances = me.capabilities.includes("balances");
  const accounts = useLoad(() => seeBalances ? get("/payments/accounts") : Promise.resolve(null), []);
  const [edit, setEdit] = useState<Record<string, any>>({});
  const petty = accounts.data?.accounts.find((a: any) => a.kind === "petty_cash");
  const st = stmt.data;
  const monthName = new Date(period + "-01T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const scopeOptions = SCOPES.filter(([v]) => v === "petty" || (v === "bank" && canSeeBank) || (v === "all" && canSeeAll)).map(([value, label]) => ({ value, label }));
  return <>
    <h1>Expenses & petty cash <small>petty cash is the property manager's float; the bank is the owner's</small></h1>
    {seeBalances ? <div className="kpi"><div className="k"><small>Petty cash in hand today</small><b>{petty ? inr(petty.balance_paise) : "—"}</b></div><div className="k"><small>Opening · carried into {monthName.split(" ")[0]}</small><b>{st?.opening_paise !== undefined ? inr(st.opening_paise) : "—"}</b></div><div className="k"><small>Spent in {monthName.split(" ")[0]} (petty)</small><b>{st ? inr(st.spent_paise) : "—"}</b></div><div className="k"><small>Top-ups in {monthName.split(" ")[0]}</small><b>{st ? inr(st.topups_paise) : "—"}</b></div></div>
      : <div className="kpi"><div className="k"><small>Spent from petty cash in {monthName.split(" ")[0]}</small><b>{st ? inr(st.spent_paise) : "—"}</b></div><div className="k"><small>Top-ups received in {monthName.split(" ")[0]}</small><b>{st ? inr(st.topups_paise) : "—"}</b></div><div className="k"><small>Bills this month</small><b>{q.data && scope === "petty" ? q.data.expenses.filter((e: any) => !e.voided_at).length : "—"}</b></div></div>}
    <Field label="Month"><input type="month" value={period} onChange={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    {seeBalances && <Card title={`Petty cash book · ${monthName}`} sub="the closing balance carries forward as next month's opening — the float is never reset" tone={st && st.closing_paise < 0 ? "amb" : undefined}>
      {!st ? <Loading error={stmt.error} /> : <>
        <Row label="Opening balance" sub="carried forward from the previous month" value={inr(st.opening_paise)} />
        {st.transfers.filter((t: any) => t.to_account_id === st.account.id).map((t: any) => <Row key={t.id} label={`+ Top-up from ${t.from_name}`} sub={`${fmtDate(t.on_date)}${t.note ? ` · ${t.note}` : ""}`} value={inr(t.amount_paise)} />)}
        {st.received_paise !== 0 && <Row label="+ Received into petty cash" sub="collections or other income recorded against this float" value={inr(st.received_paise)} />}
        <Row label="− Spent from petty cash" sub={`${q.data && scope === "petty" ? q.data.expenses.filter((e: any) => !e.voided_at).length + " bills · " : ""}see the list below`} value={inr(st.spent_paise)} />
        {st.transfers.filter((t: any) => t.from_account_id === st.account.id).map((t: any) => <Row key={t.id} label={`− Paid out to ${t.to_name}`} sub={`${fmtDate(t.on_date)}${t.note ? ` · ${t.note}` : ""}`} value={inr(t.amount_paise)} />)}
        <Row strong label="Closing balance" sub={st.closing_paise < 0 ? "negative: a top-up or the opening float is missing from the books" : "carries into next month"} value={inr(st.closing_paise)} />
      </>}
    </Card>}
    {scopeOptions.length > 1 && <Chips value={scope} options={scopeOptions} onChange={setScope} />}
    <Card title={scope === "petty" ? "Petty-cash bills" : scope === "bank" ? "Bank-paid bills" : "All bills this month"} sub={scope === "petty" ? "capture first, classify later: vendor and bill number can be filled from the photo here" : "petty cash and bank together, as the P&L counts them"}>{!q.data ? <Loading error={q.error} /> : q.data.expenses.length === 0 ? <Empty>No {scope === "all" ? "" : scope === "bank" ? "bank-paid " : "petty-cash "}expenses in {monthName}.</Empty> : q.data.expenses.map((e: any) => { const ed = edit[e.id]; return <div className="row" key={e.id}><div style={{ flex: 1 }}><div>{catLabel(refs, e.category)} · {e.description ?? "—"} {e.voided_at && <Status s="void" />}{e.kind !== "normal" && <Status s={e.kind} />}</div><div className="sub">{fmtDate(e.on_date)} · {e.account_name}{e.kind === "normal" ? <> · {e.vendor_name ?? <span style={{ color: "var(--amb)" }}>vendor missing</span>} · {e.bill_no ?? <span style={{ color: "var(--amb)" }}>bill no. missing</span>}</> : e.vendor_name ? ` · ${e.vendor_name}` : ""}{e.vendor_gstin ? ` · GSTIN ✓` : ""}{e.bill_photo_key ? <> · <a href={`/api/files/${e.bill_photo_key}`} target="_blank">photo</a></> : ""}</div>
      {ed && <div className="grid two"><Field label="Vendor"><input value={ed.vendor_name ?? ""} onChange={(ev: any) => setEdit({ ...edit, [e.id]: { ...ed, vendor_name: ev.currentTarget.value } })} /></Field><Field label="Bill no."><input value={ed.bill_no ?? ""} onChange={(ev: any) => setEdit({ ...edit, [e.id]: { ...ed, bill_no: ev.currentTarget.value } })} /></Field><Field label="Vendor GSTIN"><input value={ed.vendor_gstin ?? ""} onChange={(ev: any) => setEdit({ ...edit, [e.id]: { ...ed, vendor_gstin: ev.currentTarget.value } })} /></Field><Field label="Category"><select value={ed.category} onChange={(ev: any) => setEdit({ ...edit, [e.id]: { ...ed, category: ev.currentTarget.value } })}>{refs.expense_families.map((fam) => <optgroup key={fam} label={fam}>{refs.expense_categories.filter((c) => c.family === fam && (c.petty || c.code === ed.category || e.account_kind === "bank")).map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</optgroup>)}</select></Field><div className="actions end"><Btn small onClick={() => { const n = { ...edit }; delete n[e.id]; setEdit(n); }}>Cancel</Btn><Btn small kind="primary" onClick={() => run(async () => { await patch(`/expenses/${e.id}`, ed); const n = { ...edit }; delete n[e.id]; setEdit(n); await q.reload(); }, "Updated · audited")}>Save</Btn></div></div>}
    </div><div className="actions"><b className="num">{inr(e.amount_paise)}</b>{!e.voided_at && e.kind === "normal" && !ed && (e.account_kind === "bank" ? canSeeBank : true) && <Btn small onClick={() => setEdit({ ...edit, [e.id]: { vendor_name: e.vendor_name, bill_no: e.bill_no, vendor_gstin: e.vendor_gstin, category: e.category } })}>Classify</Btn>}</div></div>; })}</Card>
    <div className="muted">{canSeeBank ? "New bank-paid bills and petty-cash top-ups are recorded on the Bank expenses screen." : "Bank-paid bills (electricity, subscriptions, professional fees) are recorded by the owner."} {me.property.gstin ? "GST on purchases is recorded for the register; it is not creditable while rooms are supplied at the 5% slab." : ""}</div>
    <span hidden>{refs.locations.length}</span>
  </>;
}

/** The + button: Expense 📷 · Collect ₹ · Task 🧹 · Check in/out 🔑. Three taps + one number; offline-first. */
export function QuickCapture({ refs }: { me: Me; refs: Ref }) {
  const [open, setOpen] = useState(false); const [verb, setVerb] = useState<null | "expense" | "collect" | "task" | "inout">(null);
  const [amt, setAmt] = useState(0); const [cat, setCat] = useState("fnb"); const [campaign, setCampaign] = useState(""); const [photo, setPhoto] = useState<string | null>(null); const [photoBusy, setPhotoBusy] = useState(false);
  const [loc, setLoc] = useState<string | null>(null); const [tkind, setTkind] = useState("housekeeping"); const [tline, setTline] = useState("");
  const [teq, setTeq] = useState<string | null>(null); const [tnotes, setTnotes] = useState("");
  const equipHere = (refs.equipment ?? []).filter((e) => e.location_id === loc);
  const [due, setDue] = useState<any[] | null>(null); const [guest, setGuest] = useState<any>(null); const [method, setMethod] = useState("upi");
  const [desk, setDesk] = useState<any>(null);
  const [queue, setQueue] = useState(readQueue());
  useEffect(() => onQueueChange(() => setQueue(readQueue())), []);
  const reset = () => { setVerb(null); setAmt(0); setPhoto(null); setLoc(null); setTline(""); setTeq(null); setTnotes(""); setGuest(null); };
  const close = () => { setOpen(false); reset(); };
  const pick = async (v: typeof verb) => { setVerb(v); if (v === "collect") setDue((await get("/payments/due")).due); if (v === "inout") setDesk(await get("/bookings/frontdesk/today")); };
  const saveExpense = () => run(async () => { const r = await submit("POST", "/expenses", { category: cat, amount_paise: amt, bill_photo_key: photo, on_date: todayIso(), campaign: cat === "marketing" && campaign.trim() ? campaign.trim() : undefined }, `Expense ${cat} ${inr(amt)}`); toast(r.queued ? "Saved offline · pending sync" : "✓ Saved · audited · petty cash updated"); close(); });
  const saveCollect = () => run(async () => { const r = await submit("POST", "/payments", { booking_id: guest?.booking_id ?? null, method, amount_paise: amt }, `Collect ${inr(amt)} ${guest?.guest_name ?? ""}`); toast(r.queued ? "Saved offline · pending sync" : "✓ Payment posted · fee booked once"); close(); });
  const saveTask = () => run(async () => { const r = await submit("POST", "/tasks", { kind: tkind, location_id: loc, equipment_id: teq, notes: tnotes.trim() || undefined, title: tline || [tkind, refs.locations.find((l) => l.id === loc)?.name, equipHere.find((e) => e.id === teq)?.name].filter(Boolean).join(" · "), photo_key: photo }, `Task ${tkind}`); toast(r.queued ? "Saved offline · pending sync" : tkind === "note" ? "✓ Noted" : "✓ Task created · Open"); close(); });
  const inout = (id: string, v: "check-in" | "check-out") => run(async () => { const r = await post(`/bookings/${id}/${v}`); toast(v === "check-in" ? "✓ Checked in · logged" : r.balance_due_paise > 0 ? `✓ Checked out · collect ${inr(r.balance_due_paise)}` : "✓ Checked out · housekeeping task created"); if (v === "check-out" && r.balance_due_paise > 0) { setVerb("collect"); setDue((await get("/payments/due")).due); setGuest({ booking_id: id, guest_name: "" }); setAmt(r.balance_due_paise); } else close(); });
  const rooms = refs.locations.filter((l) => l.kind === "room"), areas = refs.locations.filter((l) => l.kind === "area");
  return <>
    <button className="fab" onClick={() => setOpen(true)} title="New entry" aria-label="New entry" aria-haspopup="dialog">+</button>
    {open && <div className="sheet" onClick={close} onKeyDown={(e) => { if (e.key === "Escape") close(); }}><div role="dialog" aria-modal="true" aria-label="New entry" onClick={(e) => e.stopPropagation()}><div className="sheethead"><span /><button type="button" className="btn small" aria-label="Close" autoFocus onClick={close}><Icon name="close" size={16} /></button></div>
      {queue.length > 0 && <div className="queue">{queue.length} entr{queue.length === 1 ? "y" : "ies"} pending sync {navigator.onLine && <Btn small onClick={async () => { const n = await flush(); toast(`${n} synced`); }}>Sync now</Btn>}<details><summary>show</summary>{queue.map((qi) => <div className="row" key={qi.key}><div><div>{qi.label}</div><div className="sub">{qi.last_error ?? "waiting for network"}</div></div><Btn small kind="danger" onClick={() => dropQueued(qi.key)}>Drop</Btn></div>)}</details></div>}
      {!verb && <><h2>New entry</h2><div className="verbs"><button onClick={() => pick("expense")}><span>📷</span>Expense</button><button onClick={() => pick("collect")}><span>₹</span>Collect</button><button onClick={() => pick("task")}><span>🧹</span>Task</button><button onClick={() => pick("inout")}><span>🔑</span>Check in/out</button></div><p className="muted">Four verbs — the whole day. Bank-paid bills aren't here: the bank is the owner's.</p></>}
      {verb === "expense" && <><h2>Expense</h2><label className="btn" style={{ display: "block", textAlign: "center" }}>{photoBusy ? "Uploading…" : photo ? "✓ bill photo attached — vendor & bill no. later" : "📷 Snap the bill (or skip)"}<input type="file" accept="image/*" capture="environment" hidden onChange={async (e: any) => { const f = e.currentTarget.files?.[0]; if (!f) return; setPhotoBusy(true); try { setPhoto(await uploadFile(f, "bill")); } catch { toast("Photo upload needs network; save without it and attach later", "bad"); } finally { setPhotoBusy(false); } }} /></label>
        <Keypad value={amt} onChange={setAmt} /><CategoryPicker label="Category" value={cat} onChange={setCat} categories={refs.expense_categories.filter((c) => c.petty)} common={refs.common_categories.petty} families={refs.expense_families} /><div className="sub">Paid from · petty cash</div>
        {cat === "marketing" && <Field label="Campaign (optional)" hint="same name as on the ads, so the scorecard can match spend to leads"><input value={campaign} onChange={(e: any) => setCampaign(e.currentTarget.value)} /></Field>}
        <div className="actions end"><Btn onClick={reset}>← Back</Btn><Btn kind="gold" disabled={amt <= 0} onClick={saveExpense}>Save</Btn></div></>}
      {verb === "collect" && <><h2>Collect payment</h2>{!guest && <div>{(due ?? []).length === 0 ? <Empty>Nobody owes money today.</Empty> : (due ?? []).map((d: any) => <div className="row" key={d.booking_id}><div><div>{d.guest_name}</div><div className="sub">{d.due_today ? "due now" : `advance for ${fmtDate(d.check_in)}`} · balance of {inr(d.gross_paise)} stay</div></div><Btn small kind="primary" onClick={() => { setGuest(d); setAmt(d.balance_paise); }}>{inr(d.balance_paise)}</Btn></div>)}<div className="actions end"><Btn onClick={reset}>← Back</Btn><Btn onClick={() => setGuest({ booking_id: null, guest_name: "walk-in" })}>Walk-in / other</Btn></div></div>}
        {guest && <><div className="sub">{guest.guest_name || "stay"} · tap the figure to change</div><Keypad value={amt} onChange={setAmt} /><Chips value={method} options={METHODS.map(([v, l]) => ({ value: v, label: l }))} onChange={setMethod} /><div className="actions end"><Btn onClick={() => setGuest(null)}>← Back</Btn><Btn kind="gold" disabled={amt <= 0} onClick={saveCollect}>Collected {inr(amt)}</Btn></div></>}</>}
      {verb === "task" && <><h2>Task</h2><label className="btn" style={{ display: "block", textAlign: "center" }}>{photo ? "✓ photo" : "📷 Photo (optional)"}<input type="file" accept="image/*" capture="environment" hidden onChange={async (e: any) => { const f = e.currentTarget.files?.[0]; if (f) setPhoto(await uploadFile(f, "task")); }} /></label>
        <div className="sub">Where — rooms</div><Chips value={loc} options={rooms.map((r) => ({ value: r.id, label: `${r.name} · ${r.code}` }))} onChange={(v) => { setLoc(v); setTeq(null); }} /><div className="sub">Common areas</div><Chips value={loc} options={areas.map((r) => ({ value: r.id, label: r.name }))} onChange={(v) => { setLoc(v); setTeq(null); }} />
        {equipHere.length > 0 && <><div className="sub">Which equipment (optional)</div><Chips label="Equipment" value={teq} options={equipHere.map((e) => ({ value: e.id, label: e.name }))} onChange={(v) => setTeq(teq === v ? null : v)} /></>}
        <div className="sub">What</div><Chips value={tkind} options={[{ value: "housekeeping", label: "Housekeeping" }, { value: "maintenance", label: "Maintenance" }, { value: "repair", label: "Repair" }, { value: "note", label: "Note" }]} onChange={setTkind} />
        <Field label="What needs doing (one line, optional)"><input value={tline} onChange={(e: any) => setTline(e.currentTarget.value)} placeholder="e.g. fridge not cooling" /></Field>
        <Field label="Notes (optional)" hint="what you saw, who was called, parts needed; more notes can be added later on the Tasks screen"><textarea rows={3} value={tnotes} onChange={(e: any) => setTnotes(e.currentTarget.value)} /></Field>
        <div className="actions end"><Btn onClick={reset}>← Back</Btn><Btn kind="gold" disabled={!loc} onClick={saveTask}>Save {tkind === "note" ? "note" : "task"}</Btn></div></>}
      {verb === "inout" && <><h2>Check in / out</h2>{!desk ? <Loading /> : <>{desk.arrivals.map((b: any) => <div className="row" key={b.id}><div><div>{b.guest_name}</div><div className="sub">arriving · {b.room_names} · {b.paid_paise >= b.gross_paise ? "paid ✓" : b.collection_type === "channel_collect" ? "OTA" : `balance ${inr(b.gross_paise - b.paid_paise)}`}</div></div><Btn small kind="primary" onClick={() => inout(b.id, "check-in")}>Check in</Btn></div>)}
        {[...desk.departures, ...desk.in_house].map((b: any) => <div className="row" key={b.id}><div><div>{b.guest_name}</div><div className="sub">leaving · {b.collection_type === "channel_collect" ? "OTA collect — nothing to take" : `balance ${inr(b.gross_paise - b.paid_paise)}`}</div></div><Btn small kind="primary" onClick={() => inout(b.id, "check-out")}>Check out</Btn></div>)}
        {desk.arrivals.length + desk.departures.length + desk.in_house.length === 0 && <Empty>No movements today.</Empty>}</>}<div className="actions end"><Btn onClick={reset}>← Back</Btn></div></>}
    </div></div>}
  </>;
}
