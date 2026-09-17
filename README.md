# ORPA — Backend-Connected Version

This is the ORPA grading app **with a central server**, so the owner can:

- keep all teacher accounts in one place (not just on each phone),
- **suspend or delete** any account (which instantly signs that person out and blocks login),
- **force sign-out** a single active session on demand, and
- watch a **live “who’s online” dashboard** that updates in real time.

Teacher grading data is now stored against each authenticated teacher account in
PostgreSQL when `DATABASE_URL` is configured. A localStorage copy is retained for
fast/offline entry, and existing browser-only data is migrated to the server the
first time that teacher signs in after this update.

---

## What’s inside

```
ORPA-Server/
  server.js               Node/Express + Socket.IO server (API + live sessions)
  lib/db.js               PostgreSQL + JSON fallback datastore
  package.json            Dependencies
  .env.example            Copy to .env and set your secrets
  public/                 The ORPA web app (served by the server)
    index.html            Main app
    app.js                App logic (grading, reports, KPIs)
    auth-backend.js       Connects the app to the server (login/register/sessions)
    admin.html            Owner-only admin dashboard
    styles.css, sw.js, manifest.webmanifest, icons, brand image
```

---

## Run it locally

1. Install [Node.js](https://nodejs.org) 16 or newer.
2. In this folder run:
   ```
   npm install
   npm start
   ```
3. Open <http://localhost:8000> — register teachers and use the app.
4. Owner dashboard: sign in with the owner account, then open the user menu
   (top-right) → **🛡️ Admin Dashboard**, or go straight to
   <http://localhost:8000/admin.html>.

### Default owner account
On first run an owner account is created automatically:

- **Email:** value of `OWNER_EMAIL` (default `owner@orpa.local`)
- **Password:** value of `OWNER_PASSWORD` (default `changeme123`)

**Change these** by setting `OWNER_EMAIL` / `OWNER_PASSWORD` before the first run
(or change the password later from the app’s Profile page).

---

## Deploy so Android teachers can use it

Host this server on any Node-friendly platform (Render, Railway, Fly.io, a VPS,
etc.). Set the environment variables from `.env.example`, then share the public
`https://…` URL. Teachers open it in Chrome and can **Add to Home screen** to
install it like an app (the PWA setup is already included).

> **Run it over HTTPS in production.** Logins and tokens must not travel over
> plain HTTP. Most hosts give you HTTPS automatically.

---

## How the owner controls work

| Action            | Effect                                                                 |
|-------------------|------------------------------------------------------------------------|
| **Suspend**       | Blocks future logins **and** ends the user’s current session at once.  |
| **Activate**      | Re-enables a suspended account.                                        |
| **Force sign-out**| Ends the user’s active session now (they must log in again).           |
| **Delete**        | Permanently removes the account.                                       |

Suspend / force-sign-out work by revoking the user’s token **and** disconnecting
their live socket, so the effect is immediate — no waiting for a token to expire.
The owner account itself cannot be suspended or deleted through the panel.

When suspending, the owner can add an **optional reason**, which is included in
the email the teacher receives (see below).

---

## Email alerts

Whenever the owner suspends, reactivates, force-signs-out, or removes a teacher,
ORPA automatically emails that teacher a clear, branded notice. Suspension
and reactivation messages are written as a matching pair so the teacher always
knows the current state of their account.

**No email setup? It still works.** If you don’t configure SMTP, emails are not
actually sent — instead each one is printed to the server console and saved as
`.html` / `.txt` files under `data/emails/`, so you can see exactly what would
have gone out during a pilot.

**To send real emails**, set the `EMAIL_SMTP_*` variables in `.env` (see
`.env.example`). For Gmail, create an App Password and use:

```
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=you@gmail.com
EMAIL_SMTP_PASS=your-16-char-app-password
EMAIL_FROM=ORPA <no-reply@yourschool.com>
```

Email sending is *fire-and-forget*: if the mail server is slow or unreachable,
the admin action still succeeds instantly and the failure is only logged — a
broken mailbox can never block suspensions or logins.

---

## Security notes

- Admin actions are enforced **on the server** (owner role required), not just
  hidden in the UI.
- Passwords are stored hashed with bcrypt; the plain password is never saved.
- Set a strong, unique `JWT_SECRET` and `OWNER_PASSWORD` in production.
- **Always run behind HTTPS in production.** Login tokens and passwords travel
  over the network, so a TLS certificate (e.g. via your host or a reverse proxy)
  is required to keep them safe.
- Keep SMTP credentials (`EMAIL_SMTP_PASS`) only in `.env` / host environment
  variables — never commit them.
- The JSON datastore is fine for a pilot. For large-scale use, move to a real
  database (PostgreSQL/SQLite) — `lib/db.js` is the only file to swap out.

---

## Test

An automated end-to-end check of the whole flow (register, login, suspend,
force-logout, delete, permission guards) is included:

```
node test.js
```

## Owner-controlled teacher login approval

Teacher accounts now use a two-step owner approval flow:

1. Teacher submits email + password.
2. Server verifies the password but does **not** issue a session token.
3. A 5-minute login request appears in the Owner Admin dashboard.
4. The owner approves or denies the request.
5. On approval, the server generates a random 6-character one-time code.
6. The owner gives the code to the teacher.
7. Teacher enters the code; the server verifies its hash and issues the JWT.
8. The code expires after 5 minutes, allows at most 5 attempts, and is invalidated after one successful use.

The zero-cost notification path is the Owner Admin dashboard's live Socket.IO event plus the browser Notification API. Optional email alerts can be enabled with the existing SMTP settings. No paid SMS/OTP service is required.

WhatsApp automation is deliberately not required for core security because an official WhatsApp Business messaging integration is a separate service with its own account/usage requirements. Do not use unofficial WhatsApp Web automation for authentication.


## Render deployment

Create a **Web Service** from this GitHub repository. Use:

- Build Command: `npm install`
- Start Command: `npm start`
- Add `DATABASE_URL` from your Render Postgres instance.
- Add a strong `JWT_SECRET`.
- Add `OWNER_EMAIL` and a strong `OWNER_PASSWORD`.
- Do not upload `.env` or commit secrets.

The server listens on `process.env.PORT` and binds to `0.0.0.0`, so it is suitable for Render.

## Deploying an update to an existing Render service

If the site is already live on Render, **do not create a second Web Service**. Update
the same GitHub repository that the live Render service already uses. Render will
create a new deployment from the pushed commit.

1. Back up the current GitHub repository (or create a branch such as `backup-before-persistence-fix`).
2. Replace the server project files with this version.
3. Commit and push to the branch configured as the Render service's **Build & Deploy > Branch**.
4. In Render, open the existing Web Service and confirm:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - `DATABASE_URL` points to the existing Render PostgreSQL database.
   - `JWT_SECRET`, `OWNER_EMAIL`, and `OWNER_PASSWORD` are set as Render environment variables.
5. Deploy the commit. The server automatically creates the `user_data` table if it does not exist.

### Important data-safety rule

Do **not** delete or recreate the existing Render PostgreSQL database. The new
`user_data` table is additive. Existing teacher accounts remain in `users`, and
existing login-request records remain in `login_requests`.

### Existing teacher data migration

Before this fix, marks/classes were stored only in the browser's localStorage.
After deployment, when an existing teacher logs in on the browser where that data
exists, ORPA checks the server. If no server copy exists for that account, it
migrates the local copy into PostgreSQL. On subsequent logins/devices, the server
copy is loaded.

For this reason, ask each existing teacher to log in once from the device/browser
that currently contains their marks **before clearing browser data or uninstalling
the PWA**.


## ORPA rebrand and archive workflow

The application is rebranded as **ORPA — ORPA Executes**. Teacher account data and the
owner-controlled authorization flow remain server-backed.

### Archive / Fetch

The main Entry screen now has **ARCHIVE** and **FETCH** controls.

- **ARCHIVE** saves the currently processed grade/assessment, including learner ADM
  numbers, names, raw marks, maximum marks, computed percentages, performance levels,
  grades, points and positions, to the authenticated teacher's server archive.
- The current entry sheet is cleared **only after PostgreSQL/server confirmation**.
- Exam name, term and year are reset for the fresh assessment; the teacher's school
  profile is retained.
- **FETCH** opens a search window. A teacher can search archived records by learner
  **Name or ADM No.**, open the matching archived assessment and inspect the saved
  results.
- Archives are private to the authenticated teacher account.

### New account approval

New teacher registrations are created with `pending` status. The owner receives an
email notification when SMTP is configured, and the account also appears in the Owner
Admin dashboard. The owner activates the account before the teacher can sign in.
Existing active accounts are not changed by this migration.

### Email uniqueness

Email addresses are normalized to lowercase and the PostgreSQL `users.email` field is
unique. The registration route rejects an existing email with HTTP 409, so one email
cannot be registered as two accounts.

### Render migration

For a new Render account, create a new Web Service from this repository and a new
PostgreSQL database. Set `DATABASE_URL`, `JWT_SECRET`, `OWNER_EMAIL`, and
`OWNER_PASSWORD` as Render environment variables. Never commit `.env` or credentials.


## Official ORPA visual identity
The project uses the supplied ORPA artwork as the official visual identity. `public/ORPA-desired-design.png` is the full brand artwork used on authentication/visual surfaces, while `public/ORPA-brand.png` and the PWA icon files use the circular-arrow ORPA mark extracted from that artwork. Brand palette is deep navy, electric blue and cyan.
