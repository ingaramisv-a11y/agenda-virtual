# Agenda Pro · Web Push-enabled Swim Class Manager

Agenda Pro is a single-page tool for **Profe Diana** to register swim plans, collect digital class signatures from tutors, and keep a synchronized weekly schedule. The project ships with a Node.js/Express API, SQLite persistence, a vanilla JS frontend, and a service worker that delivers actionable Web Push notifications end to end.

## ✨ Features

- **Secure sign-in** (user `diana`, password `nanitapool2026`) plus Google/Facebook flows restricted to `dmor.nanis@gmail.com`.
- **Plan registration workflow** with push confirmation for tutors (accept/reject before persistence).
- **Class signature loop** so every lesson can be approved remotely; statuses stay in sync across UI + notifications.
- **Weekly “Horario” view** that lists each confirmed alumno per weekday with the scheduled time.
- **Phone registration + push opt-in** gated behind explicit user intent and stored per device.
- **Service worker & Web Push** with deep links, notification actions, and resilient fallbacks.

## 🧱 Tech Stack

| Layer      | Details |
|------------|---------|
| Frontend   | Plain HTML/CSS/JS (no frameworks), service worker, Web Push |
| Backend    | Node.js, Express, web-push, SQLite |
| Auth       | Local credential + social OAuth detours (front-channel) |
| Hosting    | Designed for HTTPS single-origin deployments (e.g., ngrok, Render, Fly) |

## ⚙️ Environment Variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Express port (default `4000`) |
| `FRONTEND_BASE_URL` | Public HTTPS origin (e.g., `https://agenda-virtual-backend-di4k.onrender.com`) |
| `APP_ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins (same as above for prod) |
| `VAPID_PUBLIC_KEY` | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key |
| `VAPID_CONTACT_EMAIL` | `mailto:` contact for Web Push (e.g., `mailto:agenda@example.com`) |
| `DATABASE_URL` (optional) | Absolute path to the SQLite DB file if you don’t want the default `data/agenda.db` |

## 🚀 Getting Started

1. **Install dependencies**

   ```powershell
   cd server
   npm install
   ```

2. **Create the SQLite file**

   The server bootstraps tables automatically. Ensure the `data/` directory is writable or set `DATABASE_URL`.

3. **Set environment variables**

   On Windows PowerShell:

   ```powershell
   $env:FRONTEND_BASE_URL="https://agenda-virtual-backend-di4k.onrender.com"
   $env:APP_ALLOWED_ORIGINS=$env:FRONTEND_BASE_URL
   $env:VAPID_PUBLIC_KEY="<your-public-key>"
   $env:VAPID_PRIVATE_KEY="<your-private-key>"
   $env:VAPID_CONTACT_EMAIL="mailto:dmor.nanis@gmail.com"
   ```

4. **Run the backend**

   ```powershell
   npm start
   ```

   The server statically serves the frontend, so visiting `FRONTEND_BASE_URL` loads the UI and APIs from the same origin.

5. **HTTPS tunnel (dev only)**

   If you’re local, expose the port with ngrok:

   ```powershell
   ngrok http 4000
   ```

   Update `FRONTEND_BASE_URL`, `APP_ALLOWED_ORIGINS`, and the `<meta name="backend-base-url">` in `index.html` to the tunnel URL each session.

## 🔔 Push & Signature Flow

1. **Tutor registers phone** → notification permission asked only after submit → subscription saved via `/push/subscriptions`.
2. **Plan submission** → pending entry stored → `/push/send` notifies tutor with plan summary.
3. **Tutor accepts** via notification or in-app dialog → `/api/planes/pending/:id/decision` confirms → plan becomes active.
4. **Class signature** → Diana triggers request per lesson → tutor receives `Firmar clase` modal → acceptance updates `/api/planes/:planId/clases/:index/firma/decision` and UI shows “Clase firmada por tutor”.

If a notification action fails (expired sub), the backend removes it and returns an error, prompting the tutor to re-register.

## 🔐 Login & Session Persistence

- **Manual login:** user `diana`, password `nanitapool2026`.
- **Social buttons:** open Google/Facebook auth pages; only `dmor.nanis@gmail.com` is accepted.
- Successful logins are stored in `localStorage` so the session auto-restores until cleared.

## 🧪 Testing & Linting

No automated tests are currently bundled. Use manual regression:

- Register phone & push permission on desktop + mobile.
- Submit plan → accept/reject via notification.
- Trigger class signature → accept via notification body and via quick action.
- Ensure Horario updates immediately after plan acceptance.

## 📦 Deployment Notes

- Production must run behind HTTPS with a stable domain.
- Keep backend + frontend on the same origin to satisfy service worker scopes.
- Rotate VAPID keys if compromised and redeploy the frontend so the new public key is fetched.

---

Happy swimming! 🌊