import 'server-only'

import type { TenantDb } from '@/lib/supabase/tenant'
import { normalizeForMatch, type MatchCandidate, type MatchLine } from './matching'
import type { CataloguePorts, DraftProduct, SubstitutionOffer } from './draft'
import type { ApplicableRule } from './pricing'

/**
 * The database side of matching (PRD 6.4, 6.7, 6.8).
 *
 * Every search here is a separate signal; none of them decides anything. They
 * all feed `matchLine`, which weighs them. Keeping the queries in one file and
 * the judgement in another is what lets the judgement be tested without a
 * database, and lets a slow query be fixed without touching the rules.
 */

type SearchRow = {
  product_id: string
  sku: string
  description: string
  manufacturer: string | null
  manufacturer_part_number: string | null
  upc: string | null
  similarity: number
}

function toCandidate(row: SearchRow, source: MatchCandidate['source']): MatchCandidate {
  return {
    productId: row.product_id,
    sku: row.sku,
    description: row.description,
    manufacturer: row.manufacturer,
    manufacturerPartNumber: row.manufacturer_part_number,
    upc: row.upc,
    source,
    rawScore: row.similarity,
  }
}

const PRODUCT_COLUMNS =
  'id, sku, description, category, manufacturer, manufacturer_part_number, upc, ' +
  'list_price, cost, uom, base_uom, units_per_package, on_hand_qty, lead_time_days, is_stocked'

type ProductRow = {
  id: string
  sku: string
  description: string
  category: string | null
  manufacturer: string | null
  manufacturer_part_number: string | null
  upc: string | null
  list_price: number | null
  cost: number | null
  uom: string
  base_uom: string | null
  units_per_package: number | null
  on_hand_qty: number | null
  lead_time_days: number | null
  is_stocked: boolean
}

function toDraftProduct(row: ProductRow): DraftProduct {
  return {
    id: row.id,
    sku: row.sku,
    description: row.description,
    category: row.category,
    manufacturer: row.manufacturer,
    manufacturerPartNumber: row.manufacturer_part_number,
    upc: row.upc,
    list_price: row.list_price === null ? null : Number(row.list_price),
    cost: row.cost === null ? null : Number(row.cost),
    uom: row.uom,
    base_uom: row.base_uom,
    baseUom: row.base_uom,
    unitsPerPackage: row.units_per_package === null ? null : Number(row.units_per_package),
    on_hand_qty: row.on_hand_qty === null ? null : Number(row.on_hand_qty),
    lead_time_days: row.lead_time_days,
    is_stocked: row.is_stocked,
  } as DraftProduct
}

export type CatalogueOptions = {
  customerId: string | null
  /** Supplied by the caller so the embedding provider stays out of this file. */
  embed?: (text: string) => Promise<number[] | null>
}

export function cataloguePorts(
  db: TenantDb,
  options: CatalogueOptions,
): CataloguePorts {
  const tenantId = db.tenantId
  let cachedRules: ApplicableRule[] | null = null

  return {
    async findCandidates(line: MatchLine): Promise<MatchCandidate[]> {
      const text = line.description ?? line.rawText
      const candidates: MatchCandidate[] = []

      // 1. Prior corrections, first and heaviest (6.8).
      const { data: corrections } = await db.rpc('find_corrections' as never, {
        target_tenant: tenantId,
        target_customer: options.customerId,
        raw_normalized: normalizeForMatch(text),
      } as never)

      for (const row of (corrections ?? []) as unknown as (SearchRow & {
        same_customer: boolean
        times_reinforced: number
      })[]) {
        // A correction from a different contractor is a weaker signal than one
        // from this contractor, so it comes through as a description match
        // rather than as a confirmed correction.
        candidates.push(
          row.same_customer
            ? { ...toCandidate(row, 'correction'), timesReinforced: row.times_reinforced }
            : { ...toCandidate(row, 'trigram'), rawScore: row.similarity },
        )
      }

      // 2. Exact identifiers.
      if (line.partNumber) {
        const part = line.partNumber.toUpperCase()
        const { data } = await db
          .from('products')
          .select(PRODUCT_COLUMNS)
          .eq('is_active', true)
          .or(`manufacturer_part_number.ilike.${part},sku.ilike.${part},upc.eq.${part}`)
          .limit(5)

        for (const row of (data ?? []) as unknown as ProductRow[]) {
          const source =
            row.manufacturer_part_number?.toUpperCase() === part ? 'mpn'
            : row.sku.toUpperCase() === part ? 'sku'
            : 'upc'
          candidates.push({
            productId: row.id,
            sku: row.sku,
            description: row.description,
            manufacturer: row.manufacturer,
            manufacturerPartNumber: row.manufacturer_part_number,
            upc: row.upc,
            source,
          })
        }
      }

      // 3. Semantic search, when an embedding is available.
      if (options.embed) {
        const embedding = await options.embed(text)
        if (embedding) {
          const { data } = await db.rpc('search_products_vector' as never, {
            target_tenant: tenantId,
            query_embedding: JSON.stringify(embedding),
            match_limit: 8,
          } as never)
          for (const row of (data ?? []) as unknown as SearchRow[]) {
            candidates.push(toCandidate(row, 'semantic'))
          }
        }
      }

      // 4. Trigram, which costs nothing and catches what embeddings miss:
      // part-number fragments and abbreviations nobody wrote a sentence around.
      const { data: textMatches } = await db.rpc('search_products_text' as never, {
        target_tenant: tenantId,
        query: text,
        match_limit: 8,
      } as never)
      for (const row of (textMatches ?? []) as unknown as SearchRow[]) {
        candidates.push(toCandidate(row, 'trigram'))
      }

      return candidates
    },

    async loadProducts(productIds: string[]): Promise<Map<string, DraftProduct>> {
      if (productIds.length === 0) return new Map()
      const { data } = await db.from('products').select(PRODUCT_COLUMNS).in('id', productIds)
      return new Map(
        ((data ?? []) as unknown as ProductRow[]).map((row) => [row.id, toDraftProduct(row)]),
      )
    },

    async findSubstitutes(line: MatchLine): Promise<SubstitutionOffer[]> {
      if (!line.partNumber) return []

      const { data } = await db
        .from('substitution_map')
        .select(
          `id, relationship, requested_manufacturer, requested_part_number,
           products!substitution_map_substitute_product_id_fkey(${PRODUCT_COLUMNS})`,
        )
        .ilike('requested_part_number', line.partNumber)
        .limit(5)

      const rows = (data ?? []) as unknown as {
        id: string
        relationship: string
        requested_manufacturer: string | null
        requested_part_number: string
        products: ProductRow | null
      }[]

      return rows
        .filter((row) => row.products !== null && row.products.is_stocked)
        .map((row) => ({
          substitutionId: row.id,
          product: toDraftProduct(row.products!),
          requestedText: [row.requested_manufacturer, row.requested_part_number]
            .filter(Boolean)
            .join(' '),
          relationship: row.relationship,
        }))
    },

    async priceRules(): Promise<ApplicableRule[]> {
      if (cachedRules) return cachedRules

      // Loaded once per RFQ rather than per line: a tenant has thousands of
      // rules, an RFQ has eighty lines, and the filtering is cheap in memory.
      const { data } = await db
        .from('price_rules')
        .select(
          'id, scope, method, value, customer_id, product_id, category, manufacturer, ' +
            'contract_code, job_name, precedence, effective_from, effective_to',
        )
        .or(
          options.customerId
            ? `customer_id.eq.${options.customerId},customer_id.is.null`
            : 'customer_id.is.null',
        )

      cachedRules = ((data ?? []) as unknown as ApplicableRule[]).map((rule) => ({
        ...rule,
        value: Number(rule.value),
      }))
      return cachedRules
    },
  }
}
