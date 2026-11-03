import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";

export type Role = "sales" | "property" | "revenue" | "owner" | "accountant";

export interface Actor {
  id: string;
  property_id: string;
  email: string;
  name: string;
  role: Role;
  /** how the caller was identified: session cookie, Cloudflare Access, or the dev header */
  via?: "session" | "access" | "dev" | "automation";
  session_id?: string;
}

// ---------- passwords ----------
export const PBKDF2_ITERATIONS = 100_000; // Workers cap PBKDF2 at 100k iterations
export const MIN_PASSWORD_LENGTH = 10;
const enc = new TextEncoder();

export function hex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(s: string): Uint8Array { return new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16))); }

export async function hashPassword(password: string, saltHex?: string, iterations = PBKDF2_ITERATIONS) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return { hash: hex(bits), salt: hex(salt), iterations };
}

export async function verifyPassword(password: string, hashHex: string, saltHex: string, iterations: number): Promise<boolean> {
  const { hash } = await hashPassword(password, saltHex, iterations);
  if (hash.length !== hashHex.length) return false;
  let diff = 0; for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

export function passwordProblem(p: string): string | null {
  if (typeof p !== "string" || p.length < MIN_PASSWORD_LENGTH) return `use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (p.length > 200) return "too long";
  if (/^(.)\1+$/.test(p) || /^(0123456789|1234567890|password|qwertyuiop)/i.test(p)) return "that password is too easy to guess";
  return null;
}

// ---------- tokens & sessions ----------
export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function sha256Hex(s: string): Promise<string> { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }

export const SESSION_COOKIE = "avos_session";
export const SESSION_DAYS = 30;
export const LOCK_AFTER_FAILURES = 5;
export const LOCK_MINUTES = 15;

export function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie"); if (!raw) return null;
  for (const part of raw.split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return decodeURIComponent(v.join("=")); }
  return null;
}
export function sessionCookie(value: string, req: Request, maxAgeSeconds: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

interface SessionRow { session_id: string; id: string; property_id: string; email: string; name: string; role: Role; expires_at: string; last_seen_at: string | null }

async function sessionActor(req: Request, db: D1Database): Promise<Actor | null> {
  const value = cookieValue(req, SESSION_COOKIE);
  if (!value) return null;
  const sid = await sha256Hex(value);
  const row = await db.prepare(
    `SELECT s.id AS session_id, u.id, u.property_id, u.email, u.name, u.role, s.expires_at, s.last_seen_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1`).bind(sid, new Date().toISOString()).first<SessionRow>();
  if (!row) return null;
  // touch at most once an hour to keep writes cheap
  if (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > 3_600_000)
    await db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(new Date().toISOString(), sid).run();
  return { id: row.id, property_id: row.property_id, email: row.email, name: row.name, role: row.role, via: "session", session_id: sid };
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function accessEmail(req: Request, env: Env): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN) return null;
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let jwks = jwksCache.get(issuer);
  if (!jwks) { jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); jwksCache.set(issuer, jwks); }
  try {
    const { payload } = await jwtVerify(jwt, jwks, { issuer, ...(env.ACCESS_AUD ? { audience: env.ACCESS_AUD } : {}) });
    return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  } catch { return null; }
}

/**
 * Identify the caller, in order: the app's own session cookie; a Cloudflare Access token when a team is
 * configured; and, outside production only, the dev header / DEV_USER_EMAIL so the API can be exercised locally.
 */
export async function resolveActor(req: Request, env: Env): Promise<Actor | null> {
  const fromSession = await sessionActor(req, env.DB);
  if (fromSession) return fromSession;
  const email = (await accessEmail(req, env)) ?? (env.APP_ENV !== "production" ? (req.headers.get("x-dev-user") || env.DEV_USER_EMAIL || "").toLowerCase() || null : null);
  if (!email) return null;
  const actor = await loadActor(env.DB, email);
  return actor ? { ...actor, via: req.headers.get("Cf-Access-Jwt-Assertion") ? "access" : "dev" } : null;
}

export async function loadActor(db: D1Database, email: string): Promise<Actor | null> {
  const row = await db.prepare("SELECT id, property_id, email, name, role FROM users WHERE email = ? AND active = 1").bind(email).first<Actor>();
  return row ?? null;
}

/** Role walls, enforced at the API (not just the menu). Owner keeps full rights as the safety net. */
export const CAN: Record<string, Role[]> = {
  work: ["sales", "property", "revenue", "owner", "accountant"],
  leads: ["sales", "revenue", "owner"],
  inbox: ["sales", "revenue", "owner"],
  bookings_write: ["sales", "revenue", "owner"],
  bookings_read: ["sales", "property", "revenue", "owner", "accountant"],
  frontdesk: ["property", "owner"],
  // Sales take advances by UPI, bank transfer, card or Airpay link; cash is collected at the property.
  payments: ["sales", "property", "revenue", "owner"],
  other_income: ["property", "revenue", "owner"],
  invoices: ["property", "revenue", "owner", "accountant"],
  tasks: ["property", "owner"],
  petty_expenses: ["property", "owner"],
  bank_expenses: ["owner"],
  transfers: ["property", "owner"],
  approvals: ["revenue", "owner"],
  settlements: ["revenue", "owner"],
  recon: ["revenue", "owner", "accountant"],
  revenue_reports: ["revenue", "owner", "accountant"],
  pnl_reports: ["owner", "accountant"],
  close: ["accountant", "owner"],
  gst: ["accountant", "owner"],
  admin: ["owner"],
  audit: ["owner", "accountant", "revenue"],
  // What an account holds (cash in hand, petty cash, banks). Not the front desk: the person holding the cash counts it
  // without seeing the books' figure (a blind count) and the revenue desk checks the difference.
  balances: ["revenue", "owner", "accountant"],
  // Bank balances, account numbers, OTA terms, gateway fees, bank alerts: the revenue desk, the owner and the CA only.
  // The front desk and sales see the money they record themselves, nothing else.
  finance: ["revenue", "owner", "accountant"],
  ids_capture: ["property", "owner"],
  ids_view: ["sales", "property", "revenue", "owner"],
  form_c: ["sales", "revenue", "owner"],
};

export function allowed(actor: Actor, cap: keyof typeof CAN): boolean {
  return CAN[cap].includes(actor.role);
}
