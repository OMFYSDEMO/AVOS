# Deploying AVOS to Cloudflare, step by step

Everything runs in one Cloudflare account: a Worker (API + web app + email handler + cron), a D1 database, an R2 bucket, Cloudflare Access for logins and Email Routing for the inbox. Budget about an hour the first time. Steps 1–7 are the minimum for a working pilot; 8–10 switch on the inbox, lead hooks and backups.

The app's hostname is `app.shajianandan.com` (`avos.shajianandan.com` was the pilot address; a leftover Cloudflare Access application still intercepts it while Cloudflare's Access API is down, so it is kept in the config but not used). Replace `YOUR-DOMAIN` below with the domain you use for inbound email (step 8) and `YOUR-TEAM` with the Zero Trust team name you pick in step 6.

---

## 1. Prepare the account

1. Sign in at <https://dash.cloudflare.com>.
2. **Workers & Pages → Plans**: upgrade to **Workers Paid** (US$5/month). Since 1 September 2026, D1 on the free plan fails queries once the daily limits are exceeded, so a live property should not run on it.
3. **Workers & Pages → Overview**: note your `workers.dev` subdomain (it is also usable for a first test before you attach a custom domain).
4. Make sure your domain is an active zone on Cloudflare (**Websites** shows it as *Active*). Email Routing and custom domains need this.

## 2. Install the tooling on your computer

```sh
git clone https://github.com/OMFYSDEMO/AVOS.git avos
cd avos
npm install --legacy-peer-deps
npx wrangler login            # opens a browser, authorises Wrangler against your account
npx wrangler whoami           # confirm the account id shown is yours
```

## 3. Create the database and the bucket

```sh
npx wrangler d1 create avos
npx wrangler r2 bucket create avos-files
```

The bucket `avos-files` and a D1 database already exist in the account (created 19 Oct 2026). The database is still *named* `ivos` (D1 databases cannot be renamed; the name is internal and never shown to users) and `wrangler.jsonc` already carries its id `a34a52c8-60bf-4940-9606-8b64512a7cbb`, so skip the two create commands. If you would rather have the database named `avos`, run `npx wrangler d1 create avos`, put the new id in **both** places in `wrangler.jsonc`, change `database_name` to `avos` in `wrangler.jsonc` and the four `db:*` scripts in `package.json`, and delete the old one with `npx wrangler d1 delete ivos`.

**Already done on 19 Oct 2026:** the schema (`0001_init.sql`) and the pilot seed were applied to the live database and the migration is recorded, so `npm run db:migrate:remote` reports nothing to apply. The five users carry the real login addresses (set 19 Oct 2026; they must match the Access login emails exactly). To change one later, use **Settings & users** as the owner, or directly:

```sh
npx wrangler d1 execute ivos --remote --env production --command "UPDATE users SET email='you@example.com' WHERE id='usr_shaji'"
```

(ids: `usr_shaji` owner, `usr_prachi` sales, `usr_sindhu` property, `usr_trupti` revenue, `usr_ca` accountant.) For a fresh database the commands are `npm run db:migrate:remote` then `npm run db:seed:remote` after editing the emails in `seed/meadows-varkala.sql`.

## 4. First deploy (no logins yet)

**Done on 19 Oct 2026** via GitHub Actions: the Worker `avos` is live at `https://avos.shajianandan.workers.dev` (version `d3b1d06c`). Every later push to the working branch redeploys automatically.

Two ways. **A** needs nothing on your computer and is what later deploys use too.

**A. From GitHub Actions (recommended).** The repository carries `.github/workflows/deploy.yml`, which runs the tests, builds the web app, applies any new D1 migrations and deploys the Worker on every push to the working branch.

1. Cloudflare dashboard → profile icon (top right) → **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template**. Under *Permissions* add two rows: **Account · D1 · Edit** and **Account · Workers R2 Storage · Edit**. Under *Account Resources* pick your account. Create it and copy the token (shown once).
2. **Workers & Pages → Overview**: copy the **Account ID** from the right-hand column.
3. GitHub → the `AVOS` repository → **Settings → Secrets and variables → Actions → New repository secret**, twice: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. GitHub → **Actions → Deploy → Run workflow** (or just push a commit). The run takes about two minutes; the last step prints the `workers.dev` URL.

**B. From your computer.**

```sh
npm run deploy
```

This builds the web app and deploys the Worker as `avos` to `https://avos.<your-subdomain>.workers.dev`. In production the API refuses every request until Access is in front of it (step 6), so opening the URL now shows "not signed in". That is expected.

## 5. Attach your own hostname

**Done on 19 Oct 2026:** the app answers on `https://app.shajianandan.com`. The hostname is declared in `wrangler.jsonc` (`env.production.routes`) so every deploy keeps it, and the post-deploy smoke test runs against it.

1. **Workers & Pages → avos → Settings → Domains & Routes → Add → Custom Domain**.
2. Enter the hostname and select **Add domain**. Cloudflare creates the DNS record and certificate.
3. Optional but recommended: in the same panel disable the `workers.dev` route and Preview URLs so the app is reachable only on your domain. (Keep `workers.dev` on while the deploy workflow's first smoke test uses it.)
4. **Zone security must let automated callers through.** The first live test on 19 Oct 2026 was answered with a Cloudflare "Just a moment…" challenge page. In the `shajianandan.com` zone go to **Security → Settings**: set **Security level** to *Medium* (not *I'm Under Attack*) and turn **Bot Fight Mode** off, or add a **WAF custom rule** (Security → WAF → Custom rules) with expression `http.host eq "avos.shajianandan.com"` and action **Skip** → all remaining custom rules and *Bot Fight Mode / Super Bot Fight Mode* where offered. Without this, the Meta webhook, the website form and the deploy smoke test are all challenged. Browser users are unaffected either way.

## 6. Logins

**Since 19 Oct 2026 AVOS has its own sign-in screen** (email + password): sessions in D1 behind a secure cookie, lockout after five failed attempts, forced password change after a temporary password, forgot-password links, sign-out everywhere. Cloudflare Access is no longer required, and the Worker still accepts Access logins while both are on.

**How people get their password**

- The owner opens **Settings & users** and either **Set password** (a temporary one, which the person must change at first sign-in) or **Password link** (a one-time link valid 72 hours, sent by WhatsApp or mail).
- **Forgot password?** on the sign-in screen emails a reset link once Email Sending is configured (`send_email` binding and `EMAIL_FROM` in `wrangler.jsonc`, domain onboarded under Compute → Email Service). Until then it tells the person to ask the owner for a link.

**Switching Access off** (so the AVOS sign-in screen is what people see): Zero Trust → Access controls → Applications → the `app.shajianandan.com` application → Delete. Leaving `ACCESS_TEAM_DOMAIN` set is harmless. If you prefer both layers, keep the application: Access signs people in first, and AVOS recognises the Access identity without asking for a password.

### 6a. Cloudflare Access (optional second layer, the original step 6)

**Done on 19 Oct 2026:** the account's existing Zero Trust team is `kshetrom` (team domain `kshetrom.cloudflareaccess.com`) and an Access application protects `app.shajianandan.com`. The Worker pins that team domain in `env.production.vars.ACCESS_TEAM_DOMAIN`; `ACCESS_AUD` is optional and blank. Still to do when the lead hooks go live (step 9): a second self-hosted application on `app.shajianandan.com` with paths `hooks` and `api/health` and a **Bypass** policy for Everyone, otherwise webhooks are sent to the login page.

Access gives you Google / one-time-PIN logins for up to 50 users at no cost, and the Worker trusts only the signed token Access adds to each request.

1. **Zero Trust** (left menu). The first visit asks you to choose a **team name**: pick something like `meadows`. Your team domain is then `meadows.cloudflareaccess.com`. Choose the Free plan.
2. **Zero Trust → Settings → Authentication → Login methods**: **One-time PIN** is on by default. Add **Google** if your team uses Google accounts (follow the on-screen OAuth steps).
3. **Zero Trust → Access controls → Applications → Add an application → Self-hosted**.
   - Application name: `AVOS`
   - **Add public hostname**: `avos.YOUR-DOMAIN` (leave path empty)
   - Session duration: `24 hours` is sensible for a front desk tablet.
4. **Add a policy**: name `Team`, action **Allow**, include **Emails** and list the five login addresses (these are already in the live `users` table):
   - `shajianandan@gmail.com` (owner)
   - `bookings@meadowsvarkala.com` (sales)
   - `meadowsvarkala@gmail.com` (property manager)
   - `trupti@truvic.co.in` (revenue)
   - `shubham.kandalkar@gmail.com` (CA)

   Save the application.
5. Open the application again: the **Overview** tab shows the **Application Audience (AUD) Tag**. Copy it.
6. **Bypass for the lead hooks.** Website and Meta webhooks cannot log in, so add a second application:
   **Add an application → Self-hosted**, name `AVOS hooks`, public hostname `avos.YOUR-DOMAIN` with path `hooks`, policy action **Bypass**, include **Everyone**. (Those endpoints are protected by `HOOK_SECRET` instead, step 9.)
7. Back in the repo, edit `wrangler.jsonc` under `env.production.vars`:
   - `ACCESS_TEAM_DOMAIN`: `meadows.cloudflareaccess.com` (no `https://`)
   - `ACCESS_AUD`: the AUD tag you copied
8. Redeploy:

```sh
npm run deploy
```

9. Open `https://avos.YOUR-DOMAIN`. Access shows the login page; sign in with one of the seeded emails. You land in AVOS as that role. If you see "no active user for …", the login email does not match the `users` table: fix the email under **Settings & users** (as the owner) or in the seed.

Why a hostname application and not the one-click "Protect this Worker"? The one-click option protects every route on the Worker, including `/hooks/*`, which would block the lead webhooks.

## 7. Verify the pilot

1. As the owner: **Settings & users** → check the team list, the tariff card and the channel terms (Booking.com commission, payment fee).
2. As sales: create a lead, quote, hold, win it → it appears in **Availability**.
3. As property: check in, record a UPI payment, check out, issue the invoice. The invoice says *GST not applicable* until step 10.
4. As revenue: **Approvals** is empty (on-tariff bookings approve themselves). Paste two bank lines into **Smart Reconcile**.
5. **Workers & Pages → avos → Logs** streams errors if anything misbehaves.

## 8. Email Routing: STAAH, SwiftBook and Airpay mail into the inbox

Once mail reaches the Worker, the inbox runs itself: a STAAH reservation books the stay, a STAAH cancellation releases the rooms, a SwiftBook confirmation books the direct stay, and an Airpay "transaction successful" email records the payment (with its gateway fee) against the SwiftBook itinerary it belongs to. Automation only acts when every fact lines up: the parser is confident, the channel exists under **Settings & users → Channels**, a room of the named type is free for every night, and (for payments) exactly one open stay matches the order id. Anything else stays on the **Inbox — bookings** screen as a card that says why it waited, and a person approves it the usual way. Everything automation does is audited as `inbox-automation` and notifies the sales and property desks. The owner can switch it off under **Settings & users → Property & GST → Inbox automation**.

1. **Point Email Routing at the Worker.** Either run the GitHub Action **Set up Email Routing** (Actions tab → *Set up Email Routing* → address `inbox@YOUR-DOMAIN`, confirm `apply`) — it enables Email Routing on the zone and adds the rule `inbox@YOUR-DOMAIN → Worker avos`, refusing to touch a domain that already has other mail servers — or do the same by hand: **Compute → Email Service → Email Routing → Onboard domain**, accept the MX/SPF/DKIM records, then **Routing Rules → Create routing rule**, custom address `inbox`, action **Send to a Worker**, Worker `avos`. If the domain already receives mail elsewhere (Google Workspace), use a subdomain instead, e.g. `inbox@mail.YOUR-DOMAIN`.
2. **Send the notifications there.** Best: in STAAH (Setup → Notifications), SwiftBook (Settings → Email notifications) and the Airpay merchant panel, add `inbox@YOUR-DOMAIN` as a notification recipient, so the mail arrives first-hand. Until then, in the Gmail mailbox that receives them today, add a filter *from staah.com OR swiftbook OR airpay → forward to `inbox@YOUR-DOMAIN`*. Gmail asks you to confirm the forwarding address: the confirmation email appears in AVOS **Inbox** as an "unknown" item; open it there, copy the code, finish the Gmail confirmation.
3. **Test with a real email.** Forward one STAAH reservation for an upcoming stay and one Airpay receipt. The reservation appears under **Inbox — bookings → Done** as *auto* if the room was free, otherwise under *Needs a person* with the reason (an old email for a past stay always waits there: automation never books the past). The payment appears under **Payments → Recent** (matched) or **Payments → From inbox** (no matching stay).

The parsers were written against the common STAAH, SwiftBook and Airpay templates; every email's raw `.eml` is kept in R2 (`inbox/…`), so when a template differs, nothing is lost: the card shows what was read, a person corrects it, and the parser can be tuned from the stored sample.

**Bank transaction alerts.** IDFC FIRST sends "Transaction alert from IDFC FIRST Bank" to bookings@meadowsvarkala.com. Forward them to the inbox address (Gmail → Settings → Filters → from `transaction.alerts@idfcfirstbank.com` → Forward to inbox@shajianandan.com; confirm the forwarding address once). Each alert becomes a statement line on Smart Reconcile for the account whose last digits match (set them under Settings & users → Bank & cash accounts). A credit from AIRPAY PAYMENT SERVICES is settled on the spot: a transfer from Airpay clearing into that bank, matched to the line, with the revenue desk told. The balance the bank reports is shown under Cash position on the Dashboard next to AVOS's own figure.

The STAAH booking engine's own confirmations for website bookings (from noreply@mybookingsite.io, subject "(Confirmed) … Reservation No: …") are read as Direct bookings; "(Cancelled)" releases the stay. Any email the reader cannot place still shows a "Book by hand in Reservations" button on its card.

## 9. Lead hooks (CRM, website form, Instagram and Facebook lead forms)

**If a CRM such as NeoDove already receives Instagram, Facebook, WhatsApp and website enquiries, use it as the only front door** and skip the Meta app below: wiring both would open every lead twice. In the CRM's admin portal → Integrations → Webhook, add a webhook on *lead created* and *lead updated* (or on the stage you consider a real enquiry, such as "Interested" or "Quote requested") with method POST and this URL:

```
https://app.shajianandan.com/hooks/leads/neodove?key=<HOOK_SECRET>
```

The payload can be the CRM's own shape. AVOS reads the usual names for name, phone, email, source, campaign, lead id, stage, agent, remarks, check-in, check-out and rooms, keeps every delivery verbatim, and never opens a second card for the same CRM lead id or for the same phone within 30 days (a later delivery adds the stage to the existing card instead). To see the last 20 deliveries and what became of them, open `https://app.shajianandan.com/hooks/leads/crm/recent?key=<HOOK_SECRET>` in a browser; send the owner's developer that page if a field is not being read. Add `&source=whatsapp` (or instagram, facebook, website) to the URL for a CRM that does not send the source itself.

Every enquiry becomes a lead card assigned to the sales desk, with a notification, and WhatsApp quotes go out from the card. Three repository secrets drive it (GitHub → Settings → Secrets and variables → Actions → New repository secret); the deploy pushes each one to the Worker.

| Secret | What it is |
|---|---|
| `HOOK_SECRET` | Any long random string. It is the `?key=` in the hook URLs and the verify token for the Meta webhook. |
| `META_APP_SECRET` | Meta app → App settings → Basic → App secret. Every webhook delivery is checked against it. |
| `META_PAGE_TOKEN` | A long-lived Page access token with `leads_retrieval`, `pages_show_list`, `pages_manage_metadata`. The answers to a lead form are fetched with it. |

1. **Website form.** Point the site's enquiry form at `https://app.shajianandan.com/hooks/leads/website?key=<HOOK_SECRET>` (POST, JSON or form-encoded) with fields `name`, `phone`, `email`, `check_in`, `check_out`, `rooms`, `adults`, `message`. Only `name` is required. The response is `201 {"id": …}`. For the marketing scorecard, also pass the UTM values the page was opened with: `utm_campaign` (or `campaign`), `utm_source`, `utm_medium`, `utm_content` (the ad). The site's JavaScript reads them from the landing URL and keeps them in a cookie or local storage until the form is sent.
2. **Meta app.** At https://developers.facebook.com create an app of type *Business*, add the **Webhooks** and **Facebook Login for Business** products, and connect the Meadows Facebook Page (the Instagram professional account must be linked to that Page).
3. **Webhook.** Webhooks → Page → Subscribe to `leadgen`. Callback URL `https://app.shajianandan.com/hooks/leads/meta?key=<HOOK_SECRET>`, verify token `<HOOK_SECRET>`. The handshake succeeds only after `HOOK_SECRET` has been deployed.
4. **Page token.** Graph API Explorer → choose the app → generate a User token with `leads_retrieval`, `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement` → exchange for a long-lived token → `GET /me/accounts` gives the Page token. Save it as `META_PAGE_TOKEN`. Then subscribe the Page to the app: `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen` with that token.
5. **App Review.** Meta sends real leads only once `leads_retrieval` is approved in App Review (a short screencast of the lead arriving as a card in AVOS is what they ask for). Until then, the Lead Ads Testing Tool at https://developers.facebook.com/tools/lead-ads-testing creates test leads that go through the whole path.
6. **Form questions.** Standard questions (full name, email, phone) map themselves. Add custom questions named `check_in`, `check_out`, `rooms`, `adults`, `message` and they land in the right fields; any other question is appended to the notes.

A lead whose answers could not be fetched (token expired, review pending) still becomes a card carrying the Meta lead id, so nothing is lost.

## 10. GST, TCS/TDS and backups

1. **GSTIN**: when the registration arrives, the owner enters it under **Settings & users → Property & GST**. From that moment invoices carry GST per room-night and the GST filing sheet is live. Until then the sheet is empty and invoices say *GST not applicable*.
2. **TCS / TDS**: when the first Booking.com statement shows deductions, enter the percentages on the channel under **Settings & users → Channels** (basis points: 50 = 0.50 %). The payout formula and the recoverable credits pick them up immediately.
3. **Backups**: D1 keeps 30 days of point-in-time history (**Workers & Pages → D1 → avos → Time Travel**). Month-close packs are written to R2 under `packs/` and never overwritten. For an extra off-platform copy, run monthly:

```sh
npx wrangler d1 export ivos --remote --env production --output avos-$(date +%F).sql
```

## 11. Updating the app later

```sh
git pull
npm install --legacy-peer-deps
npm run db:migrate:remote      # applies any new migrations
npm run deploy
```

Wrangler keeps previous versions; **Workers & Pages → avos → Deployments → Rollback** restores the last one in seconds.

## Troubleshooting

| Symptom | Cause | Fix |
|--------|-------|-----|
| `not signed in` on the custom domain | Access application not covering the hostname, or `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` wrong | Check the AUD tag on the Access app's Overview; redeploy |
| `no active user for x@y` | Login email not in `users` | Owner adds it under Settings & users |
| Website form gets `bad hook key` | Missing or wrong `?key=` | Match it to `HOOK_SECRET` |
| Emails not arriving in Inbox | Routing rule disabled or forwarding unconfirmed | Email Routing → Routing Rules status; finish the Gmail confirmation |
| `period … is locked` (HTTP 423) | Writing a dated record into a locked month | The CA unlocks it; re-lock makes a revised pack |
| D1 "exceeded free tier" errors | Still on Workers Free | Upgrade to Workers Paid (step 1) |
