import { useState } from "react";
import { get, post, patch, del } from "../api";
import { Card, Row, Btn, Chips, Field, Status, Empty, Loading, inr, fmtDate, ago, useLoad, run, toast, todayIso, askText, askConfirm, ScrollX, Drawer, fmtRange, fmtDateTime, actionLabel, BankPick, defaultBankId } from "../ui";
import type { Me, Ref } from "../app";

const SOURCES = [["instagram", "Instagram"], ["facebook", "Facebook"], ["website", "Website"], ["whatsapp", "WhatsApp"], ["phone", "Phone"], ["walkin", "Walk-in"], ["other", "Other"]] as const;
const LOST = [["dates", "Dates"], ["price", "Price"], ["no_reply", "No reply"], ["expired", "Expired"], ["other", "Other"]] as const;

export function Leads({ me, refs }: { me: Me; refs: Ref }) {
  const [filter, setFilter] = useState<string | null>(null);
  const q = useLoad(() => get(`/leads${filter ? `?status=${filter}` : ""}`), [filter]);
  const funnel = useLoad(() => get("/leads/funnel"), []);
  const [newLead, setNewLead] = useState<any>({ source: "whatsapp", name: "", phone: "", check_in: "", check_out: "", rooms_wanted: 1, adults: 2 });
  const [showNew, setShowNew] = useState(false);
  const rooms = refs.locations.filter((l) => l.kind === "room");
  const [quoteRooms, setQuoteRooms] = useState<Record<string, string[]>>({});
  const create = () => run(async () => { await post("/leads", newLead); setShowNew(false); setNewLead({ ...newLead, name: "", phone: "" }); await q.reload(); }, "Lead captured");
  const act = (id: string, verb: string, body?: unknown, msg?: string) => run(async () => { const r = await post(`/leads/${id}/${verb}`, body); await q.reload(); return r; }, msg);
  return <>
    <h1>Leads <small>every enquiry from first contact to booking; a lost lead needs a reason</small></h1>
    <div className="actions" style={{ marginBottom: "10px" }}><Chips value={filter} options={[{ value: "", label: "Open" }, { value: "new", label: "New" }, { value: "quoted", label: "Quoted" }, { value: "hold", label: "Hold" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }]} onChange={(v) => setFilter(v || null)} /><span className="spacer" /><Btn kind="primary" onClick={() => setShowNew(!showNew)}>+ Lead</Btn></div>
    {showNew && <Card title="New lead · 3 taps + a name"><Chips value={newLead.source} options={SOURCES.map(([v, l]) => ({ value: v, label: l }))} onChange={(v) => setNewLead({ ...newLead, source: v })} />
      <div className="grid two"><Field label="Name"><input value={newLead.name} onChange={(e: any) => setNewLead({ ...newLead, name: e.currentTarget.value })} /></Field><Field label="Phone"><input inputMode="tel" value={newLead.phone} onChange={(e: any) => setNewLead({ ...newLead, phone: e.currentTarget.value })} /></Field>
      <Field label="Check-in"><input type="date" value={newLead.check_in} onChange={(e: any) => setNewLead({ ...newLead, check_in: e.currentTarget.value })} /></Field><Field label="Check-out"><input type="date" value={newLead.check_out} onChange={(e: any) => setNewLead({ ...newLead, check_out: e.currentTarget.value })} /></Field>
      <Field label="Rooms"><input type="number" min="1" value={newLead.rooms_wanted} onChange={(e: any) => setNewLead({ ...newLead, rooms_wanted: Number(e.currentTarget.value) })} /></Field><Field label="Adults"><input type="number" min="1" value={newLead.adults} onChange={(e: any) => setNewLead({ ...newLead, adults: Number(e.currentTarget.value) })} /></Field>
      <Field label="Campaign (optional)" hint="the ad or promotion the guest mentioned; same name as on the marketing bill"><input value={newLead.campaign ?? ""} onChange={(e: any) => setNewLead({ ...newLead, campaign: e.currentTarget.value })} /></Field></div>
      <div className="actions end"><Btn onClick={() => setShowNew(false)}>Cancel</Btn><Btn kind="primary" onClick={create}>Save lead</Btn></div></Card>}
    {!q.data ? <Loading error={q.error} /> : q.data.leads.length === 0 ? <Empty>No leads{filter ? ` in ${filter}` : " open"}.</Empty> : q.data.leads.map((l: any) => {
      const quote = l.quote_json ? JSON.parse(l.quote_json) : null;
      const overdue = l.status === "new" && Date.now() - new Date(l.created_at.replace(" ", "T") + "Z").getTime() > 15 * 60000;
      const sel = quoteRooms[l.id] ?? [];
      return <Card key={l.id} tone={overdue ? "bad" : undefined} title={<>{l.source} · {l.guest_name} <Status s={l.status} />{l.campaign && <span className="roomchips"> <i>{l.campaign}</i></span>}</>} sub={<>age {ago(l.created_at)} · {l.assigned_name ?? "unassigned"}{overdue ? " · overdue" : ""} · {l.past_stays ? `${l.past_stays} past stay(s)` : "new guest (no stays yet)"}</>}>
        <div className="muted">{l.check_in ? `${fmtDate(l.check_in)} → ${fmtDate(l.check_out)}` : "dates not set"} · {l.rooms_wanted} room(s) · {l.adults} adults{l.guest_phone ? ` · +${l.guest_phone}` : ""}</div>
        {quote && <div style={{ marginTop: "8px" }}>{quote.lines.map((x: any) => <Row key={x.room_id} label={`${x.room_name} × ${x.nights} night(s) @ ${inr(x.nightly_rate_paise)}`} value={inr(x.room_total_paise)} />)}{quote.gst_paise > 0 && <Row label="GST" value={inr(quote.gst_paise)} />}<Row strong label={<>Total{quote.on_tariff ? " · on tariff" : " · OFF tariff"}{l.quote_expires_at ? ` · valid till ${new Date(l.quote_expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</>} value={inr(quote.total_paise)} />{quote.availability_conflicts?.length > 0 && <div className="muted" style={{ color: "var(--bad)" }}>⚠ {quote.availability_conflicts.length} room-night(s) already taken</div>}</div>}
        {l.status === "hold" && <div className="muted">Hold expires {new Date(l.hold_expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · rooms blocked in inventory</div>}
        {l.status === "lost" && <div className="muted">Lost · reason: {l.lost_reason}</div>}
        {["new", "contacted", "quoted"].includes(l.status) && l.check_in && <div style={{ marginTop: "8px" }}><div className="sub">Quote rooms</div><div className="chips">{rooms.map((r) => <button type="button" key={r.id} className={`chip ${sel.includes(r.id) ? "on" : ""}`} onClick={() => setQuoteRooms({ ...quoteRooms, [l.id]: sel.includes(r.id) ? sel.filter((x) => x !== r.id) : [...sel, r.id] })}>{r.name}</button>)}</div></div>}
        <div className="actions end">
          {l.status === "new" && <Btn onClick={() => act(l.id, "contacted", undefined, "Marked contacted")}>Mark contacted</Btn>}
          {["new", "contacted", "quoted"].includes(l.status) && <Btn kind="primary" disabled={!l.check_in || sel.length === 0} onClick={async () => { const r: any = await act(l.id, "quote", { room_ids: sel }, "Quote composed"); if (r?.whatsapp_url) window.open(r.whatsapp_url, "_blank"); }}>Quote → WhatsApp</Btn>}
          {l.status === "quoted" && <Btn onClick={() => act(l.id, "hold", undefined, "Rooms held 48 h")}>Hold 48 h</Btn>}
          {["quoted", "hold"].includes(l.status) && <Btn kind="gold" onClick={() => act(l.id, "won", {}, "Won → booking created")}>Won → booking</Btn>}
          {!["won", "lost"].includes(l.status) && <details><summary>Lost…</summary><div className="chips">{LOST.map(([v, lab]) => <button type="button" className="chip bad" key={v} onClick={() => act(l.id, "lost", { reason: v }, "Marked lost")}>{lab}</button>)}</div></details>}
        </div>
      </Card>;
    })}
    <Card title="Funnel · measured from the books" sub="conversion and revenue per source, not call counts">{!funnel.data ? <Loading /> : funnel.data.funnel.length === 0 ? <Empty>No leads yet.</Empty> : <ScrollX><table className="t"><thead><tr><th>Source</th><th className="num">Leads</th><th className="num">Open</th><th className="num">Won</th><th className="num">Lost</th><th className="num">Revenue</th></tr></thead><tbody>{funnel.data.funnel.map((f: any) => <tr key={f.source}><td>{f.source}</td><td className="num">{f.leads}</td><td className="num">{f.open}</td><td className="num">{f.won}</td><td className="num">{f.lost}</td><td className="num">{inr(f.revenue_paise)}</td></tr>)}</tbody></table></ScrollX>}</Card>
  </>;
}

export function Inbox({ refs }: { me: Me; refs: Ref }) {
  const [status, setStatus] = useState("pending");
  const q = useLoad(() => get(`/inbox?status=${status}`), [status]);
  const [pick, setPick] = useState<Record<string, string[]>>({});
  const [rate, setRate] = useState<Record<string, string>>({});
  const [paste, setPaste] = useState({ from: "", subject: "", text: "" });
  // Rooms automation would have chosen are preselected; a person only taps when the choice is not obvious.
  const chosen = (it: any): string[] => pick[it.id] ?? it.suggested_room_ids ?? [];
  const book = (it: any) => run(async () => {
    const rooms = chosen(it);
    const r = await post(`/inbox/${it.id}/approve`, { room_ids: rooms, ...(rate[it.id] ? { nightly_rate_paise: Math.round(Number(rate[it.id]) * 100) } : {}) });
    await q.reload();
    toast(it.kind === "cancellation" ? "Booking cancelled · rooms released" : r.booking?.status === "approved" ? "Booked · it is in Reservations" : `Booked · awaiting approval (${(r.booking?.approval?.reasons ?? []).join(", ")})`);
  });
  return <>
    <h1>Inbox — bookings <small>STAAH, SwiftBook and Airpay emails book, cancel and record themselves when the facts line up; the rest wait here for one tap</small></h1>
    <Chips value={status} options={[{ value: "pending", label: "Needs a person" }, { value: "approved", label: "Done · auto and approved" }, { value: "duplicate", label: "Already in the books" }, { value: "dismissed", label: "Dismissed" }]} onChange={setStatus} />
    {!q.data ? <Loading error={q.error} /> : q.data.items.length === 0 ? <Empty>Nothing to review.</Empty> : q.data.items.map((it: any) => {
      const d = it.parsed ?? {}; const sel = chosen(it); const opts: any[] = it.room_options ?? [];
      const selNames = opts.filter((o) => sel.includes(o.id)).map((o) => o.name).join(" + ");
      const nights = d.check_in && d.check_out ? Math.max(1, Math.round((Date.parse(d.check_out) - Date.parse(d.check_in)) / 86_400_000)) : null;
      const ratePaise = rate[it.id] ? Math.round(Number(rate[it.id]) * 100) : it.nightly_rate_paise;
      return <Card key={it.id} title={<>{d.guest_name ?? it.subject} <span className="muted">· {d.channel ?? it.source}</span> <Status s={it.auto_applied ? "auto" : it.status} />{d.confidence === "low" && <Status s="check parse" />}</>}
        sub={<>{d.check_in ? `${fmtDate(d.check_in)} → ${fmtDate(d.check_out)}${nights ? ` · ${nights} night${nights > 1 ? "s" : ""}` : ""}` : it.subject}{Array.isArray(d.room_types) && d.room_types.length > 1 ? ` · ${d.room_types.map((t: any) => `${t.count} × ${t.name}`).join(" + ")}` : d.room_name ? ` · ${d.rooms ?? 1} × ${d.room_name}` : ""}{d.adults ? ` · ${d.adults} adult${d.adults > 1 ? "s" : ""}${d.children ? `, ${d.children} child${d.children > 1 ? "ren" : ""}` : ""}` : ""}{it.external_ref ? <> · ref <span className="mono">{it.external_ref}</span></> : ""}</>}
        tone={it.status === "pending" && it.auto_note ? "amb" : undefined}>
        {it.status === "pending" && it.auto_note && <div className="sub" style={{ marginBottom: "8px" }}><b>Waiting because:</b> {it.auto_note}</div>}
        {it.auto_applied === 1 && <div className="sub" style={{ marginBottom: "8px" }}>Applied automatically on arrival</div>}
        <div className="grid two">
          <div>
            {d.room_total_paise != null && <Row label={`Room total${d.room_total_is_ex_gst ? " (ex-GST)" : ""}`} value={inr(d.room_total_paise)} />}
            {d.total_incl_gst_paise != null && <Row label="Total incl. GST" value={inr(d.total_incl_gst_paise)} />}
            {d.commission_paise != null && <Row label="OTA commission" value={inr(d.commission_paise)} />}{d.commission_bp != null && <Row label="Commission" value={`${d.commission_bp / 100}%`} />}
            {d.collection_type && <Row label="Collection" value={d.collection_type.replace("_", " ")} />}
            {d.order_id && <Row label="Order" value={<span className="mono">{d.order_id}</span>} />}{d.amount_paise != null && <Row label={d.direction ? `${d.direction === "debited" ? "Debit" : "Credit"} · ${d.bank ?? "bank"} ···${d.account_last ?? ""}` : "Amount"} value={inr(d.amount_paise)} />}
            {d.counterparty && <Row label={d.direction === "debited" ? "Paid to" : "Received from"} sub={[d.method, d.reference].filter(Boolean).join(" ")} value={d.counterparty} />}{d.balance_paise != null && <Row label="Bank balance after" value={inr(d.balance_paise)} />}
            {it.status !== "pending" && <div className="sub">From {it.from_addr} · {it.subject}</div>}
          </div>
          {it.status === "pending" && it.kind === "new_reservation" && opts.length > 0 && <div>
            <div className="sub">Room for this stay · tap to change</div>
            <div className="chips">{opts.map((o) => <button type="button" key={o.id} className={`chip ${sel.includes(o.id) ? "on" : ""} ${o.free ? "" : "bad"}`} disabled={!o.free} title={o.free ? "free for these dates" : `taken by ${o.taken_by}`} onClick={() => setPick({ ...pick, [it.id]: sel.includes(o.id) ? sel.filter((x) => x !== o.id) : [...sel, o.id] })}>{o.name}{o.free ? "" : ` · ${o.taken_by}`}</button>)}</div>
            {opts.every((o) => !o.free) && <div className="sub" style={{ color: "var(--bad)" }}>Every room is taken for these dates. Free one up (cancel or move the booking holding it in Reservations), then come back and book.</div>}
            <Field label="Nightly rate ex-GST (₹)" hint={it.nightly_rate_paise ? `from the email: ${inr(it.nightly_rate_paise)}` : "the email carried no amount"}><input inputMode="decimal" value={rate[it.id] ?? (it.nightly_rate_paise ? String(it.nightly_rate_paise / 100) : "")} onChange={(e: any) => setRate({ ...rate, [it.id]: e.currentTarget.value })} /></Field>
          </div>}
        </div>
        {it.status === "pending" && <div className="actions end">
          <Btn kind="danger" onClick={() => run(async () => { await post(`/inbox/${it.id}/dismiss`, { reason: "manual" }); await q.reload(); }, "Dismissed")}>Dismiss</Btn>
          <Btn onClick={() => run(async () => { const r = await post(`/inbox/${it.id}/reparse`); await q.reload(); toast(r.auto?.applied ? `Applied automatically: ${r.auto.what}` : r.auto?.note ? `Read again · still waiting: ${r.auto.note}` : `Read again · ${r.status}`); })}>Re-read</Btn>
          {it.kind === "new_reservation" && <Btn kind="primary" disabled={sel.length === 0 || !ratePaise} onClick={() => book(it)}>{sel.length ? `Book ${selNames}${ratePaise ? ` @ ${inr(ratePaise)}/night` : ""}` : "Pick a room to book"}</Btn>}
          {it.kind === "cancellation" && <Btn kind="primary" onClick={() => book(it)}>Cancel the booking</Btn>}
          {it.kind === "modification" && it.booking_match && <Btn kind="primary" onClick={() => { try { sessionStorage.setItem("avos.openBooking", it.booking_match.id); } catch {} location.hash = "#resv"; }}>Amend {it.booking_match.guest_name}'s booking</Btn>}
          {it.kind !== "cancellation" && it.kind !== "payment" && !(it.kind === "modification" && it.booking_match) && <Btn kind={it.kind === "new_reservation" ? undefined : "primary"} onClick={() => { try { sessionStorage.setItem("avos.bookFromInbox", JSON.stringify({ inbox_item_id: it.id, subject: it.subject, guest_name: d.guest_name ?? "", guest_phone: d.guest_phone ?? "", guest_email: d.guest_email ?? "", check_in: d.check_in ?? "", check_out: d.check_out ?? "", adults: d.adults ?? 2, children: d.children ?? 0, channel_code: it.source === "bookingengine" || it.source === "swiftbook" ? (it.source === "swiftbook" ? "swiftbook" : "direct") : (d.channel ? String(d.channel).toLowerCase().replace(/[^a-z]+/g, "_") : "direct"), external_ref: it.external_ref ?? "", notes: `from email: ${it.subject}` })); } catch {} location.hash = "#resv"; }}>Book by hand in Reservations</Btn>}
        </div>}
        {it.booking_id && <div className="muted">Booking {it.booking_id}{it.booking_status ? ` · ${it.booking_status.replace("_", " ")}` : ""} · see Reservations</div>}
      </Card>;
    })}
    <Card title="Paste an email" sub="forwarded mail arrives on its own once Email Routing is on; paste one here to test, or when a notification went astray — same parser, same automation, same audit">
      <div className="grid two"><Field label="From"><input value={paste.from} onChange={(e: any) => setPaste({ ...paste, from: e.currentTarget.value })} placeholder="noreply@staah.com" /></Field><Field label="Subject"><input value={paste.subject} onChange={(e: any) => setPaste({ ...paste, subject: e.currentTarget.value })} /></Field></div>
      <Field label="Body (text)"><textarea rows={6} value={paste.text} onChange={(e: any) => setPaste({ ...paste, text: e.currentTarget.value })} /></Field>
      <div className="actions end"><Btn kind="primary" onClick={() => run(async () => { await post("/inbox/ingest", paste); setPaste({ from: "", subject: "", text: "" }); setStatus("pending"); await q.reload(); }, "Ingested")}>Ingest</Btn></div></Card>
    <span hidden>{refs.locations.length}</span>
  </>;
}

/* ---------- Reservations: the desk's most-used screen. Pick dates, see every room's state for those dates,
   tap the rooms, the money adds itself up, save. The list below is filterable and opens into a detail
   with the same room picker for amendments. ---------- */

const nightsOf = (ci: string, co: string) => ci && co && ci < co ? Math.round((Date.parse(co) - Date.parse(ci)) / 86_400_000) : 0;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
// GST follows the price charged per night (the rate card only decides below/above tariff).
const slabFor = (me: Me, _tariff: number | null, rate: number) => { const d = rate; return !me.property.gstin || d <= me.property.gst_nil_upto_paise ? 0 : d <= me.property.gst_threshold_paise ? me.property.gst_rate_below_bp : me.property.gst_rate_above_bp; };
const CHANNEL_SHORT: Record<string, string> = { direct: "Direct", booking_com: "Booking.com", makemytrip: "MMT", goibibo: "Goibibo", agoda: "Agoda", cleartrip: "Cleartrip", expedia: "Expedia", yatra: "Yatra", swiftbook: "SwiftBook", referral: "Referral", agent: "Agent" };

/** Who holds each room for a stay, from the availability endpoint. */
function useHolders(checkIn: string, checkOut: string, ignoreBookingId?: string | null) {
  const n = nightsOf(checkIn, checkOut);
  const q = useLoad(() => n > 0 ? get(`/bookings/availability?from=${checkIn}&to=${addDays(checkOut, -1)}`) : Promise.resolve(null), [checkIn, checkOut]);
  const holders: Record<string, { name: string; kind: string }> = {};
  for (const t of q.data?.taken ?? []) { if (ignoreBookingId && t.booking_id === ignoreBookingId) continue; if (!holders[t.room_id]) holders[t.room_id] = { name: t.guest_name ?? (t.kind === "hold" ? "a quote on hold" : "another booking"), kind: t.kind }; }
  return { holders, loading: n > 0 && !q.data && !q.error, nights: n };
}

/**
 * Room picker: one tile per room showing its state for the chosen dates. Tap a free room to add it at tariff,
 * change the rate in place, tap again to remove. Taken rooms say who has them and cannot be picked.
 */
function RoomPicker({ me, rooms, checkIn, checkOut, sel, onChange, tariffFor, holders, loading }: { me: Me; rooms: Ref["locations"]; checkIn: string; checkOut: string; sel: Record<string, string>; onChange: (s: Record<string, string>) => void; tariffFor: (roomId: string, night: string) => number | null; holders: Record<string, { name: string; kind: string }>; loading: boolean }) {
  const n = nightsOf(checkIn, checkOut);
  if (n === 0) return <div className="roomgrid">{rooms.map((r) => <div key={r.id} className="roomtile idle"><b>{r.name}</b><span className="sub">{r.code} · pick dates to see availability</span></div>)}</div>;
  return <div className="roomgrid">{rooms.map((r) => {
    const t = tariffFor(r.id, checkIn); const held = holders[r.id]; const on = (sel[r.id] ?? "") !== "";
    const rate = on ? Math.round(Number(sel[r.id]) * 100) : 0; const slab = on ? slabFor(me, t, rate) : 0;
    const cls = `roomtile ${on ? "on" : held ? "taken" : "free"}`;
    const toggle = () => { if (held && !on) return; const next = { ...sel }; if (on) delete next[r.id]; else next[r.id] = t ? String(t / 100) : ""; onChange(next); };
    return <div key={r.id} className={cls}>
      <button type="button" className="tilehead" onClick={toggle} disabled={!!held && !on} aria-pressed={on}>
        <span><b>{r.name}</b><span className="sub">{r.code}{t ? ` · tariff ${inr(t)}/night` : " · no tariff set"}</span></span>
        <span className="state">{loading ? "…" : on ? "✓ in this booking" : held ? `${held.kind === "hold" ? "held" : "taken"} · ${held.name}` : "free"}</span>
      </button>
      {on && <div className="tilebody">
        <label className="field"><span>Rate per night, ex-GST (₹)</span><input inputMode="decimal" value={sel[r.id]} onChange={(e: any) => onChange({ ...sel, [r.id]: e.currentTarget.value })} /></label>
        <div className="sub">{n} night{n > 1 ? "s" : ""} × {inr(rate)} = <b>{inr(rate * n)}</b>{me.property.gstin ? ` · GST ${slab / 100}%` : ""}{t && rate < t ? " · below tariff" : t && rate > t ? " · above tariff" : ""}</div>
        <div className="actions">{t && rate !== t && <Btn small onClick={() => onChange({ ...sel, [r.id]: String(t / 100) })}>Use tariff</Btn>}<Btn small onClick={toggle}>Remove</Btn></div>
      </div>}
    </div>;
  })}</div>;
}

/** The money a stay adds up to, computed the way the server will. */
function stayTotals(me: Me, sel: Record<string, string>, checkIn: string, checkOut: string, tariffFor: (roomId: string, night: string) => number | null) {
  const n = nightsOf(checkIn, checkOut); let room = 0, gst = 0, below = false, noTariff = false;
  for (const [id, v] of Object.entries(sel)) { if (v === "") continue; const rate = Math.round(Number(v) * 100); const t = tariffFor(id, checkIn); if (t === null) noTariff = true; else if (rate < t) below = true; const sub = rate * n; room += sub; gst += Math.round(sub * slabFor(me, t, rate) / 10000); }
  return { nights: n, rooms: Object.values(sel).filter((v) => v !== "").length, room, gst, gross: room + gst, below, noTariff };
}

function SummaryBar({ t, me, isOta, label }: { t: ReturnType<typeof stayTotals>; me: Me; isOta: boolean; label?: string }) {
  if (!t.rooms) return null;
  const approval = isOta ? "OTA stay · approves itself" : t.below ? "below tariff · goes to the revenue desk" : t.noTariff ? "no tariff for these dates · goes to the revenue desk" : me.property.auto_approve_on_tariff ? "on tariff · approves itself" : "waits for approval";
  return <div className="sumbar"><div><small>{label ?? "This stay"}</small><b>{t.rooms} room{t.rooms > 1 ? "s" : ""} · {t.nights} night{t.nights > 1 ? "s" : ""}</b></div><div><small>Room total ex-GST</small><b>{inr(t.room)}</b></div><div><small>GST</small><b>{inr(t.gst)}</b></div><div className="gross"><small>Gross</small><b>{inr(t.gross)}</b></div><div className="appr"><Status s={isOta || (!t.below && !t.noTariff && me.property.auto_approve_on_tariff) ? "auto" : "pending"} /> <span className="sub">{approval}</span></div></div>;
}

/**
 * Channel: one chip per channel; when a channel can be paid either way (Booking.com, Cleartrip, Expedia…) a second
 * question asks who takes the guest's money, so "pay at property" is a decision, not a look-alike chip.
 */
function ChannelPick({ channels, value, onChange }: { channels: Ref["channels"]; value: string; onChange: (code: string) => void }) {
  const TWIN = "_hotel_collect";
  const base = channels.filter((c) => !c.code.endsWith(TWIN));
  const cur = value.endsWith(TWIN) ? value.slice(0, -TWIN.length) : value;
  const twin = channels.find((c) => c.code === cur + TWIN);
  const name = CHANNEL_SHORT[cur] ?? base.find((c) => c.code === cur)?.name ?? cur;
  return <div className="chanpick">
    <Chips label="Channel" value={cur} options={base.map((c) => ({ value: c.code, label: CHANNEL_SHORT[c.code] ?? c.name }))} onChange={onChange} />
    {twin && <div className="paidby"><span className="sub">Who takes the guest's money?</span>
      <Chips label="Who takes the guest's money" value={value} options={[{ value: cur, label: `${name}, paid online` }, { value: twin.code, label: "Guest pays us at the property" }]} onChange={onChange} /></div>}
  </div>;
}

export function Reservations({ me, refs }: { me: Me; refs: Ref }) {
  const q = useLoad(() => get("/bookings"), []);
  const rooms = refs.locations.filter((l) => l.kind === "room");
  const today = me.property.today;
  const prefill = (() => { try { const s = sessionStorage.getItem("avos.bookFromInbox"); return s ? JSON.parse(s) : null; } catch { return null; } })();
  const [fromInbox, setFromInbox] = useState<any>(prefill);
  const blank = { guest_name: "", guest_phone: "", guest_email: "", notes: "", external_ref: "", rooms: {} as Record<string, string> };
  const [f, setF] = useState<any>({ guest_name: prefill?.guest_name ?? "", guest_phone: prefill?.guest_phone ?? "", guest_email: prefill?.guest_email ?? "", notes: prefill?.notes ?? "", check_in: prefill?.check_in || today, check_out: prefill?.check_out || addDays(prefill?.check_in || today, 1), adults: prefill?.adults ?? 2, children: prefill?.children ?? 0, channel_code: prefill?.channel_code ?? "direct", external_ref: prefill?.external_ref ?? "", rooms: {} as Record<string, string> });
  // The new-booking panel keeps its draft when closed; an inbox hand-off opens it straight away.
  const [newOpen, setNewOpen] = useState<boolean>(!!prefill);
  // Opened from an inbox card (a modification): show that booking straight away.
  const [open, setOpen] = useState<string | null>(() => { try { const id = sessionStorage.getItem("avos.openBooking"); if (id) sessionStorage.removeItem("avos.openBooking"); return id; } catch { return null; } });
  const [filter, setFilter] = useState<"upcoming" | "inhouse" | "past" | "cancelled" | "all">(() => (open ? "all" : "upcoming"));
  const [search, setSearch] = useState("");
  const detail = useLoad(() => open ? get(`/bookings/${open}`) : Promise.resolve(null), [open]);
  const tariffFor = (roomId: string, night: string) => { let best: any = null; for (const c of refs.rate_cards) { if (c.room_id !== roomId) continue; if (c.from_date && night < c.from_date) continue; if (c.to_date && night > c.to_date) continue; if (!best || c.priority > best.priority) best = c; } return best?.rate_paise ?? null; };
  const av = useHolders(f.check_in, f.check_out);
  const totals = stayTotals(me, f.rooms, f.check_in, f.check_out, tariffFor);
  const channel = refs.channels.find((c) => c.code === f.channel_code);
  const isOta = !!channel && channel.collection_type !== "direct";
  const missing = totals.nights <= 0 ? "Check-out must be after check-in" : totals.rooms === 0 ? "Pick at least one room" : f.guest_name.trim().length < 2 ? "Add the guest's name" : null;
  const canSave = !missing && Object.values(f.rooms as Record<string, string>).every((v) => v === "" || Number(v) >= 0);
  // The same guest (by phone) already booked for overlapping dates: almost always one stay that needs a second room,
  // which belongs on the existing booking (one bill, one payment), not a new one.
  const last10 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
  const sameGuest = last10(f.guest_phone).length === 10 ? (q.data?.bookings ?? []).filter((b: any) => last10(b.guest_phone) === last10(f.guest_phone) && ["provisional", "approved", "checked_in"].includes(b.status) && b.check_in < f.check_out && b.check_out > f.check_in) : [];
  const save = async () => {
    if (sameGuest.length && !(await askConfirm(`${sameGuest[0].guest_name} already has a booking for these dates`, `${String(sameGuest[0].room_names ?? "")}, ${fmtRange(sameGuest[0].check_in, sameGuest[0].check_out)}. If this is the same stay, cancel here, open that booking and use Amend to add the room, so the guest gets one bill and pays once.`, { ok: "Save as a separate booking" }))) return;
    await saveBooking();
  };
  const saveBooking = () => run(async () => {
    const rs = Object.entries(f.rooms as Record<string, string>).filter(([, v]) => v !== "").map(([room_id, v]) => ({ room_id, nightly_rate_paise: Math.round(Number(v) * 100) }));
    const r = await post("/bookings", { ...f, rooms: rs, inbox_item_id: fromInbox?.inbox_item_id ?? undefined });
    if (fromInbox) { try { sessionStorage.removeItem("avos.bookFromInbox"); } catch {} setFromInbox(null); }
    toast(r.booking.status === "approved" ? `Booked · ${inr(r.booking.grossPaise)} gross · approved` : `Booked · awaiting approval (${r.booking.approval.reasons.join(", ")})`);
    setF({ ...f, ...blank }); setNewOpen(false); await q.reload(); setOpen(r.booking.id);
  });
  const all: any[] = q.data?.bookings ?? [];
  const isUpcoming = (b: any) => ["provisional", "approved"].includes(b.status) && b.check_out >= today;
  const list = all.filter((b: any) => {
    if (search && !`${b.guest_name} ${b.guest_phone ?? ""} ${b.external_ref ?? ""}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "all") return true;
    if (filter === "cancelled") return ["cancelled", "no_show"].includes(b.status);
    if (filter === "inhouse") return b.status === "checked_in";
    if (filter === "past") return b.status === "checked_out";
    return isUpcoming(b);
  }).sort((a: any, b: any) => filter === "past" || filter === "cancelled" ? (a.check_in < b.check_in ? 1 : -1) : (a.check_in > b.check_in ? 1 : -1));
  const counts = { upcoming: all.filter(isUpcoming).length, inhouse: all.filter((b: any) => b.status === "checked_in").length };
  const closeNew = () => { setNewOpen(false); if (fromInbox) { try { sessionStorage.removeItem("avos.bookFromInbox"); } catch {} setFromInbox(null); } };
  return <>
    <div className="pagehead">
      <h1>Reservations <small>every stay from booking to check-out · open one to see what is owed or to change it</small></h1>
      <Btn kind="primary" onClick={() => setNewOpen(true)}>+ New booking</Btn>
    </div>

    <Card title={me.actor.role === "sales" ? "My bookings" : "Bookings"} actions={<input className="search" type="search" aria-label="Search bookings" placeholder="Search guest, phone, reference" value={search} onChange={(e: any) => setSearch(e.currentTarget.value)} />}>
      <Chips label="Show" value={filter} options={[{ value: "upcoming", label: `Upcoming · ${counts.upcoming}` }, { value: "inhouse", label: `In house · ${counts.inhouse}` }, { value: "past", label: "Past" }, { value: "cancelled", label: "Cancelled" }, { value: "all", label: "All" }]} onChange={setFilter} />
      {!q.data ? <Loading error={q.error} /> : list.length === 0 ? <Empty>{search ? `No booking matches “${search}”.` : filter === "upcoming" ? "No upcoming stays. New bookings appear here." : "Nothing here."}</Empty> : <ScrollX><table className="t bookings"><thead><tr><th>Guest</th><th>Stay</th><th>Rooms</th><th>Channel</th><th className="num">Balance</th><th>Status</th></tr></thead><tbody>{list.map((b: any) => <tr key={b.id} className={open === b.id ? "open" : ""} onClick={() => setOpen(b.id)}>
        <td><button type="button" className="linkbtn" onClick={(e) => { e.stopPropagation(); setOpen(b.id); }}>{b.guest_name}</button>{b.guest_phone && <small>{b.guest_phone}</small>}</td>
        <td className="nowrap">{fmtRange(b.check_in, b.check_out)}<small>{b.nights} night{b.nights > 1 ? "s" : ""}{b.external_ref ? ` · ref ${b.external_ref}` : ""}</small></td>
        <td><span className="roomchips">{String(b.room_names ?? "").split(", ").filter(Boolean).map((n: string, i: number) => <i key={n + i}>{n}</i>)}</span></td>
        <td>{CHANNEL_SHORT[b.channel_code] ?? b.channel_name}</td>
        <td className="num">{b.gross_paise - b.paid_paise > 0 ? <b style={{ color: "var(--amb)" }}>{inr(b.gross_paise - b.paid_paise)}</b> : <span className="muted">paid</span>}<small>of {inr(b.gross_paise)}</small></td>
        <td><div className="pills"><Status s={b.status} />{b.rate_vs_tariff === "below" && <Status s="below" />}</div></td>
      </tr>)}</tbody></table></ScrollX>}
    </Card>

    {newOpen && <Drawer wide title="New booking" sub="the stay, the rooms, the guest · on-tariff bookings approve themselves" onClose={closeNew}
      footer={<><div className="total">{totals.rooms ? <><b>{inr(totals.gross)}</b><small>{totals.rooms} room{totals.rooms > 1 ? "s" : ""} · {totals.nights} night{totals.nights > 1 ? "s" : ""} · incl. GST {inr(totals.gst)}</small>{missing && <small className="need">{missing}</small>}</> : <small>{missing}</small>}</div>
        <div className="actions"><Btn onClick={closeNew}>Close</Btn><Btn kind="primary" disabled={!canSave} title={missing ?? undefined} onClick={save}>Save booking</Btn></div></>}>
      {fromInbox && <div className="note">Booking by hand from the email <b>{fromInbox.subject}</b>. Whatever the email carried is filled in below; check the dates, tap the room, save. The inbox card is marked done when you save. <a href="#inbox" onClick={closeNew}>Cancel and go back</a></div>}
      <div className="section"><div className="sectionhead"><b>1 · Stay</b><span className="sub">{totals.nights > 0 ? `${totals.nights} night${totals.nights > 1 ? "s" : ""} · ${fmtRange(f.check_in, f.check_out)}` : "check-out must be after check-in"}</span></div>
        <div className="form-grid four">
          <Field label="Check-in"><input type="date" value={f.check_in} onChange={(e: any) => { const ci = e.currentTarget.value; setF({ ...f, check_in: ci, check_out: f.check_out <= ci ? addDays(ci, 1) : f.check_out, rooms: {} }); }} /></Field>
          <Field label="Check-out"><input type="date" min={addDays(f.check_in, 1)} value={f.check_out} onChange={(e: any) => setF({ ...f, check_out: e.currentTarget.value, rooms: {} })} /></Field>
          <Field label="Adults"><input type="number" min="1" value={f.adults} onChange={(e: any) => setF({ ...f, adults: Number(e.currentTarget.value) })} /></Field>
          <Field label="Children"><input type="number" min="0" value={f.children} onChange={(e: any) => setF({ ...f, children: Number(e.currentTarget.value) })} /></Field>
        </div>
        <div className="sub" style={{ marginBottom: "6px" }}>Channel</div>
        <ChannelPick channels={refs.channels} value={f.channel_code} onChange={(v) => setF({ ...f, channel_code: v })} />
      </div>
      <div className="section"><div className="sectionhead"><b>2 · Rooms</b><span className="sub">{totals.nights > 0 ? "tap a free room to add it at tariff; change the rate on the tile" : "set the dates first"}</span></div>
        <RoomPicker me={me} rooms={rooms} checkIn={f.check_in} checkOut={f.check_out} sel={f.rooms} onChange={(rs) => setF({ ...f, rooms: rs })} tariffFor={tariffFor} holders={av.holders} loading={av.loading} />
        <SummaryBar t={totals} me={me} isOta={isOta} />
      </div>
      <div className="section"><div className="sectionhead"><b>3 · Guest</b><span className="sub">name and phone are enough; the rest can follow</span></div>
        <div className="form-grid two">
          <Field label="Guest name"><input value={f.guest_name} autoComplete="off" onChange={(e: any) => setF({ ...f, guest_name: e.currentTarget.value })} placeholder="as on the ID" /></Field>
          <Field label="Phone"><input type="tel" inputMode="tel" value={f.guest_phone} onChange={(e: any) => setF({ ...f, guest_phone: e.currentTarget.value })} /></Field>
          <Field label="Email (optional)"><input type="email" value={f.guest_email} onChange={(e: any) => setF({ ...f, guest_email: e.currentTarget.value })} /></Field>
          <Field label="Booking reference (optional)" hint="the reservation number on the OTA or booking-engine email; receipts and cancellations find the booking by it"><input value={f.external_ref ?? ""} onChange={(e: any) => setF({ ...f, external_ref: e.currentTarget.value })} placeholder="e.g. 1060900000106018" /></Field>
        </div>
        <Field label="Notes (optional)"><input value={f.notes} onChange={(e: any) => setF({ ...f, notes: e.currentTarget.value })} placeholder="early check-in, anniversary…" /></Field>
        {sameGuest.length > 0 && <div className="note bad" role="status"><b>{sameGuest[0].guest_name} already has a booking for these dates</b> ({String(sameGuest[0].room_names ?? "")}, {fmtRange(sameGuest[0].check_in, sameGuest[0].check_out)}). If it is the same stay, add this room to that booking with Amend, so the guest has one bill and pays once. <a href="#resv" onClick={(e) => { e.preventDefault(); setNewOpen(false); setOpen(sameGuest[0].id); }}>Open that booking</a></div>}
      </div>
    </Drawer>}

    {open && <Drawer wide title={detail.data?.guest?.name ?? "Booking"} sub={detail.data ? `${fmtRange(detail.data.booking.check_in, detail.data.booking.check_out)} · ${detail.data.channel.name}` : undefined} onClose={() => setOpen(null)}>
      {!detail.data ? <Loading error={detail.error} /> : <BookingDetail me={me} refs={refs} d={detail.data} rooms={rooms} tariffFor={tariffFor} onChange={async () => { await Promise.all([q.reload(), detail.reload()]); }} onClose={() => setOpen(null)} />}
    </Drawer>}
  </>;
}

/** One booking: who, when, which rooms, what is owed; cancel or delete per the rules; amend with the same room picker. */
function BookingDetail({ me, refs, d, rooms, tariffFor, onChange, onClose }: { me: Me; refs: Ref; d: any; rooms: Ref["locations"]; tariffFor: (roomId: string, night: string) => number | null; onChange: () => Promise<void>; onClose: () => void }) {
  const b = d.booking; const live = ["provisional", "approved", "checked_in"].includes(b.status);
  const canDelete = b.status === "provisional" && (me.actor.role !== "sales" || b.created_by === me.actor.id) && d.paid_paise === 0;
  const roomTotal = d.rooms.reduce((s: number, r: any) => s + r.room_total_paise, 0); const gst = d.rooms.reduce((s: number, r: any) => s + r.gst_paise, 0);
  const guests = `${b.adults} adult${b.adults > 1 ? "s" : ""}${b.children ? `, ${b.children} child${b.children > 1 ? "ren" : ""}` : ""}`;
  const cancel = async () => { const reason = await askText(`Cancel ${d.guest?.name ?? "this booking"}'s booking?`, "Cancellation reason", { ok: "Cancel booking", cancel: "Keep booking", danger: true, body: "The rooms are released at once." }); if (reason) await run(async () => { await post(`/bookings/${b.id}/cancel`, { reason }); await onChange(); }, "Cancelled · rooms released"); };
  const remove = async () => { if (await askConfirm(`Delete ${d.guest?.name ?? "this"} booking?`, "Use this only for a booking made by mistake. Nothing has been paid on it, so it leaves no trace in the books.", { ok: "Delete", danger: true })) await run(async () => { await del(`/bookings/${b.id}`); onClose(); await onChange(); }, "Deleted"); };
  return <div className="detail">
    <div className="detailhead">
      <div>
        <div className="pills"><Status s={b.status} />{b.rate_vs_tariff === "below" && <Status s="below" />}</div>
        <div className="sub">{b.external_ref ? `ref ${b.external_ref}` : "no booking reference"}{d.guest.phone ? ` · ${d.guest.phone}` : ""}{d.guest.email ? ` · ${d.guest.email}` : ""}</div>
      </div>
      <div className="actions">
        {canDelete && <Btn kind="danger" onClick={remove}>Delete</Btn>}
        {["provisional", "approved"].includes(b.status) && <Btn kind="danger" onClick={cancel}>Cancel booking</Btn>}
      </div>
    </div>
    <div className="detailgrid">
      <div>
        <div className="facts">
          <div><small>Check-in</small><b>{fmtDate(b.check_in)}</b></div>
          <div><small>Check-out</small><b>{fmtDate(b.check_out)}</b></div>
          <div><small>Duration</small><b>{b.nights} night{b.nights > 1 ? "s" : ""}</b></div>
          <div><small>Guests</small><b>{guests}</b></div>
          <div><small>Channel</small><b>{d.channel.name}</b></div>
          <div><small>Rooms</small><b><span className="roomchips">{d.rooms.map((r: any) => <i key={r.id}>{r.room_name}</i>)}</span></b></div>
        </div>
        <div className="sectionhead"><b>Rooms and rates</b></div>
        {d.rooms.map((r: any) => <Row key={r.id} label={<><b>{r.room_name}</b> · {r.nights} night{r.nights > 1 ? "s" : ""} @ {inr(r.nightly_rate_paise)}</>} sub={`${r.tariff_rate_paise ? `tariff ${inr(r.tariff_rate_paise)} · ` : ""}GST ${r.gst_rate_bp / 100}%`} value={inr(r.room_total_paise + r.gst_paise)} />)}
        {b.notes && <div className="note" style={{ whiteSpace: "pre-line", marginTop: "12px" }}>{b.notes}</div>}
        {(d.invoices.length > 0 || d.approvals.some((a: any) => a.status !== "auto")) && <div className="sectionhead" style={{ marginTop: "14px" }}><b>Invoices and approvals</b></div>}
        {d.invoices.map((i: any) => <Row key={i.id} label={`Invoice ${i.number}`} sub={fmtDate(i.issued_on)} value={<Status s={i.status} />} />)}
        {d.approvals.filter((a: any) => a.status !== "auto").map((a: any) => <Row key={a.id} label={`${a.kind} approval`} sub={a.note} value={<Status s={a.status} />} />)}
      </div>
      <aside className="pricebox" aria-label="Money">
        <Row label="Room total" sub="ex-GST" value={inr(roomTotal)} />
        <Row label="GST" value={inr(gst)} />
        <Row strong label="Gross" value={inr(b.gross_paise)} />
        <Row label="Paid" value={inr(d.paid_paise)} />
        <Row strong label="Balance" value={<span style={d.balance_paise > 0 ? { color: "var(--amb)" } : undefined}>{inr(d.balance_paise)}</span>} />
        {d.payments.filter((p: any) => p.status !== "void").map((p: any) => <div className="sub" key={p.id}>{fmtDate(p.received_on)} · {PAY_LABEL[p.method] ?? p.method} · {inr(p.amount_paise)}{p.kind === "refund" ? " refund" : ""}</div>)}
        {me.capabilities.includes("payments") && d.channel.collection_type !== "channel_collect" && !["cancelled", "no_show"].includes(b.status) && d.balance_paise > 0 && <RecordPayment key={`${b.id}:${d.paid_paise}`} me={me} refs={refs} d={d} onDone={onChange} />}
      </aside>
    </div>
    <details><summary>Change history ({d.audit.length})</summary>{d.audit.map((a: any) => <div className="muted" key={a.id}>{fmtDateTime(a.at)} · {a.actor_email} · {actionLabel(a.action)}{a.action === "booking.amend" && a.after_json ? ` · ${JSON.parse(a.after_json).remark ?? ""}` : ""}</div>)}</details>
    {live && <Amend key={b.id} me={me} d={d} rooms={rooms} refs={refs} tariffFor={tariffFor} onDone={onChange} />}
  </div>;
}

const PAY_LABEL: Record<string, string> = { upi: "UPI", bank: "Bank transfer", card: "Card", airpay: "Airpay", cash: "Cash", ota: "OTA" };

/** Record what the guest has paid towards this booking: an advance or the balance, by UPI, bank transfer, card or Airpay link. */
function RecordPayment({ me, refs, d, onDone }: { me: Me; refs: Ref; d: any; onDone: () => Promise<void> }) {
  const [openP, setOpenP] = useState(false);
  const methods = Object.entries(PAY_LABEL).filter(([v]) => v !== "ota" && (v !== "cash" || me.actor.role !== "sales"));
  const [f, setF] = useState({ amount: String(d.balance_paise / 100), method: "upi", account_id: defaultBankId(refs.accounts), received_on: todayIso(), reference: "" });
  const amount = Math.round(Number(f.amount) * 100);
  const save = () => run(async () => {
    const r = await post("/payments", { booking_id: d.booking.id, method: f.method, amount_paise: amount, received_on: f.received_on, reference: f.reference.trim() || null, account_id: ["upi", "bank"].includes(f.method) ? f.account_id || undefined : undefined });
    toast(`Recorded ${inr(amount)} · balance ${inr(r.balance_paise ?? 0)}`); setOpenP(false); await onDone();
  });
  if (!openP) return <div className="actions end" style={{ marginTop: "10px" }}><Btn kind="gold" onClick={() => setOpenP(true)}>Record payment</Btn></div>;
  return <div className="payform" style={{ marginTop: "10px" }}>
    <Field label="Amount received (₹)" hint={`balance ${inr(d.balance_paise)}: an advance or part-payment is fine`}><input inputMode="decimal" value={f.amount} onChange={(e: any) => setF({ ...f, amount: e.currentTarget.value })} /></Field>
    <Chips label="Paid by" value={f.method} options={methods.map(([value, label]) => ({ value, label }))} onChange={(v) => setF({ ...f, method: v })} />
    {["upi", "bank"].includes(f.method) && <BankPick accounts={refs.accounts} value={f.account_id} onChange={(v) => setF({ ...f, account_id: v })} label="Received into" />}
    <Field label="Date received"><input type="date" value={f.received_on} max={todayIso()} onChange={(e: any) => setF({ ...f, received_on: e.currentTarget.value })} /></Field>
    <Field label="Reference (optional)" hint="UPI / UTR number or Airpay ID helps the bank match"><input value={f.reference} onChange={(e: any) => setF({ ...f, reference: e.currentTarget.value })} /></Field>
    <div className="actions end"><Btn onClick={() => setOpenP(false)}>Cancel</Btn><Btn kind="gold" disabled={!(amount > 0)} onClick={save}>Record {inr(amount > 0 ? amount : 0)}</Btn></div>
  </div>;
}

/** Correct a booking in place: room exchange, dates, rates, guest, channel. A remark is required and lands in the audit trail. */
function Amend({ me, d, rooms, refs, tariffFor, onDone }: { me: Me; d: any; rooms: Ref["locations"]; refs: Ref; tariffFor: (roomId: string, night: string) => number | null; onDone: () => Promise<void> }) {
  const cur: Record<string, string> = {}; for (const r of d.rooms) cur[r.room_id] = String(r.nightly_rate_paise / 100);
  const [openA, setOpenA] = useState(false);
  const [a, setA] = useState<any>({ guest_name: d.guest.name, guest_phone: d.guest.phone ?? "", check_in: d.booking.check_in, check_out: d.booking.check_out, adults: d.booking.adults, children: d.booking.children, channel_code: d.channel.code, external_ref: d.booking.external_ref ?? "", rooms: cur, remark: "" });
  const av = useHolders(a.check_in, a.check_out, d.booking.id);
  const totals = stayTotals(me, a.rooms, a.check_in, a.check_out, tariffFor);
  const channel = refs.channels.find((c) => c.code === a.channel_code);
  const changed = a.guest_name !== d.guest.name || a.guest_phone !== (d.guest.phone ?? "") || a.check_in !== d.booking.check_in || a.check_out !== d.booking.check_out || a.adults !== d.booking.adults || a.children !== d.booking.children || a.channel_code !== d.channel.code || a.external_ref.trim() !== (d.booking.external_ref ?? "") || JSON.stringify(a.rooms) !== JSON.stringify(cur);
  const save = () => run(async () => {
    const r = await post(`/bookings/${d.booking.id}/amend`, { ...a, rooms: Object.entries(a.rooms as Record<string, string>).filter(([, v]) => v !== "").map(([room_id, v]) => ({ room_id, nightly_rate_paise: Math.round(Number(v) * 100) })) });
    toast(r.booking.needsApproval ? `Amended · awaiting approval (${r.booking.approval.reasons.join(", ")})` : "Amended · audited · front desk notified");
    setOpenA(false); await onDone();
  });
  if (!openA) return <div className="actions end" style={{ marginTop: "12px" }}><Btn kind="primary" onClick={() => setOpenA(true)}>Amend this booking</Btn></div>;
  return <div className="amend">
    <div className="sectionhead"><b>Amend</b><span className="sub">room exchange, dates, rate, guest or channel · say why in the remark; the change is audited and the front desk is told</span></div>
    <div className="form-grid four">
      <Field label="Check-in"><input type="date" value={a.check_in} onChange={(e: any) => setA({ ...a, check_in: e.currentTarget.value })} /></Field>
      <Field label="Check-out"><input type="date" value={a.check_out} onChange={(e: any) => setA({ ...a, check_out: e.currentTarget.value })} /></Field>
      <Field label="Adults"><input type="number" min="1" value={a.adults} onChange={(e: any) => setA({ ...a, adults: Number(e.currentTarget.value) })} /></Field>
      <Field label="Children"><input type="number" min="0" value={a.children} onChange={(e: any) => setA({ ...a, children: Number(e.currentTarget.value) })} /></Field>
    </div>
    <RoomPicker me={me} rooms={rooms} checkIn={a.check_in} checkOut={a.check_out} sel={a.rooms} onChange={(rs) => setA({ ...a, rooms: rs })} tariffFor={tariffFor} holders={av.holders} loading={av.loading} />
    <SummaryBar t={totals} me={me} isOta={!!channel && channel.collection_type !== "direct"} label="After the change" />
    <div className="sub" style={{ margin: "12px 0 6px" }}>Channel</div>
    <ChannelPick channels={refs.channels} value={a.channel_code} onChange={(v) => setA({ ...a, channel_code: v })} />
    <div className="form-grid two" style={{ marginTop: "12px" }}>
      <Field label="Guest"><input value={a.guest_name} onChange={(e: any) => setA({ ...a, guest_name: e.currentTarget.value })} /></Field>
      <Field label="Phone"><input type="tel" inputMode="tel" value={a.guest_phone} onChange={(e: any) => setA({ ...a, guest_phone: e.currentTarget.value })} /></Field>
      <Field label="Booking reference" hint="the reservation number on the email"><input value={a.external_ref} onChange={(e: any) => setA({ ...a, external_ref: e.currentTarget.value })} placeholder="e.g. 1060900000106018" /></Field>
      <Field label="Remark (required)" hint="what was wrong and what changed"><input value={a.remark} onChange={(e: any) => setA({ ...a, remark: e.currentTarget.value })} placeholder="e.g. Cleartrip mapped the room type wrongly; moved to Superior" /></Field>
    </div>
    <div className="actions end"><Btn onClick={() => setOpenA(false)}>Discard</Btn><Btn kind="primary" disabled={!changed || a.remark.trim().length < 3 || totals.rooms === 0} onClick={save}>Save amendment</Btn></div>
  </div>;
}

export function Availability({ refs }: { me: Me; refs: Ref }) {
  const [from, setFrom] = useState(todayIso());
  const days = 14;
  const to = new Date(Date.parse(from) + (days - 1) * 86400000).toISOString().slice(0, 10);
  const q = useLoad(() => get(`/bookings/availability?from=${from}&to=${to}`), [from]);
  const nights = Array.from({ length: days }, (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10));
  return <>
    <h1>Availability <small>room-nights: booked, held (48 h) or free — the double-booking guard</small></h1>
    <div className="actions" style={{ marginBottom: "10px" }}><Btn title={`Previous ${days} days`} onClick={() => setFrom(new Date(Date.parse(from) - days * 86400000).toISOString().slice(0, 10))}>← {days} d</Btn><input type="date" aria-label="Show from" value={from} onChange={(e: any) => setFrom(e.currentTarget.value)} /><Btn title={`Next ${days} days`} onClick={() => setFrom(new Date(Date.parse(from) + days * 86400000).toISOString().slice(0, 10))}>{days} d →</Btn><span className="legend" aria-hidden="true"><i className="c booked" />booked<i className="c hold" />held<i className="c" />free</span></div>
    {!q.data ? <Loading error={q.error} /> : <Card><ScrollX className="avail" label="Availability"><div role="table" aria-label={`Room availability from ${fmtDate(from)}`}><div className="r" role="row"><div className="n" role="columnheader"><span className="sr-only">Room</span></div>{nights.map((n) => <div className="c h" role="columnheader" key={n}>{n.slice(8)}/{n.slice(5, 7)}</div>)}</div>
      {q.data.rooms.map((r: any) => <div className="r" role="row" key={r.id}><div className="n" role="rowheader">{r.name}</div>{nights.map((n) => { const t = q.data.taken.find((x: any) => x.room_id === r.id && x.night === n); const what = t ? `${t.kind === "hold" ? "held" : "booked"}${t.guest_name ? ` · ${t.guest_name}` : ""}` : "free"; return <div key={n} role="cell" className={`c ${t ? t.kind : ""}`} title={what} aria-label={`${fmtDate(n)}: ${what}`}>{t ? (t.guest_name ?? "hold").slice(0, 3) : ""}</div>; })}</div>)}</div></ScrollX></Card>}
  </>;
}
export { patch as _p };
