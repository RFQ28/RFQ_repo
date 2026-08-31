# Quote Desk — RFQ to draft quote

RFQs arrive in a distributor's shared inbox as PDFs, spreadsheets, photos and
pasted text. This reads them, matches every line to the distributor's catalogue,
applies that customer's pricing, and hands a rep a draft to review and send.

The product spec is [docs/PRD.md](docs/PRD.md). Section numbers in code comments
(`6.5`, `s8`) point back to it.

## Where the build is

The schema is applied and verified against a live Supabase project. `npm run
verify` checks it end to end: every table reachable, RLS refusing an anonymous
caller, the RPCs exposed and correctly locked, the hand-written types matching
the live columns, and — the part that matters — two real tenants proving that
neither can reach the other.

All migrations through `0008_fix_fail_job.sql` are applied. `npm run
verify:intake` proves the last of them: a job that throws goes back to
`queued` with its error recorded, rather than sitting in `running` forever,
never retried and never reported.

`0009_cron.sql` is separate and optional — it drives the job queue from
Postgres on a schedule. See [docs/SETUP-CRON.md](docs/SETUP-CRON.md).

| Phase | Scope | Status |
|---|---|---|
| 1 | Multi-tenant schema, RLS, auth, onboarding, catalogue + price ingestion | **Built** |
| 2 | Graph mailbox, forwarding fallback, classification, dedup, revisions | **Built** — OAuth, subscription, webhook, renewal with catch-up sweep, dedup, revision detection, customer identification. Needs an Entra app registration to run |
| 3 | Document parsing, line extraction, matching, embeddings | **Partial** — text and spreadsheet extraction, matching and confidence built; PDF, OCR and Word not; embeddings need a provider |
| 4 | Pricing engine, UOM conversion, stock check, substitutions | **Built** |
| 5 | Review screen | **Built** — rebuilt against the Quote Desk redesign: severity-only colour, tabular mono numerals, lines grouped by cause, plus a keyboard-first triage mode |
| 6 | PDF, exports, thread reply, correction capture, learning loop | **Partial** — correction capture and the learning loop are wired, and notifications are recorded as `pending` rows; nothing sends them yet, and PDF, exports and thread reply are not built |
| 7 | Owner weekly summary, stale alert, won/lost, admin tooling | Not started |

## Running it

```bash
npm install
cp .env.example .env.local     # fill in the Supabase values
npm run dev
```

Apply the migrations in `supabase/migrations/` in order, against a Postgres 15+
database with `pgvector` and `pg_trgm` available. On Supabase that means the SQL
editor, `supabase db push`, or the MCP `apply_migration` tool — one file per
migration, in numeric order.

Then regenerate the database types so they come from the live schema rather than
from hand:

```bash
SUPABASE_PROJECT_ID=<ref> npm run db:types
```

`src/lib/db/types.ts` is hand-authored until that runs. Keep it in step with the
migrations in the meantime.

## First tenant

There is no self-serve signup — every distributor is onboarded by hand, because
catalogue and pricing ingestion needs a human eye (PRD §12).

1. Sign in once so an `auth.users` row exists, then promote yourself:
   ```sql
   update public.users set role = 'platform_admin', tenant_id = null
   where email = 'you@vmsa.app';
   ```
2. Go to `/admin`, provision the distributor, and invite their owner.
3. The owner signs in with Microsoft; the invitation is consumed and they land
   in their own tenant.
4. They upload the catalogue export at `/settings/catalogue`.

## Layout

```
supabase/migrations/   schema, RLS, provisioning functions
src/lib/supabase/      client / server / service-role / tenant-scoped clients
src/lib/ingest/        catalogue import: read, map, validate, diff, commit
src/lib/auth/          session and role checks
src/app/(app)/         the rep-facing app
src/app/admin/         VMSA-internal onboarding
tests/                 ingestion and tenant-isolation tests
```

## The two isolation guarantees

A leak between distributors is the failure this product cannot survive, so it is
enforced twice, independently:

- **In the database.** Every tenant-scoped table has RLS policies keyed on the
  signed-in user's tenant (`supabase/migrations/0005_rls.sql`). A browser session
  runs as `authenticated` and cannot see past them, whatever the application asks
  for.
- **In the application.** Background jobs use the service-role key, which
  bypasses RLS by design. They reach the database only through `tenantDb()`
  (`src/lib/supabase/tenant.ts`), which filters every read and stamps every
  write. `tests/tenant-isolation.test.ts` asserts that, including that a
  `tenant_id` supplied by a caller is overwritten rather than trusted.

## Commands

```bash
npm run dev              # next dev
npm run build            # production build
npm test                 # unit tests, no network
npm run test:integration # the draft pipeline against the real database
npm run typecheck        # tsc --noEmit
npm run lint             # eslint

npm run verify           # schema, type drift, and tenant isolation
npm run verify:intake    # webhook and worker edges (needs `npm run dev` running)

node scripts/seed-demo.mjs --reset   # a demo distributor with one RFQ to look at
node scripts/unseed-demo.mjs         # and remove it again
```

`seed-demo.mjs` exists because an empty database makes every screen past
`/login` redirect, so there is nothing to judge the review screen against. It
builds one tenant through the real provisioning path and a 26-line quote whose
lines cover every state the screen can render. Development only — it reads the
service-role key.

## Deploying

Vercel builds this from the repository with no configuration. What it does not
do on its own is run the queue.

**Environment variables.** Everything from `.env.example`, plus one more:

```
CRON_SECRET=<the same value as WORKER_SECRET>
```

Vercel Cron authenticates by sending `Authorization: Bearer $CRON_SECRET`, and
the job endpoints check that bearer against `WORKER_SECRET`. Setting both to
the same value means one secret covers the scheduler and any external caller.

**`NEXT_PUBLIC_APP_URL` and `MS_REDIRECT_URI` both become the deployment's own
domain**, and that redirect URI has to be registered on the Entra app
(Authentication -> Add URI) character for character. Unlike the tunnel used in
development, it never changes again.

**The two cron jobs** are declared in `vercel.json`:

| Path | Schedule | Why |
|---|---|---|
| `/api/jobs/run` | every minute | Drains the queue. This is the latency between an RFQ arriving and a rep seeing a draft. |
| `/api/jobs/schedule` | every 6 hours | Queues the Graph subscription renewal. Graph caps a mail subscription at under three days; without this the mailbox goes quiet on day three and nothing reports it. |

**Vercel's Hobby plan runs cron jobs once a day**, and an RFQ that waits 24
hours for a rep to see it is not a product. So the scheduler does not have to
be Vercel's:

**Supabase `pg_cron` is the recommended driver** — every minute on every plan
including the free tier, and it does not change if the app moves off Vercel.
Apply `supabase/migrations/0009_cron.sql`, put the URL and the worker secret in
Vault, and both jobs run from the database that already holds the queue. Full
setup and the queries to prove it is running:
[docs/SETUP-CRON.md](docs/SETUP-CRON.md).

Anything else that can make an authenticated request on an interval works too —
a GitHub Actions schedule, any cron service — sending `Authorization: Bearer
$WORKER_SECRET`. Both endpoints accept GET and POST, and overlapping calls are
safe: `claim_jobs` locks rows with `SKIP LOCKED`.

## Known gaps

- **Microsoft Graph needs an Entra app registration** — see
  [docs/SETUP-GRAPH.md](docs/SETUP-GRAPH.md). Connecting a live mailbox also
  needs a publicly reachable HTTPS URL, because Graph validates the webhook
  before it will create a subscription and cannot reach localhost. Everything
  else works on localhost. Until it is configured, `/settings/mailbox` says so
  rather than failing obscurely.
- **Classification needs `ANTHROPIC_API_KEY`.** Without it every email is
  surfaced to a rep as a possible RFQ rather than being triaged — deliberately,
  since silently binning a distributor's inbox is the worse failure.
- **The forwarding fallback has no inbound provider.** The address is issued and
  stored, but nothing receives mail at it yet; `/api/inbound` is not written.
- **Semantic matching needs an embedding provider.** Anthropic does not offer an
  embeddings endpoint, so `cataloguePorts` takes an `embed` function as an
  injected port and simply skips vector search when none is supplied. Matching
  still works on corrections, part numbers and trigram search; the vector index
  and RPC are in place waiting for whichever provider gets chosen.
- **PDF, image and Word RFQ attachments are not parsed yet.** They are surfaced
  to the rep as a named unparsed line ("takeoff.pdf is a PDF — open it and add
  these lines by hand") rather than ignored.
- Legacy `.xls` uploads are rejected with a message rather than parsed; `.xlsx`
  and `.csv` are supported.
- `npm audit` reports a moderate advisory in `uuid`, reached through `exceljs`.
  It concerns `uuid` v3/v5/v6 with a caller-supplied buffer, which is not a path
  this code uses. Revisit when exceljs updates.
