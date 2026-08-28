# PRD — RFQ-to-Draft-Quote Automation for Electrical Distributors

**Product owner:** David (VMSA)
**Version:** 1.0 — pilot build
**Status:** Ready for implementation

---

## 1. What this is

Independent electrical supply distributors receive Requests for Quote (RFQs) from electrical contractors by email. Each RFQ is a messy list of materials — a PDF, an Excel sheet, a photo, or plain text in the email body. An inside sales rep manually matches every line to a real product in the distributor's catalogue, applies the right price for that customer, checks stock, and builds a quote.

An 80-line RFQ can take half a day. Quotes go out late. Contractors buy from whoever answers first.

This system reads the RFQ automatically, matches each line to a catalogue product, applies that customer's pricing, and produces a draft quote. A rep reviews it, fixes what's flagged, sets margin, and sends.

**We are not replacing the rep.** He still owns pricing and the customer relationship. We remove the lookup work in the middle.

**Target customer:** US independent electrical supply distributors, $8M–$40M annual revenue, Midwest and Northeast. No IT department. Running an older ERP (Epicor Eclipse, Prophet 21, DDI, Infor).

---

## 2. Pilot goals

Build for **one design partner**. Use their real inbox, real catalogue, real pricing, real RFQs. Do not build for a hypothetical general customer.

**Success at end of pilot:**

| Metric | Target |
|---|---|
| Time from RFQ arrival to sent quote | Under 30 minutes (from 3–4 hours) |
| Rep time spent per quote | Under 15 minutes |
| Lines matched correctly without correction | 85%+ by week 4 |
| RFQs processed without a human touching intake | 100% |
| Rep uses it for every RFQ, unprompted, by week 3 | Yes/no |

That last one is the real test. If reps go around it, nothing else matters.

---

## 3. Users

**Inside sales rep** — primary user. Lives in Outlook all day. Reviews and sends quotes. Wants speed and wants to trust the output.

**Distributor owner / sales manager** — buyer. Doesn't use it daily. Wants proof the machine is running and that nothing is falling through the cracks.

**VMSA admin (David)** — internal. Onboards tenants, uploads catalogues, monitors match quality, tunes the system.

---

## 4. Scope

### In scope for v1

- Automatic email intake from a shared quotes inbox
- RFQ vs non-RFQ classification
- Document parsing (PDF, Excel, CSV, email body, images via OCR)
- Line-item matching against the distributor's catalogue
- Customer-specific pricing rules
- Unit-of-measure conversion
- Substitution suggestions
- Side-by-side review screen with confidence flagging
- Correction capture and learning loop
- Branded quote PDF output
- Notification into email/Teams
- Owner weekly summary + stale-RFQ alert
- Won/lost tracking
- Multi-tenant architecture with strict data isolation

### Explicitly out of scope for v1

- Live ERP integration (catalogue comes in as periodic export; finished quote goes back via file export or copy-paste)
- EDI and customer portal intake
- Phone RFQs
- Mobile editing (read-only mobile view only)
- Analytics beyond the weekly summary
- Outlook add-in or any installed software
- Self-serve signup

**Be upfront with the design partner that ERP integration is phase two and priced separately.** Do not let them discover it.

---

## 5. Core flow

```
Contractor sends RFQ to quotes@distributor.com
        ↓
System watches mailbox via Microsoft Graph (real-time)
        ↓
Classifier: is this an RFQ? → if no, ignore silently
        ↓
Extract attachments + body → parse into line items
        ↓
Check: is this a revision of an existing RFQ? → if yes, update existing draft
        ↓
Match each line to catalogue product (confidence scored)
        ↓
Apply customer pricing rules + UOM conversion + stock check
        ↓
Generate draft quote
        ↓
Notify rep (reply in thread + Teams message) with link
        ↓
Rep opens review screen → fixes flagged lines → sets margin → approves
        ↓
Corrections written back to learning store
        ↓
Branded PDF generated → rep sends → quote marked sent
        ↓
Rep later marks won or lost
```

---

## 6. Functional requirements

### 6.1 Email intake

Primary method: **Microsoft Graph API** subscription to the shared mailbox. Owner authorizes once via OAuth. System receives webhook on new mail, near real-time.

Fallback method: **server-side forwarding rule.** Their IT sets one rule copying the quotes inbox to a system-generated address per tenant (e.g. `tenant-abc@inbound.vmsa.app`). Use this when the owner won't grant mailbox access.

Requirements:
- No manual forwarding by any human, ever
- Graph subscriptions expire — auto-renew before expiry, alert admin on failure
- Store the raw original email and all attachments permanently, linked to the RFQ
- Deduplicate: same message ID, or same sender + same attachment hash within 24h, is one RFQ
- Handle mailbox disconnection gracefully — queue, retry, alert admin, never lose mail

### 6.2 RFQ classification

The shared inbox is full of noise: supplier newsletters, order confirmations, delivery questions, invoice queries, spam, replies on old threads.

Classify each incoming email as:
- **New RFQ** → process
- **Revision to existing RFQ** → link to parent, update draft
- **Not an RFQ** → ignore, log, do not notify

Getting this wrong in either direction is costly. False positives flood reps with junk drafts and destroy trust in week one. False negatives lose deals.

Requirements:
- Log every classification decision with reasoning, for tuning
- Admin screen to review misclassifications and correct them
- Conservative threshold at launch: when genuinely unsure, flag to the rep as "possible RFQ" rather than silently dropping
- Revision detection uses email thread ID first, then sender + subject similarity

### 6.3 Document parsing

Input formats to support:
- PDF (text-based and scanned)
- Excel (.xlsx, .xls) and CSV
- Plain text in email body
- Images (JPG, PNG) — photos of handwritten or printed lists
- Word documents

Output: a normalized list of line items, each with raw description, quantity, unit as written, and any manufacturer part number or brand mentioned.

Requirements:
- Preserve the original line order and the original raw text of every line
- Never silently drop a line — if a line can't be parsed, surface it as unparsed for the rep to handle manually
- Handle multi-page and multi-table documents
- Handle headers, footers, notes, and job details mixed in with line items
- Extract RFQ-level metadata where present: job name, contractor name, due date, delivery address

### 6.4 Catalogue matching

Match each parsed line to a product in the tenant's catalogue.

Match signals, in rough priority:
1. Exact manufacturer part number
2. Distributor's own SKU
3. UPC
4. Semantic match on description (vector similarity)
5. Prior corrections for this tenant and this customer (highest weight — see 6.8)

Every match carries a **confidence score**:

| Band | Meaning | UI treatment |
|---|---|---|
| High | Exact part number, or a previously confirmed correction | Sits quiet, collapsed |
| Medium | Strong description match, no part number | Visible but not flagged |
| Low | Weak or ambiguous match | Flagged at top, alternatives shown |
| No match | Nothing found | Flagged at top, substitution suggestions shown |

Requirements:
- Always return the top 3–5 alternatives for any line below high confidence
- Confidence bands must be tunable per tenant without a code change
- Match reasoning must be inspectable by admin for every line

### 6.5 Customer-specific pricing

**This is the requirement most likely to sink the product if done badly.** Distributors do not have one price. Contractor A pays list minus 22%. Contractor B pays list minus 30%. A third has a manufacturer special on one product line for one specific job.

If the draft quote prices everything at list, the rep redoes every line and the system is worthless.

Requirements:
- Ingest the tenant's customer price rules alongside the catalogue
- Support: list price, customer-level discount %, customer + product-category discount, customer + specific-product price, manufacturer contract pricing, job-specific pricing
- Identify the contractor from the sending email domain or address; where ambiguous, ask the rep once and remember
- Where no rule is found, use list and clearly mark the line as "list price — no customer rule found"
- Rep sets margin at line level and quote level; quote-level change applies to all unlocked lines
- Never quietly guess at a price. An unknown price is flagged, not invented.

### 6.6 Unit of measure

Contractor writes "500ft of 12/2." The catalogue sells it by the 250ft roll, or prices per thousand feet (MFT). Getting this wrong produces a quote off by 10x, which is the fastest way to lose trust permanently.

Requirements:
- Maintain a UOM conversion table: each, foot, MFT, roll, box, carton, coil, spool, pound, hundredweight
- Per-product packaging data: units per package, package size
- Round up to whole sellable packages, and show the rep both the requested quantity and the quantity being quoted when they differ
- Flag any line where conversion was applied, always — never silently convert
- Any line with an unresolvable UOM goes to the flagged section

### 6.7 Substitutions and stock

**Substitutions.** When a contractor names a brand the distributor doesn't stock, the rep normally swaps in an equivalent from memory — often at better margin. If the system just says "no match found," it has lost the most valuable move in the trade.

- Maintain an equivalence map (manufacturer cross-reference) per tenant
- Where no direct match exists, suggest functional equivalents from stocked lines
- Always label a substitution clearly as a substitution, showing what was requested and what is being offered
- Rep can accept, reject, or swap for a different alternative — every decision feeds the learning loop

**Stock check.** Flag lines that are not available. Quoting something you can't deliver is worse than being slow.

- Show current on-hand quantity from the catalogue export
- Flag any line where requested quantity exceeds available
- Where the export includes lead time, show it

### 6.8 Learning loop

**This is the moat.** Anyone can bolt an LLM onto a catalogue. Nobody else has six months of a specific distributor's own corrections. Build it in from day one, even crudely.

Every rep correction is captured:
- The raw line text as the contractor wrote it
- What the system matched
- What the rep changed it to
- Which tenant, which contractor, which rep, when

Requirements:
- On future matches, a prior confirmed correction for the same tenant + same contractor + similar raw text takes priority over all other signals and returns high confidence
- Corrections are scoped to the tenant and never leak across tenants
- Contractor-specific shorthand is learned per contractor within a tenant
- Track correction rate over time as the headline quality metric — it should fall week over week, and that chart is your renewal argument

### 6.9 Review screen

This screen is where the product wins or loses. If the rep trusts what he sees, he sends in ten minutes. If he re-checks all 80 lines himself, we've saved him nothing.

Layout: **original document on the left, matched draft on the right, line by line, scroll-synced.**

Structure:
- **Flagged section at the top.** Low confidence, no match, UOM conversions, missing price, out of stock, substitutions. This is where the rep's attention goes.
- **Confirmed section below, collapsed by default.** High-confidence lines. He can expand and spot-check but doesn't have to.

Per-line controls: accept, change match (with searchable catalogue picker), edit quantity, edit UOM, edit price, set line margin, add note, delete line, add a line manually.

Quote-level controls: global margin, terms, validity period, delivery notes, customer contact.

Requirements:
- Clicking a line on the draft highlights the corresponding place in the original document
- Every automated decision is explainable on hover — why this product, why this price, why this quantity
- Unparsed and unmatched lines are never hidden
- Autosave continuously; no lost work
- Keyboard-driven — reps are fast typists and will resent a mouse-only interface

### 6.10 Multi-user handling

A shared inbox means two reps can open the same RFQ.

- Simple claiming: first rep to open it owns it
- Others see who has it and can request or force a handover
- Show live presence on a quote
- Full activity log per quote

### 6.11 Output

- Branded quote PDF: tenant's logo, address, terms, quote number, validity date
- Excel export of line items for reps who want to work the numbers
- CSV/file export formatted for import into their ERP (format determined with the design partner)
- Quote sent as a reply in the original email thread, so the contractor's context is preserved

### 6.12 Notifications

Put notifications where people already are. No phone calls, no robocalls, no separate app to check.

**Rep:** reply into the original email thread when a draft is ready, plus a Teams message if the tenant uses Teams. Link goes straight into the review screen for that quote.

**Owner:** no per-RFQ alerts. He gets:
- A weekly summary: RFQs received, quotes sent, average turnaround, correction rate, anything dropped
- One alert type only — an RFQ sitting unquoted past a threshold he sets (default 4 business hours). That is the one that costs him money and the only one worth interrupting him for.

### 6.13 Won/lost tracking

Rep or owner marks each sent quote won, lost, or no response. Optionally captures the winning price when lost.

This is how you prove value at renewal and justify raising your price. Surface it in the owner's weekly summary.

---

## 7. Data model

Multi-tenant from day one. One codebase, isolated data per distributor.

**Core tables** (all tenant-scoped tables carry `tenant_id`):

- `tenants` — distributor org, settings, branding, feature flags
- `users` — belongs to tenant, role (rep / owner / admin)
- `mailbox_connections` — Graph tokens or forwarding address, subscription state, health
- `customers` — contractors, with identifying email domains/addresses
- `products` — catalogue: SKU, manufacturer part number, UPC, description, category, list price, UOM, package size, on-hand qty, lead time
- `product_embeddings` — pgvector, for semantic matching
- `price_rules` — customer-level, category-level, product-level, contract, job-specific
- `uom_conversions` — tenant-level conversion table
- `substitution_map` — manufacturer cross-reference per tenant
- `rfqs` — inbound request: source email, raw attachments, classification, status, parent RFQ for revisions
- `rfq_lines` — parsed line items with raw text preserved
- `quotes` — draft/sent/won/lost, margin settings, totals
- `quote_lines` — matched product, confidence, price, UOM conversion applied, substitution flag, notes
- `corrections` — the learning store: raw text, matched product, corrected product, customer, timestamp
- `activity_log` — every action on every quote
- `classification_log` — every RFQ/not-RFQ decision with reasoning

**Isolation requirements:**
- Postgres row-level security on every tenant-scoped table, enforced at the database, not just in application code
- No query path that can return cross-tenant rows
- Corrections and embeddings strictly tenant-scoped
- Tenant isolation tested explicitly, with tests that fail loudly on any leak

---

## 8. Technical architecture

**Stack:** Next.js (App Router) · Postgres via Supabase · Supabase Auth, Storage, RLS · Vercel

**Key choices:**

- **Auth:** Microsoft OAuth (Entra ID) as the primary sign-in. They already have it, we're already connected to their mailbox, and it removes "another password" as an objection. Email/password as fallback only.
- **Vector search:** pgvector in Supabase for semantic product matching.
- **Background jobs:** email intake, parsing, and matching are queued, not run in the request path. A single RFQ can take minutes to process. Use a durable queue with retries and dead-lettering — never lose an RFQ to a failed job.
- **File storage:** Supabase Storage for original attachments and generated PDFs, with tenant-scoped access policies.
- **LLM usage:** classification, parsing, and semantic matching. Every call logged with input, output, model, and cost, per tenant.
- **Catalogue ingestion:** admin-side upload of the tenant's product/price export (CSV/Excel), with validation, preview, and diff against the previous version before commit. Scheduled re-import supported.

**Environments:** local, staging, production. Design partner runs on production from day one with real data — staging is for our testing only.

**Mobile:** responsive read-only view of RFQ and quote status. No editing. Owners are not always at a desk.

---

## 9. Non-functional requirements

- **Speed:** RFQ arrival to draft-ready in under 5 minutes for a typical 80-line RFQ. Review screen loads in under 2 seconds.
- **Reliability:** no lost RFQs, ever. Every failure path queues and alerts rather than dropping.
- **Auditability:** every automated decision explainable and logged. Every human action logged.
- **Security:** RLS everywhere, encrypted tokens at rest, least-privilege Graph scopes (read mail only — never send from their mailbox without explicit action).
- **Cost visibility:** LLM spend tracked per tenant per month, so pricing stays sane.

---

## 10. Build order

**Phase 1 — Foundation**
Multi-tenant schema, RLS, auth, tenant onboarding, catalogue and price-rule ingestion with validation.

**Phase 2 — Intake**
Graph mailbox connection, forwarding fallback, RFQ classification, dedup, revision detection, raw storage.

**Phase 3 — Parsing and matching**
Document parsing for all formats, line extraction, catalogue matching with confidence scoring, embeddings.

**Phase 4 — Pricing engine**
Customer identification, price rule application, UOM conversion, stock check, substitutions.

**Phase 5 — Review screen**
The side-by-side UI, flagged/confirmed sections, all line controls, claiming, autosave.

**Phase 6 — Output and loop**
PDF generation, exports, thread reply, Teams notification, correction capture, learning loop wired into matching.

**Phase 7 — Owner layer**
Weekly summary, stale-RFQ alert, won/lost tracking, admin tooling for classification review and match tuning.

Phases 1–5 are the pilot minimum. Phase 6 must land before the design partner is asked to pay. Phase 7 before the second customer.

---

## 11. Open questions for the design partner

Answer these with them before Phase 4:

1. What format can they export the catalogue in, how often, and does it include on-hand quantity and lead time?
2. How are customer price rules stored, and can those be exported too?
3. Which ERP, and what import format will accept a finished quote?
4. Do they use Teams, or Slack, or neither?
5. What is the actual volume — RFQs per week, average lines per RFQ?
6. How many reps share the quotes inbox?
7. Do they have a manufacturer cross-reference list already, or is substitution knowledge only in people's heads?
8. What does their current quote document look like — get a real one to match.

---

## 12. What we are deliberately not building

Stated here so it doesn't creep back in mid-build:

- No robocalls or phone alerts. Reps sit in Outlook all day; they don't miss email, they miss time.
- No Outlook add-in. Needs Microsoft approval and admin deployment — too much friction to sell a pilot.
- No live ERP integration. These are old, locked-down, expensive systems, and building one per customer means never shipping. Phase two, priced separately.
- No self-serve signup. Every tenant is onboarded by hand during pilot, because catalogue and pricing ingestion needs a human eye.