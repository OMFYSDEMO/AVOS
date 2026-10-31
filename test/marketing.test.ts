import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { seed, api, ok, sql } from "./helpers";

/** Campaign tagging on leads and marketing spend, and the scorecard that joins them. */
describe("Marketing scorecard", () => {
  beforeAll(seed);
  const KEY = (env as any).HOOK_SECRET as string;
  let month: string;

  it("website UTM and typed campaigns land on the lead; the lead card shows them", async () => {
    const r = await SELF.fetch(`http://x/hooks/leads/website?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "UTM Guest", phone: "9500000001", utm_source: "google", utm_medium: "cpc", utm_campaign: "Diwali 2026", utm_content: "ad-a" }) });
    expect(r.status).toBe(201);
    const web = (await sql("SELECT campaign, utm_source, utm_medium, ad_name, source FROM leads WHERE external_ref IS NULL ORDER BY created_at DESC LIMIT 1"))[0];
    expect(web).toMatchObject({ campaign: "Diwali 2026", utm_source: "google", utm_medium: "cpc", ad_name: "ad-a", source: "website" });
    const typed = await ok("prachi", "POST", "/api/leads", { name: "Typed Guest", phone: "9500000002", source: "whatsapp", campaign: "Diwali 2026" });
    expect((await ok("prachi", "GET", "/api/leads")).leads.find((l: any) => l.id === typed.id).campaign).toBe("Diwali 2026");
    await ok("prachi", "POST", "/api/leads", { name: "Untagged Guest", phone: "9500000003", source: "instagram" });
    month = (await sql("SELECT substr(datetime(created_at, '+330 minutes'),1,7) AS m FROM leads WHERE id = ?", typed.id))[0].m; // the property's month
    // One lead answered fast, converted to a booking.
    await ok("prachi", "POST", `/api/leads/${typed.id}/contacted`);
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Typed Guest", guest_phone: "9500000002", check_in: "2027-03-10", check_out: "2027-03-12", rooms: [{ room_id: "loc_r1", nightly_rate_paise: 600000 }] });
    await sql("UPDATE leads SET status = 'won', booking_id = ? WHERE id = ?", b.booking.id, typed.id);
  });

  it("marketing spend carries a campaign; other categories ignore it", async () => {
    const e = await ok("shaji", "POST", "/api/expenses", { category: "marketing", amount_paise: 1500000, account_id: "acc_bank", description: "Meta ads Oct", campaign: "Diwali 2026", reference: "NEFT-MKT1" });
    expect((await sql("SELECT campaign FROM expenses WHERE id = ?", e.id))[0].campaign).toBe("Diwali 2026");
    await ok("shaji", "POST", "/api/expenses", { category: "marketing", amount_paise: 500000, account_id: "acc_bank", description: "Agency retainer", reference: "NEFT-MKT2" });
    await ok("shaji", "PATCH", `/api/expenses/${e.id}`, { campaign: "Diwali 2026 " });
    expect((await sql("SELECT campaign FROM expenses WHERE id = ?", e.id))[0].campaign).toBe("Diwali 2026");
  });

  it("the scorecard joins leads, bookings, revenue and spend by month, source and campaign", async () => {
    expect((await api("prachi", "GET", "/api/reports/marketing")).status).toBe(403);
    const d = await ok("trupti", "GET", "/api/reports/marketing?months=3");
    expect(d.months).toHaveLength(3); expect(d.months[2]).toBe(month);
    const m = d.per_month.find((x: any) => x.month === month);
    expect(m).toMatchObject({ leads: 3, answered_1h: 1, won: 1, room_nights: 2, revenue_paise: 1200000, spend_paise: 2000000 });
    expect(m.cost_per_lead_paise).toBe(Math.round(2000000 / 3)); expect(m.cost_per_booking_paise).toBe(2000000);
    const wa = d.by_source.find((s: any) => s.source === "whatsapp");
    expect(wa).toMatchObject({ leads: 1, won: 1, revenue_paise: 1200000 });
    const diwali = d.by_campaign.find((c: any) => c.campaign === "Diwali 2026");
    expect(diwali).toMatchObject({ leads: 2, won: 1, revenue_paise: 1200000, spend_paise: 1500000, cost_per_lead_paise: 750000, cost_per_booking_paise: 1500000 });
    expect(diwali.sources.sort()).toEqual(["website", "whatsapp"]);
    const none = d.by_campaign.find((c: any) => c.campaign === "(no campaign)");
    expect(none).toMatchObject({ leads: 1, spend_paise: 500000 });
    expect(d.totals).toMatchObject({ leads: 3, won: 1, spend_paise: 2000000 });
  });
});
