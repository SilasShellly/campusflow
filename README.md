# CampusFlow
Setup: `cd server && cp .env.example .env && npm i && npm run setup` (migrates, applies the double-booking constraint in `prisma/constraints.sql`, seeds). Then `npm run dev`, `npm test`.
Client: `cd client && npm i && npm run dev` (proxies /api to :4000).
Email: set `RESEND_API_KEY` (and `EMAIL_FROM`) in server/.env. Without it, emails are logged as failed in EmailLog and in-app notifications still work.
Logins: admin|manager|faculty|student@campus.edu / Campus@123
Built: auth+RBAC, resources, live availability, race-safe bookings, conflict detection + ranked alternatives, approvals with history, QR passes + camera verification (revocable tokens), in-app + email notifications (retry, non-blocking), maintenance blocks (API), analytics + insights, audit log.
Also built: password reset (hashed, single-use, 30-min tokens) + forced change on first login, admin user management, calendar (day/week/month), maintenance screen, admin override API (preview, confirm + reason, notifies affected users, audited), 30-minute reminders, demand heatmap, 60 seeded bookings.
Also built: override button in the conflict screen (admin), waitlist (join + notify oldest eligible user when a slot frees), API tests in server/tests (auth, RBAC, approval/rejection, maintenance, QR valid/invalid/revoked/expired, password reset, override, waitlist, concurrency).
Also built: predictive conflict warning (same slot, previous 8 weeks), natural-language smart match (rule-based parser, no API key), HTML emails with action buttons, admin priority configuration (role -> default booking priority).
Spec items not built: none that I know of. Everything is unrun: expect to fix small errors on first launch.

Last synchronized to GitHub: 2026-10-02.
