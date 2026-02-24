# Bookleaf Tracker Rewrite Plan

## Goals
- Remove sensitive author/tracker data from the public client bundle.
- Split public/consultant/admin surfaces so access rules are enforceable.
- Reduce `public/app.js` blast radius by moving logic into feature modules.
- Keep current workflows (assignments, tickets, callbacks, tracker import) stable during migration.

## Current State (Feb 23, 2026)
- Runtime is a single-page dashboard in `public/app.js`.
- Seed data now loads through `GET /api/data` (server-backed), not public JS bundles.
- Admin full-data access is password-gated server-side (`x-admin-password`).
- Consultant links (`?view=<Consultant>`) load consultant-scoped data.

## Proposed Target Structure
- `src/app/bootstrap.js`: app entry + mode detection
- `src/modes/trackerBootstrap.js`: internal dashboard startup
- `src/modes/bookingBootstrap.js`: public booking/callback page startup
- `src/core/config.js`: constants and environment flags
- `src/core/state.js`: state container + reset helpers
- `src/services/*.js`: API clients (data, Freshdesk, Razorpay, callbacks persistence)
- `src/views/*.js`: rendering and event binding per feature
- `src/utils/*.js`: date/status/csv/shared helpers

## Migration Phases
1. Stabilize Runtime (done in this pass)
- API-backed bootstrap
- Remove public data scripts
- Status normalization fix
- Configurable reassignment cutoff
- Split startup mode scaffold (`tracker` vs `booking`)

2. Extract Pure Helpers
- Move date parsing, status normalization, escaping, and CSV helpers into `src/utils/*`
- Add unit tests around status/date mapping edge cases

3. Extract Data + API Services
- Move bootstrap data loading and admin auth prompt flow into `src/services/dataApi.js`
- Move Freshdesk/Razorpay proxy URL logic into dedicated services

4. Extract Views Incrementally
- `assignments`, `workload`, `tickets`, `performance`, `callbacks`
- Each view owns render + event binding for its DOM subtree

5. Split Surfaces
- Separate public booking page build/entrypoint from internal tracker dashboard
- Remove internal dashboard code from public booking page payload

6. Stronger Security
- Replace shared password prompt with session-based auth (server-issued cookie/token)
- Add consultant-specific access tokens (or authenticated user login)
- Move callbacks persistence off `localStorage`

## Notes / Risks
- Current consultant links remain shareable and scoped but are not strong authentication.
- Callback data is still browser-local (`localStorage`) and not real-time synced.
- `public/app.js` remains the runtime source of truth until extraction is complete.
