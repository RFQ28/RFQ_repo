# Quote Desk — RFQ to draft quote

RFQs arrive in a distributor's shared inbox as PDFs, spreadsheets, photos and
pasted text. This reads them, matches every line to the distributor's catalogue,
applies that customer's pricing, and hands a rep a draft to review and send.

The product spec is [docs/PRD.md](docs/PRD.md). Section numbers in code comments
(`6.5`, `s8`) point back to it.

## Where the build is

Nothing has been run against a database yet — the migrations are written but not
applied, so treat everything below as "written and type-checked, not yet
exercised against Postgres".

| Phase | Scope | Status |
|---|---|---|
| 1 | Multi-tenant schema, RLS, auth, onboarding, catalogue + price ingestion | **Built** |
| 2 | Graph mailbox, forwarding fallback, classification, dedup, revisions | **Partial** — classifier, queue and storage schema built; Graph connection, webhook and dedup not written |
| 3 | Document parsing, line extraction, matching, embeddings | **Partial** — text and spreadsheet extraction, matching and confidence built; PDF, OCR and Word not; embeddings need a provider |
| 4 | Pricing engine, UOM conversion, stock check, substitutions | **Built** |
| 5 | Review screen | **Built** |
| 6 | PDF, exports, thread reply, correction capture, learning loop | **Partial** — correction capture and the learning loop are wired; PDF, exports and notifications are not |
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
npm run dev         # next dev
npm run build       # production build
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
```

## Known gaps

- **Nothing has been run against a real database.** The migrations and the
  queries against them are unexercised until a Postgres exists to apply them to.
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
