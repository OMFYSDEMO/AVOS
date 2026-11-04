import { newRouter, requireCap, body, str, optStr, int, oneOf, paise, optDate } from "../app";
import { Batch, HttpError, all, one, id } from "../db";
import { gstinFormatValid } from "../domain/gst";
import { CAN, allowed } from "../auth";
import { todayIn } from "../domain/dates";
import { setPassword, createPasswordLink } from "./auth";
import { EXPENSE_CATEGORIES, EXPENSE_FAMILIES, COMMON_PETTY, COMMON_BANK } from "../domain/expenseCategories";
import { randomToken, cookieValue, sessionCookie } from "../auth";
import { driveConfigured, driveConsentUrl, driveRedirectUri, exchangeCode, driveIntegration, googleDrive, DRIVE_ROOT_FOLDER, runIdArchive } from "../services/drive";
import { nowIso } from "../domain/dates";

const r = newRouter();

/** Who am I, what may I do, and the reference data every screen needs. */
r.get("/me", async (c) => {
  const actor = c.get("actor"); const p = c.get("property");
  const caps = Object.entries(CAN).filter(([, roles]) => roles.includes(actor.role)).map(([k]) => k);
  const unread = await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", actor.id);
  const cred = await one<{ must_change: number }>(c.env.DB, "SELECT must_change FROM credentials WHERE user_id = ?", actor.id);
  return c.json({ must_change_password: !!cred?.must_change, has_password: !!cred, actor, property: { id: p.id, name: p.name, gstin: p.gstin, timezone: p.timezone, today: todayIn(p.timezone), invoice_prefix: p.invoice_prefix, auto_approve_on_tariff: p.auto_approve_on_tariff === 1, gst_nil_upto_paise: p.gst_nil_upto_paise, gst_threshold_paise: p.gst_threshold_paise, gst_rate_below_bp: p.gst_rate_below_bp, gst_rate_above_bp: p.gst_rate_above_bp }, capabilities: caps, unread_notifications: unread?.n ?? 0 });
});

r.get("/ref", async (c) => {
  const p = c.get("property");
  const [locations, channels, accounts, users, rateCards, equipment] = await Promise.all([
    all(c.env.DB, "SELECT id, kind, code, name, sort FROM locations WHERE property_id = ? AND active = 1 ORDER BY kind DESC, sort", p.id),
    all(c.env.DB, "SELECT id, code, name, collection_type, commission_bp, commission_gst_bp, commission_rcm_bp, payment_fee_bp, tcs_bp, tds_bp FROM channels WHERE property_id = ? AND active = 1", p.id),
    all(c.env.DB, "SELECT id, kind, name, holder_role, is_default, account_no FROM money_accounts WHERE property_id = ? AND active = 1 ORDER BY kind, is_default DESC, name", p.id),
    all(c.env.DB, "SELECT id, name, role FROM users WHERE property_id = ? AND active = 1", p.id),
    all(c.env.DB, "SELECT id, room_id, name, rate_paise, from_date, to_date, priority FROM rate_cards WHERE property_id = ? ORDER BY room_id, priority", p.id),
    all(c.env.DB, "SELECT id, location_id, name, sort FROM equipment WHERE property_id = ? AND active = 1 ORDER BY sort, name", p.id),
  ]);
  // The front desk and sales get account names (to say where a UPI landed) but no account numbers, and no OTA commercial terms.
  const fin = allowed(c.get("actor"), "finance");
  if (!fin) {
    for (const a of accounts as any[]) delete a.account_no;
    for (const ch of channels as any[]) { delete ch.commission_bp; delete ch.commission_gst_bp; delete ch.commission_rcm_bp; delete ch.payment_fee_bp; delete ch.tcs_bp; delete ch.tds_bp; }
  }
  return c.json({ locations, equipment, channels, accounts, users, rate_cards: rateCards, expense_categories: EXPENSE_CATEGORIES, expense_families: EXPENSE_FAMILIES, common_categories: { petty: COMMON_PETTY, bank: COMMON_BANK } });
});

r.get("/notifications", async (c) => {
  const actor = c.get("actor");
  const rows = await all(c.env.DB, "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", actor.id);
  return c.json({ notifications: rows });
});
r.post("/notifications/read", async (c) => {
  const actor = c.get("actor");
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const ids: string[] = Array.isArray(x.ids) ? x.ids.map(String) : [];
  const b = new Batch(c.env.DB, actor);
  if (ids.length) b.add(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`, actor.id, ...ids);
  else b.add("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL", actor.id);
  await b.run();
  return c.json({ ok: true });
});

// ---- Files (bill photos, task photos) in private R2; served only through the role-checked API ----
r.post("/files", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const ct = c.req.header("content-type") ?? "application/octet-stream";
  if (!/^image\/(jpeg|png|webp|heic)|application\/pdf/.test(ct)) throw new HttpError(400, "upload an image or PDF with the right content-type");
  const purpose = c.req.query("purpose") ?? "bill";
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) throw new HttpError(413, "max 8 MB");
  const key = `${purpose}/${p.id}/${todayIn(p.timezone).slice(0, 7)}/${id("f")}.${ct.includes("pdf") ? "pdf" : ct.split("/")[1].replace("jpeg", "jpg")}`;
  await c.env.FILES.put(key, buf, { httpMetadata: { contentType: ct }, customMetadata: { uploaded_by: actor.id } });
  return c.json({ key }, 201);
});
r.get("/files/*", async (c) => {
  const p = c.get("property");
  const key = c.req.path.replace(/^\/api\/files\//, "");
  if (!key.split("/")[1] || key.split("/")[1] !== p.id) throw new HttpError(403, "not your property's file");
  // Each kind of file goes only to the roles allowed to see what it records.
  const actor = c.get("actor"); const kind = key.split("/")[0];
  const may = kind === "packs" ? allowed(actor, "close")
    : kind === "inbox" ? allowed(actor, "finance")
    : kind === "ids" ? allowed(actor, "ids_view")
    : allowed(actor, "petty_expenses") || allowed(actor, "bank_expenses") || allowed(actor, "pnl_reports") || allowed(actor, "tasks");
  if (!may) throw new HttpError(403, `${actor.role} may not open this file`);
  const obj = await c.env.FILES.get(key);
  if (!obj) throw new HttpError(404, "file not found");
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "private, max-age=3600" } });
});

// ---- Owner admin: users, property settings, rate cards, channels ----
const admin = newRouter();
admin.use("*", requireCap("admin"));
admin.get("/users", async (c) => c.json({ users: await all(c.env.DB, "SELECT id, email, name, role, phone, active, created_at FROM users WHERE property_id = ? ORDER BY role, name", c.get("property").id) }));
admin.post("/users", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const uid = id("usr");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("INSERT INTO users (id, property_id, email, name, role, phone) VALUES (?,?,?,?,?,?)", uid, p.id, str(x.email, "email").toLowerCase(), str(x.name, "name"), oneOf(x.role, "role", ["sales", "property", "revenue", "owner", "accountant"] as const), optStr(x.phone, "phone"));
  b.audit("user.create", "user", uid, null, { email: x.email, role: x.role });
  await b.run();
  return c.json({ id: uid }, 201);
});
admin.patch("/users/:id", async (c) => {
  const p = c.get("property"); const actor = c.get("actor"); const x = await body(c);
  const u: any = await one(c.env.DB, "SELECT * FROM users WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!u) throw new HttpError(404, "user not found");
  const after: Record<string, unknown> = {};
  if (x.role !== undefined) after.role = oneOf(x.role, "role", ["sales", "property", "revenue", "owner", "accountant"] as const);
  if (x.active !== undefined) after.active = x.active ? 1 : 0;
  if (x.name !== undefined) after.name = str(x.name, "name");
  if (x.phone !== undefined) after.phone = optStr(x.phone, "phone");
  if (u.id === actor.id && (after.active === 0 || (after.role && after.role !== "owner"))) throw new HttpError(400, "you cannot demote or deactivate yourself");
  if (!Object.keys(after).length) throw new HttpError(400, "nothing to update");
  const b = new Batch(c.env.DB, actor);
  b.add(`UPDATE users SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(after), u.id);
  b.audit("user.update", "user", u.id, Object.fromEntries(Object.keys(after).map((k) => [k, u[k]])), after);
  await b.run();
  return c.json({ ok: true });
});
/** Owner sets a temporary password; the user must change it at first sign-in. */
admin.post("/users/:id/set-password", async (c) => {
  const p = c.get("property"); const actor = c.get("actor"); const x = await body(c);
  const u = await one<{ id: string; email: string }>(c.env.DB, "SELECT id, email FROM users WHERE id = ? AND property_id = ? AND active = 1", c.req.param("id"), p.id);
  if (!u) throw new HttpError(404, "user not found");
  await setPassword(c.env.DB, u.id, str(x.password, "password"), x.must_change !== false, actor, "password.set_by_owner");
  return c.json({ ok: true, must_change: x.must_change !== false });
});
/** Owner gets a one-time set-password link to hand to the user (valid 72 h). */
admin.post("/users/:id/password-link", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const u = await one<{ id: string; email: string }>(c.env.DB, "SELECT id, email FROM users WHERE id = ? AND property_id = ? AND active = 1", c.req.param("id"), p.id);
  if (!u) throw new HttpError(404, "user not found");
  const link = await createPasswordLink(c.env.DB, c.env, c.req.raw, u.id, "invite", actor.id);
  const b = new Batch(c.env.DB, actor); b.audit("password.link", "user", u.id, null, { by: actor.id }); await b.run();
  return c.json({ link, expires_in_hours: 72, email: u.email });
});
admin.get("/users/:id/sessions", async (c) => {
  const p = c.get("property");
  const rows = await all(c.env.DB, "SELECT s.created_at, s.last_seen_at, s.expires_at, s.user_agent, s.revoked_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.property_id = ? AND s.user_id = ? ORDER BY s.created_at DESC LIMIT 20", p.id, c.req.param("id"));
  return c.json({ sessions: rows });
});
admin.post("/users/:id/sign-out-everywhere", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE property_id = ?)", c.req.param("id"), p.id);
  b.audit("sessions.revoke_all", "user", c.req.param("id"), null, null);
  await b.run();
  return c.json({ ok: true });
});
admin.get("/property", async (c) => c.json({ property: c.get("property") }));
admin.patch("/property", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const after: Record<string, unknown> = {};
  for (const k of ["name", "legal_name", "address", "state_code", "invoice_prefix"]) if (x[k] !== undefined) after[k] = optStr(x[k], k);
  if (x.gstin !== undefined) { const g = optStr(x.gstin, "gstin"); if (g && !gstinFormatValid(g)) throw new HttpError(400, "GSTIN format invalid"); after.gstin = g?.toUpperCase() ?? null; }
  for (const k of ["gst_nil_upto_paise", "gst_threshold_paise", "gst_rate_below_bp", "gst_rate_above_bp", "auto_approve_max_rooms", "quote_valid_hours", "hold_hours", "lead_nudge_minutes", "lead_escalate_minutes", "recon_fee_tolerance_bp", "recon_subset_tolerance_bp"]) if (x[k] !== undefined) after[k] = int(x[k], k, { min: 0 });
  if (x.auto_approve_on_tariff !== undefined) after.auto_approve_on_tariff = x.auto_approve_on_tariff ? 1 : 0;
  if (x.inbox_automation !== undefined) after.inbox_automation = x.inbox_automation ? 1 : 0;
  if (x.pos_account_id !== undefined) {
    const pos = optStr(x.pos_account_id, "pos_account_id");
    if (pos && !(await one(c.env.DB, "SELECT id FROM money_accounts WHERE id = ? AND property_id = ? AND kind = 'bank' AND active = 1", pos, p.id))) throw new HttpError(400, "the card machine must settle into an open bank account");
    after.pos_account_id = pos;
  }
  if (!Object.keys(after).length) throw new HttpError(400, "nothing to update");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add(`UPDATE properties SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(after), p.id);
  b.audit("property.update", "property", p.id, Object.fromEntries(Object.keys(after).map((k) => [k, (p as any)[k]])), after);
  await b.run();
  return c.json({ ok: true });
});
// ---- Money accounts: banks come and go; the default bank is where money lands unless someone picks another ----
admin.get("/accounts", async (c) => c.json({ accounts: await all(c.env.DB, "SELECT * FROM money_accounts WHERE property_id = ? ORDER BY active DESC, kind, is_default DESC, name", c.get("property").id) }));
admin.post("/accounts", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const aid = id("acc");
  const name = str(x.name, "name", { max: 60 });
  const opening = x.opening_paise !== undefined ? int(x.opening_paise, "opening_paise", { min: -1_000_000_000_00 }) : 0;
  const openingDate = optDate(x.opening_date, "opening_date") ?? todayIn(p.timezone);
  const makeDefault = !!x.is_default;
  const b = new Batch(c.env.DB, c.get("actor"));
  if (makeDefault) b.add("UPDATE money_accounts SET is_default = 0 WHERE property_id = ? AND kind = 'bank'", p.id);
  b.add("INSERT INTO money_accounts (id, property_id, kind, name, holder_role, opening_paise, opening_date, active, is_default, account_no, note) VALUES (?,?,'bank',?,'owner',?,?,1,?,?,?)",
    aid, p.id, name, opening, openingDate, makeDefault ? 1 : 0, optStr(x.account_no, "account_no"), optStr(x.note, "note"));
  b.audit("account.create", "money_account", aid, null, { name, opening_paise: opening, opening_date: openingDate, is_default: makeDefault });
  await b.run();
  return c.json({ id: aid }, 201);
});
admin.patch("/accounts/:id", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const a: any = await one(c.env.DB, "SELECT * FROM money_accounts WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!a) throw new HttpError(404, "account not found");
  const after: Record<string, unknown> = {};
  if (x.name !== undefined) after.name = str(x.name, "name", { max: 60 });
  if (x.opening_paise !== undefined) after.opening_paise = int(x.opening_paise, "opening_paise", { min: -1_000_000_000_00 });
  if (x.opening_date !== undefined) after.opening_date = optDate(x.opening_date, "opening_date");
  if (x.account_no !== undefined) after.account_no = optStr(x.account_no, "account_no");
  if (x.note !== undefined) after.note = optStr(x.note, "note");
  if (x.active !== undefined) {
    after.active = x.active ? 1 : 0;
    if (!x.active && a.kind === "bank" && a.is_default) throw new HttpError(409, "make another bank the default before closing this one");
  }
  const b = new Batch(c.env.DB, c.get("actor"));
  if (x.is_default && a.kind === "bank") { b.add("UPDATE money_accounts SET is_default = 0 WHERE property_id = ? AND kind = 'bank'", p.id); after.is_default = 1; }
  if (!Object.keys(after).length) throw new HttpError(400, "nothing to update");
  b.add(`UPDATE money_accounts SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(after), a.id);
  b.audit("account.update", "money_account", a.id, Object.fromEntries(Object.keys(after).map((k) => [k, a[k]])), after);
  await b.run();
  return c.json({ ok: true });
});

admin.post("/rate-cards", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const room = await one(c.env.DB, "SELECT id FROM locations WHERE id = ? AND property_id = ? AND kind = 'room'", str(x.room_id, "room_id"), p.id);
  if (!room) throw new HttpError(400, "unknown room");
  const rid = id("rc");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("INSERT INTO rate_cards (id, property_id, room_id, name, rate_paise, from_date, to_date, priority) VALUES (?,?,?,?,?,?,?,?)", rid, p.id, x.room_id, str(x.name, "name"), paise(x.rate_paise, "rate_paise"), optDate(x.from_date, "from_date"), optDate(x.to_date, "to_date"), int(x.priority ?? 0, "priority", { min: 0, optional: true }));
  b.audit("rate_card.create", "rate_card", rid, null, x);
  await b.run();
  return c.json({ id: rid }, 201);
});
admin.delete("/rate-cards/:id", async (c) => {
  const p = c.get("property");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("DELETE FROM rate_cards WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  b.audit("rate_card.delete", "rate_card", c.req.param("id"), null, null);
  await b.run();
  return c.json({ ok: true });
});
/** Common areas and the equipment in them (kitchen: microwave, oven, fridge…), for maintenance tasks. */
admin.post("/locations", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const name = str(x.name, "name", { max: 60 }).trim();
  const code = (optStr(x.code, "code") ?? name).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 12) || "AREA";
  if (await one(c.env.DB, "SELECT id FROM locations WHERE property_id = ? AND active = 1 AND lower(name) = lower(?)", p.id, name)) throw new HttpError(409, `${name} already exists`);
  const sort = ((await one<{ s: number }>(c.env.DB, "SELECT COALESCE(MAX(sort), 0) AS s FROM locations WHERE property_id = ?", p.id))?.s ?? 0) + 10;
  const lid = id("loc");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("INSERT INTO locations (id, property_id, kind, code, name, sort, active) VALUES (?,?,'area',?,?,?,1)", lid, p.id, code, name, sort);
  b.audit("location.create", "location", lid, null, { kind: "area", name, code });
  await b.run();
  return c.json({ id: lid, name, code }, 201);
});
admin.post("/equipment", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const loc = await one<{ id: string; name: string }>(c.env.DB, "SELECT id, name FROM locations WHERE id = ? AND property_id = ? AND active = 1", str(x.location_id, "location_id"), p.id);
  if (!loc) throw new HttpError(400, "unknown area");
  const names = (Array.isArray(x.names) ? x.names : [x.name]).map((n: unknown) => str(n, "name", { max: 60 }).trim()).filter(Boolean);
  if (!names.length) throw new HttpError(400, "name is required");
  const have = new Set((await all<{ name: string }>(c.env.DB, "SELECT lower(name) AS name FROM equipment WHERE location_id = ? AND active = 1", loc.id)).map((e) => e.name));
  const b = new Batch(c.env.DB, c.get("actor"));
  const ids: string[] = [];
  names.forEach((name: string, i: number) => {
    if (have.has(name.toLowerCase())) return;
    have.add(name.toLowerCase());
    const eid = id("eqp"); ids.push(eid);
    b.add("INSERT INTO equipment (id, property_id, location_id, name, sort) VALUES (?,?,?,?,?)", eid, p.id, loc.id, name, (i + 1) * 10);
    b.audit("equipment.create", "equipment", eid, null, { location: loc.name, name });
  });
  if (ids.length) await b.run();
  return c.json({ ids }, 201);
});
admin.patch("/equipment/:id", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const e: any = await one(c.env.DB, "SELECT * FROM equipment WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!e) throw new HttpError(404, "equipment not found");
  const after: Record<string, unknown> = {};
  if (x.name !== undefined) after.name = str(x.name, "name", { max: 60 }).trim();
  if (x.active !== undefined) after.active = x.active ? 1 : 0;
  if (!Object.keys(after).length) throw new HttpError(400, "nothing to update");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add(`UPDATE equipment SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(after), e.id);
  b.audit("equipment.update", "equipment", e.id, { name: e.name, active: e.active }, after);
  await b.run();
  return c.json({ ok: true });
});

admin.patch("/channels/:id", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const ch: any = await one(c.env.DB, "SELECT * FROM channels WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!ch) throw new HttpError(404, "channel not found");
  const after: Record<string, unknown> = {};
  for (const k of ["commission_bp", "commission_gst_bp", "commission_rcm_bp", "payment_fee_bp", "tcs_bp", "tds_bp"]) if (x[k] !== undefined) after[k] = int(x[k], k, { min: 0, max: 5000 });
  for (const k of ["commission_base", "payment_fee_base", "tcs_base", "tds_base"]) if (x[k] !== undefined) after[k] = oneOf(x[k], k, ["ex_gst", "gross"] as const);
  if (x.collection_type !== undefined) after.collection_type = oneOf(x.collection_type, "collection_type", ["direct", "channel_collect", "hotel_collect"] as const);
  if (x.name !== undefined) after.name = str(x.name, "name");
  if (!Object.keys(after).length) throw new HttpError(400, "nothing to update");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add(`UPDATE channels SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(after), ch.id);
  b.audit("channel.update", "channel", ch.id, Object.fromEntries(Object.keys(after).map((k) => [k, ch[k]])), after);
  await b.run();
  return c.json({ ok: true });
});
// ---- Integrations: Google Drive for the guest-ID archive (owner connects their own Google account once) ----
const DRIVE_STATE_COOKIE = "avos_drive_state";
admin.get("/integrations/google-drive", async (c) => {
  const row = await driveIntegration(c.env.DB, c.get("property").id);
  const origin = new URL(c.req.url).origin;
  return c.json({ configured: driveConfigured(c.env), redirect_uri: driveRedirectUri(c.env, origin), connected: !!row, account_email: row?.account_email ?? null, folder_link: row?.folder_link ?? null, connected_at: row?.connected_at ?? null, last_used_at: row?.last_used_at ?? null, last_error: row?.last_error ?? null });
});
/** Start the consent flow: the browser follows the returned URL to Google and comes back to the callback below. */
admin.post("/integrations/google-drive/connect", async (c) => {
  if (!driveConfigured(c.env)) throw new HttpError(409, "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on the Worker yet");
  const state = randomToken(16);
  c.header("set-cookie", sessionCookie(state, c.req.raw, 600).replace(/^avos_session=/, `${DRIVE_STATE_COOKIE}=`));
  return c.json({ url: driveConsentUrl(c.env, new URL(c.req.url).origin, state) });
});
admin.get("/integrations/google-drive/callback", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const q = c.req.query();
  const back = (msg: string) => c.redirect(`/#admin?drive=${encodeURIComponent(msg)}`, 302);
  if (q.error) return back(`Google said: ${q.error}`);
  if (!q.code || !q.state || q.state !== cookieValue(c.req.raw, DRIVE_STATE_COOKIE)) return back("the sign-in did not come back the way it left; try Connect again");
  try {
    const tok = await exchangeCode(c.env, new URL(c.req.url).origin, q.code);
    const root = await googleDrive(tok.access_token).ensureFolder(DRIVE_ROOT_FOLDER, null);
    const b = new Batch(c.env.DB, actor);
    b.add("INSERT INTO integrations (property_id, kind, account_email, refresh_token, folder_id, folder_link, connected_by, connected_at, last_error) VALUES (?,?,?,?,?,?,?,?,NULL) ON CONFLICT(property_id, kind) DO UPDATE SET account_email = excluded.account_email, refresh_token = excluded.refresh_token, folder_id = excluded.folder_id, folder_link = excluded.folder_link, connected_by = excluded.connected_by, connected_at = excluded.connected_at, last_error = NULL",
      p.id, "google_drive", tok.email, tok.refresh_token, root.id, root.link, actor.id, nowIso());
    b.audit("integration.connect", "integration", "google_drive", null, { account_email: tok.email, folder_id: root.id });
    await b.run();
    return back("connected");
  } catch (e) { return back(String((e as Error).message)); }
});
admin.delete("/integrations/google-drive", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const b = new Batch(c.env.DB, actor);
  b.add("DELETE FROM integrations WHERE property_id = ? AND kind = 'google_drive'", p.id);
  b.audit("integration.disconnect", "integration", "google_drive", null, null);
  await b.run();
  return c.json({ ok: true });
});
/** Run the archive step now rather than waiting for the next cron tick (still only stays past the 48-hour mark). */
admin.post("/integrations/google-drive/archive-now", async (c) => {
  const r = await runIdArchive(c.env, c.get("property"), nowIso());
  return c.json(r);
});

r.route("/admin", admin);

export default r;
