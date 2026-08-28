/**
 * Unit-of-measure conversion (PRD 6.6).
 *
 * A contractor writes "500ft of 12/2". The catalogue sells it by the 250ft roll,
 * or prices it per thousand feet. Getting this wrong produces a quote off by
 * 10x, which is the fastest way to lose a rep's trust permanently.
 *
 * Three rules follow from that:
 *
 *   1. A conversion is never silent. Every line where one was applied says so,
 *      and shows the requested quantity next to the quoted one.
 *   2. A unit we cannot resolve is not guessed at. The line is marked
 *      unresolved and goes to the flagged section for a human.
 *   3. Anything sold as a discrete package rounds **up** to whole packages. You
 *      cannot buy two thirds of a roll.
 */

export type UomTables = {
  /** As-written unit ("ft", "linear feet") to canonical code ("FT"). */
  aliases: Map<string, string>
  /** "FROM>TO" to factor, where 1 FROM = factor TO. */
  conversions: Map<string, number>
}

export type UomProduct = {
  /** The unit the catalogue sells and prices in. */
  uom: string
  /** What one sellable package contains, in `baseUom`. */
  unitsPerPackage: number | null
  baseUom: string | null
}

export type ConversionResult = {
  quotedQty: number | null
  quotedUom: string
  requestedQty: number | null
  requestedUom: string | null
  /** True when quoted quantity or unit differs from what was asked for. */
  applied: boolean
  /** Plain-English explanation, shown on the line. Null when nothing changed. */
  note: string | null
  /** True when no conversion path exists. The line must be flagged. */
  unresolved: boolean
}

/** Units you cannot sell a fraction of. */
const DISCRETE = new Set(['EA', 'ROLL', 'BOX', 'CTN', 'COIL', 'SPOOL', 'PKG', 'DOZ', 'GRS', 'SET', 'PAIR', 'BAG'])

/** Units that describe a package rather than a measure. */
const PACKAGE_UNITS = new Set(['ROLL', 'BOX', 'CTN', 'COIL', 'SPOOL', 'PKG', 'BAG', 'SET'])

export function buildUomTables(
  aliases: { alias: string; uom: string }[],
  conversions: { from_uom: string; to_uom: string; factor: number }[],
): UomTables {
  return {
    aliases: new Map(aliases.map((a) => [a.alias.trim().toLowerCase(), a.uom.trim().toUpperCase()])),
    conversions: new Map(
      conversions.map((c) => [`${c.from_uom.toUpperCase()}>${c.to_uom.toUpperCase()}`, Number(c.factor)]),
    ),
  }
}

/** Canonicalises a unit as the contractor wrote it. Unknown text is upper-cased. */
export function canonicalUom(written: string | null | undefined, tables: UomTables): string | null {
  if (!written) return null
  const key = written.trim().toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ')
  if (key.length === 0) return null
  return tables.aliases.get(key) ?? written.trim().toUpperCase()
}

/**
 * Factor to get from one unit to another, following the tenant's conversion
 * table in either direction.
 *
 * Breadth-first rather than a direct lookup, because a tenant's table stores
 * "MFT = 1000 FT" and "YD = 3 FT" but never "MFT = 333.33 YD", and both of those
 * questions get asked.
 */
export function conversionFactor(from: string, to: string, tables: UomTables): number | null {
  const start = from.toUpperCase()
  const target = to.toUpperCase()
  if (start === target) return 1

  const edges = new Map<string, [string, number][]>()
  const addEdge = (a: string, b: string, factor: number) => {
    if (!edges.has(a)) edges.set(a, [])
    edges.get(a)!.push([b, factor])
  }
  for (const [key, factor] of tables.conversions) {
    const [a, b] = key.split('>')
    if (!a || !b || !Number.isFinite(factor) || factor <= 0) continue
    addEdge(a, b, factor)
    addEdge(b, a, 1 / factor)
  }

  const seen = new Set([start])
  let frontier: [string, number][] = [[start, 1]]

  // Four hops is more than any real unit chain needs and keeps a malformed
  // table from looping.
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    const next: [string, number][] = []
    for (const [node, acc] of frontier) {
      for (const [neighbour, factor] of edges.get(node) ?? []) {
        if (seen.has(neighbour)) continue
        const total = acc * factor
        if (neighbour === target) return total
        seen.add(neighbour)
        next.push([neighbour, total])
      }
    }
    frontier = next
  }

  return null
}

function round(value: number, uom: string): number {
  if (DISCRETE.has(uom)) return Math.ceil(value - 1e-9)
  // Measures keep four decimals: 0.5 MFT is a real quantity, 0.5 rolls is not.
  return Math.round(value * 10000) / 10000
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10000) / 10000)
}

/**
 * Works out what quantity to quote, in the unit the catalogue sells in.
 *
 * When the contractor gave no unit at all, the quantity is read as being in the
 * product's own selling unit -- which is what "25 4-square boxes" means when the
 * catalogue sells boxes individually. That is an assumption, so it is stated on
 * the line rather than hidden.
 */
export function convertQuantity(
  requestedQty: number | null,
  requestedUomWritten: string | null,
  product: UomProduct,
  tables: UomTables,
): ConversionResult {
  const sellUom = product.uom.toUpperCase()
  const requestedUom = canonicalUom(requestedUomWritten, tables)

  const base: ConversionResult = {
    quotedQty: requestedQty,
    quotedUom: sellUom,
    requestedQty,
    requestedUom,
    applied: false,
    note: null,
    unresolved: false,
  }

  // No quantity is a rep decision, not a conversion problem.
  if (requestedQty === null || !Number.isFinite(requestedQty)) {
    return { ...base, quotedQty: null }
  }

  if (requestedUom === null) {
    return {
      ...base,
      quotedQty: round(requestedQty, sellUom),
      note: `No unit given — read as ${format(requestedQty)} ${sellUom}`,
    }
  }

  if (requestedUom === sellUom) {
    return base
  }

  // Sold as a package of a measured unit: 250ft on a roll, 100 in a box. The
  // package size lives on the product because it is a property of the product,
  // not of the word "roll".
  if (PACKAGE_UNITS.has(sellUom)) {
    const packageSize = product.unitsPerPackage
    const packageBase = (product.baseUom ?? '').toUpperCase()

    if (!packageSize || packageSize <= 0 || !packageBase) {
      return {
        ...base,
        quotedQty: null,
        unresolved: true,
        note:
          `Sold by the ${sellUom} but the catalogue does not say how many ${requestedUom} ` +
          `one holds — quantity needs checking`,
      }
    }

    const toBase = conversionFactor(requestedUom, packageBase, tables)
    if (toBase === null) {
      return {
        ...base,
        quotedQty: null,
        unresolved: true,
        note: `No conversion from ${requestedUom} to ${packageBase} — quantity needs checking`,
      }
    }

    const baseQty = requestedQty * toBase
    const packages = round(baseQty / packageSize, sellUom)

    return {
      ...base,
      quotedQty: packages,
      applied: true,
      note:
        `${format(requestedQty)} ${requestedUom} requested; quoting ${format(packages)} ${sellUom} ` +
        `of ${format(packageSize)} ${packageBase} ` +
        `(${format(packages * packageSize)} ${packageBase} total)`,
    }
  }

  const factor = conversionFactor(requestedUom, sellUom, tables)
  if (factor === null) {
    return {
      ...base,
      quotedQty: null,
      unresolved: true,
      note: `No conversion from ${requestedUom} to ${sellUom} — quantity needs checking`,
    }
  }

  const converted = round(requestedQty * factor, sellUom)
  return {
    ...base,
    quotedQty: converted,
    applied: true,
    note: `${format(requestedQty)} ${requestedUom} requested; quoting ${format(converted)} ${sellUom}`,
  }
}
