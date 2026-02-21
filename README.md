# Agenda Pro · WhatsApp-first Swim Class Manager

Agenda Pro is a single-page control center for **Profe Diana** to register swim plans, request digital class signatures, and keep a synchronized weekly schedule. The backend now delivers all notifications via **Twilio WhatsApp**, which replaces the previous browser push/service-worker flow.

## ✨ Highlights

- **Secure sign-in** (user `diana`, password `nanitapool2026`) plus gated Google/Facebook quick logins for `dmor.nanis@gmail.com`.
- **Plan approval workflow** that notifies tutors on WhatsApp before a plan is persisted.
- **Class signature loop** so every lesson can be confirmed or rejected remotely; statuses stay in sync across UI + WhatsApp.
- **Weekly “Horario” agenda** that shows each alumno per weekday and time slot.
- **WhatsApp contact registration** with automatic E.164 normalization and opt-in tracking.
- **PostgreSQL persistence** for plans, class state, and WhatsApp contact metadata.

## 🧱 Tech Stack

| Layer      | Details |
|------------|---------|
| Frontend   | Plain HTML/CSS/JS (no frameworks), zero service workers, WhatsApp-only notifications |
| Backend    | Node.js (Express), Twilio SDK, PostgreSQL (`pg`) |
| Auth       | Local credential + front-channel “social” prompts (Google/Facebook landing pages) |
| Messaging  | Twilio WhatsApp Business API |

## ⚙️ Environment Variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Express port (default `4000`) |
| `FRONTEND_BASE_URL` | Public HTTPS origin (e.g., `https://agenda-virtual-backend-di4k.onrender.com`) |
| `APP_ALLOWED_ORIGINS` | Comma-separated CORS whitelist (include Render/ngrok origins) |
| `DATABASE_URL` | PostgreSQL connection string (Render-provisioned or self-hosted) |
| `PGSSLMODE` | Optional (`disable` to skip TLS locally; default enables TLS for managed DBs) |
| `TWILIO_ACCOUNT_SID` | WhatsApp-capable Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | API token for the above account |
| `TWILIO_WHATSAPP_NUMBER` | Sender number in `whatsapp:+123456789` format |
| `DEFAULT_WHATSAPP_COUNTRY_CODE` | Optional fallback country code (defaults to `57`) |
| `DEFAULT_TUTOR_NAME` | Optional tutor name used in WhatsApp templates (defaults to `Profe Diana`) |

> The legacy VAPID keys are no longer used now that browser push has been removed.

## 🚀 Getting Started

1. **Install dependencies**

   ```powershell
   cd server
   npm install
   ```

2. **Configure environment** (PowerShell example)

   ```powershell
   $env:FRONTEND_BASE_URL="https://agenda-virtual-backend-di4k.onrender.com"
   $env:APP_ALLOWED_ORIGINS=$env:FRONTEND_BASE_URL
   $env:DATABASE_URL="postgres://user:pass@host:5432/dbname"
   $env:TWILIO_ACCOUNT_SID="ACxxxx"
   $env:TWILIO_AUTH_TOKEN="xxxx"
   $env:TWILIO_WHATSAPP_NUMBER="whatsapp:+573003512411"
   $env:TWILIO_MESSAGING_SERVICE_SID="<your_messaging_service_sid>"
   ```

3. **Run the backend**

   ```powershell
   npm start
   ```

   Express serves the SPA from the repo root, so the same origin handles both API + static assets.

4. **Expose HTTPS locally (optional)**

   ```powershell
   ngrok http 4000
   ```

   Update `FRONTEND_BASE_URL`, `APP_ALLOWED_ORIGINS`, and `<meta name="backend-base-url">` in `index.html` with the tunnel URL when testing on devices.

## 📲 WhatsApp Notification Flow

1. **Tutor registers WhatsApp** via the “Registrar mi WhatsApp” form (no browser permissions). Numbers are normalized to E.164 and saved with `whatsappOptIn=true` through `/api/push/subscriptions`.
2. **Plan submission** stores a pending record. `/api/push/send` now composes a WhatsApp message (title, body, deep link) and sends it through Twilio.
3. **Tutor decision**: tapping the WhatsApp link opens the SPA with the pending plan, where “Aceptar”/“Solicitar cambios” persists the decision via `/api/planes/pending/:id/decision`.
4. **Class signature** requests notify the tutor on WhatsApp with a direct link to `/firmar-clase`, updating `/api/planes/:planId/clases/:index/firma/decision` once they accept or reject.

When Twilio reports a delivery failure (e.g., phone never opted in), the API surfaces a `404` so Diana can remind the tutor to re-register.

## 🔐 Login & Session Persistence

- **Manual login:** user `diana`, password `nanitapool2026`.
- **Social buttons:** open Google/Facebook login pages; only `dmor.nanis@gmail.com` is accepted.
- Sessions persist in `localStorage`, so the dashboard reopens automatically until the storage entry is cleared.

## 🧪 Manual Test Plan

- Register at least one tutor phone through the WhatsApp form (verify it reaches the `/push_subscriptions` table).
- Submit a plan and confirm the WhatsApp message arrives with a working deep link on Android + iOS.
- Trigger a class signature request and complete the flow from the WhatsApp link.
- Renew/delete plans from the dashboard and confirm the schedule view updates immediately.

## 📦 Deployment Notes

- Backend + frontend must share the **same HTTPS origin** so the SPA links match the WhatsApp URLs.
- Keep Twilio credentials in Render/hosting secrets; redeploy if the auth token is rotated.
- If moving to another Twilio number, update `TWILIO_WHATSAPP_NUMBER` and remind tutors to re-register (their metadata stores the normalized number).

---

Happy swimming (now with WhatsApp alerts)! 🌊