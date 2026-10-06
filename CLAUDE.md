@AGENTS.md

# Polygon Paradise Outreach

Outreach app for a 3D-art studio (the owner is an artist, not a developer). It keeps companies and people, lists, who was emailed and when, campaigns with follow-ups, replies, address checks and AI personal lines. It runs on the office PC (Windows 11) as three background programs: the web app (`OutreachWeb`, port 3000), the background sender/worker (`OutreachWorker`) and Cloudflare's tunnel. All data is one SQLite file, `data/app.db`. All six milestones (M1–M6) are built; work now is follow-ups and changes the owner asks for.

## Read first

- `docs/dev/CONVENTIONS.md` is the rulebook (auth, Server Actions, DB rules, SQLite transactions, UI rules, testing, and the M3–M6, shared-From and own-mailbox rules). Read the matching section before touching that area.
- `docs/dev/README.md` is the developer index, with the design files (`M3`–`M6`, `SHARED-FROM`, `MAIN-DOMAIN`), their `*-code-map.md` files and `research/`.
- `PLAN.md` (Part A owner, Part B technical) and `SPEC.md` (the brief) say what was planned; `README.md` and `docs/setup/*.md` are the owner's manual.
- **The code and its tests win over the design files and PLAN.** Where they disagree, trust the code.
- Next.js here is 16.x: read `node_modules/next/dist/docs/` before using an API you're unsure about (`params`/`searchParams`/`cookies()`/`headers()` are async, middleware is `src/proxy.ts`, `next lint` is gone).

## Stack

Next.js 16.3 (App Router, React 19.3), TypeScript ~6, Tailwind 4 + shadcn (`radix-nova`, in `src/components/ui/`, don't edit), Prisma 7 with the better-sqlite3 adapter (client generated into `src/generated/prisma`), zod 4, vitest 5, Playwright + axe for screen checks, esbuild bundles the worker. Node `>=24.18 <25`. Dependencies are pinned exactly; `vendor/xlsx-0.20.3.tgz` is SheetJS. Windows services use NSSM (`tools/nssm.exe`).

## Layout

- `src/core/**` pure logic, no I/O, no `server-only`; shared by web, worker and tests.
- `src/server/**` database and network code shared by web and worker (no `server-only`, no `next/*`): `db.ts`, `settings.ts`, `jobs.ts`, `mailgun/`, `anthropic/`, `services/*` (the business logic: campaigns, replies, sequences, sending, checks, ai, imports, mail-events…).
- `src/lib/**` web-only helpers (`action.ts`, `auth/`, `request.ts`); may use `server-only` and `next/*`.
- `src/app/(auth)` signed-out pages; `src/app/(app)` signed-in app (activity, ai-lines, campaigns, contacts, dashboard, import, notifications, settings/*, templates); `src/app/api` webhooks, exports, health, jobs, imports.
- `src/components/**` React components by feature.
- `worker/**` background worker (loops in `main.ts`: sending 5 s, event lane 1 s, reconciler 10 min, monitor 1 min; jobs in `worker/jobs/`, periodic tasks in `periodic.ts`). Bundled to `dist/worker.mjs`.
- `scripts/**` Node/PowerShell behind the `.bat` files (setup, start/stop, update, backup/restore, services, fakes); helpers in `scripts/lib/`. `.bat`/`.ps1` stay ASCII with CRLF.
- `prisma/schema.prisma` + `prisma/migrations/`.
- `tests/unit`, `tests/integration`, `tests/fixtures` (fake sites), `tests/fake-mailgun`, `tests/fake-claude`, `tests/playwright`, `tests/setup`.

## Commands

- `npm run check` = `next typegen` + `tsc --noEmit` (web and worker) + `eslint` + full `vitest run`. Run it before calling work done.
- While working: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json`, `npx eslint <paths>`, `npx vitest run <paths>`.
- `npm run build` builds web and worker; `npm run test:e2e` is the Playwright screen checks (needs built, running seeded instances, see `docs/dev/README.md`; not part of `check`).
- Never run `npx playwright install` (Chromium is installed), `npm install` or edit `package.json`, lockfile, `.env`, `next.config.ts`, `tsconfig*`, `schema.prisma` or migrations unless the task is exactly that; report the need instead.

## Rules that are easy to break

- **Never touch real data or the real network.** Don't read, write or test against `data/app.db`, `data/demo.db` or `.env`. Tests create their own DB with `createTestDb()` (`tests/integration/helpers/test-db.ts`) under `data/test/`; manual-check DBs go in `data/manual-check/`. Never call the real Mailgun, Anthropic, Cloudflare or a real website: use `connectFakeMailgun()`, `connectFakeClaude()` and the fixture sites (`.example` origins). Real hosts live only in `src/server/mailgun/base-url.ts` and `src/server/anthropic/base-url.ts`.
- **Auth on every entry point:** pages `requireUser()`/`requireOwner()` first line; Server Actions `requireUserAction()` inside `runAction()`; route handlers `getUserOrNull()` + `isSameOrigin()` for state changes. Only the two Mailgun webhooks are public POSTs.
- **DB writes only through `dbWrite`/`dbTx`** from `@/server/db`. No network call inside a transaction, never nest `dbTx`, keep transactions short, chunk ≤500 rows. Companies and people are soft-deleted (`deletedAt: null` in every query). Log changes with `logActivity`.
- **One door per action:** `markSent()` is the only "sent" writer; replies are processed only by `processInboundMessage`; stops/holds only via `stops.ts` / `holds.ts`; pauses via `pauseSending()`; the sending mode via `loadTeamFrom().replies` / `MailgunContext.replies` (setting `mailgun.replies`: `"own-mailbox"` or app mode). Mailgun always through `getMailgunContext()`.
- Worker-owned state goes through `readTyped`/`updateTyped`; a new job type goes in the `JobType` union and `createJobRegistry()`.
- Times: use `@/core/time/format` with the viewer's `user.timeZone`; sending windows and days use Temporal, never `Date` arithmetic.
- UI: dark only, orange (`bg-primary`) only for the one primary action or selected state, sentence case, empty state on every list, plain friendly wording (short, say what will happen). Works from 360 px to laptop width; use `min-w-0` / `grid-cols-1` for long values. No `crypto.randomUUID()` or bare `navigator.clipboard` (the office address is plain http).
- Owner docs cite each other by step number; `tests/unit/docs/guide-refs.test.ts` fails if a cited step or heading disappears, so renumber guides only together with the texts that cite them.

## Working style

- The owner prefers momentum: proceed on the recommended defaults, use plain language, and still stop after each milestone-sized piece of work to report.
- Current sending setup (owner decision, final): own-mailbox mode. Emails go From `contact@polygonparadise.com` through polygonparadise.com on Mailgun's Free plan, no Reply-To, replies are handled by hand ("They replied"). App mode (per-person or shared-From through `mail.polygonparadise.com`) must keep working exactly as before.
- The real database is still empty and the app folder is still under Pictures; guide 4 step 4 moves it to `C:\Outreach` before going live.

## CodeGraph

If `.codegraph/` exists (it does; it's git-ignored), use `codegraph_explore` before grep/Read to locate or understand code; it returns verbatim, line-numbered source plus call paths in one call.
