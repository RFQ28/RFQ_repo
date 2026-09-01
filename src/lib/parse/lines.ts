/**
 * Line extraction (PRD 6.3).
 *
 * A contractor's list arrives as free text, a spreadsheet, or a table lifted out
 * of a PDF. Whatever the source, the output is the same: one row per line, in
 * the order it was written, with the original text kept verbatim.
 *
 * The rule that shapes everything here: **never silently drop a line.** A line
 * we cannot read is still a row, marked unparsed, so a rep sees it and deals
 * with it. Losing a line is worse than misreading one, because a misread line
 * is visible and a lost line is not.
 */

export type ExtractedLine = {
  lineNumber: number
  rawText: string
  description: string | null
  quantity: number | null
  uomAsWritten: string | null
  manufacturer: string | null
  partNumber: string | null
  isParsed: boolean
  parseError: string | null
  sourceDocument?: string
  sourcePage?: number
}

export type ExtractedMetadata = {
  jobName?: string
  contractorName?: string
  dueDate?: string
  deliveryAddress?: string
}

export type ExtractionResult = {
  lines: ExtractedLine[]
  metadata: ExtractedMetadata
}

// ---------------------------------------------------------------------------
// Quantities and units
// ---------------------------------------------------------------------------

const UNIT_WORDS = [
  'mft', 'cft', 'lf', 'ft', 'feet', 'foot', 'in', 'inch', 'inches', 'yd', 'yard',
  'ea', 'each', 'pc', 'pcs', 'piece', 'pieces', 'unit', 'units',
  'roll', 'rolls', 'box', 'boxes', 'bx', 'case', 'cases', 'cs', 'carton', 'ctn',
  'coil', 'coils', 'spool', 'spools', 'reel', 'reels',
  'pkg', 'package', 'pk', 'doz', 'dozen', 'lb', 'lbs', 'pound', 'pounds',
  'cwt', 'gal', 'gallon', 'set', 'sets', 'pair', 'prs', 'bag', 'bags', 'bundle',
]

const UNIT_ALTERNATION = UNIT_WORDS.join('|')

/**
 * Leading quantity: "500ft of ...", "12 EA 1/2in EMT", "(6) boxes", "2,500 LF".
 * The unit is optional -- plenty of lines are just "25 4-square boxes".
 */
const LEADING_QTY = new RegExp(
  String.raw`^\s*[-*•]?\s*` +
    String.raw`(?:\(?\s*(?<qty>\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*\)?)` +
    // "1/2in EMT" opens with a size, not a quantity of one.
    String.raw`(?!\s*/\s*\d)` +
    String.raw`\s*(?<uom>${UNIT_ALTERNATION})?\b\.?` +
    String.raw`\s*(?:of\s+|x\s+|@\s*)?` +
    String.raw`(?<rest>.*)$`,
  'i',
)

/** Trailing quantity: "1/2in EMT connector .... 25 ea", "3/4 EMT — qty 40". */
const TRAILING_QTY = new RegExp(
  String.raw`^(?<rest>.*?)[\s.\-–—:]+` +
    String.raw`(?:qty\.?|quantity|x)?\s*` +
    String.raw`(?<qty>\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*` +
    String.raw`(?<uom>${UNIT_ALTERNATION})?\s*$`,
  'i',
)

/** A leading "1." / "1)" / "Item 3 -" list marker, which is not a quantity. */
const LIST_MARKER = /^\s*(?:item\s*)?\d{1,3}\s*[.)\]:-]\s+/i

function toQuantity(text: string): number | null {
  const n = Number(text.replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

// ---------------------------------------------------------------------------
// Part numbers
// ---------------------------------------------------------------------------

const MANUFACTURERS = [
  'square d', 'squared', 'eaton', 'cutler hammer', 'cutler-hammer', 'siemens',
  'ge', 'general electric', 'abb', 'schneider', 'allen bradley', 'allen-bradley',
  'hubbell', 'leviton', 'pass & seymour', 'pass and seymour', 'p&s', 'lutron',
  'cooper', 'crouse hinds', 'crouse-hinds', 'appleton', 'thomas & betts', 't&b',
  'raco', 'steel city', 'bridgeport', 'arlington', 'caddy', 'erico', 'unistrut',
  'southwire', 'encore', 'cerrowire', 'republic', 'wiremold', 'panduit',
  'burndy', 'ilsco', 'nsi', 'ideal', 'klein', 'greenlee', 'milbank', 'midwest',
  'lithonia', 'acuity', 'cree', 'philips', 'sylvania', 'ge lighting', 'rab',
  'juno', 'halo', 'wac', 'intermatic', 'tork', 'wago', 'phoenix contact',
]

/**
 * A token that looks like a catalogue part number: mixed letters and digits, or
 * a digit run with a separator. Deliberately loose -- this is a hint for the
 * matcher, not an assertion, and the matcher verifies it against the catalogue.
 */
// The digit lookahead is bounded to the token's own characters. Written as
// `(?=.*\d)` it would scan the rest of the line, so "SQUARE" in "Square D
// QO120" would qualify on the strength of a digit five characters later.
const PART_TOKEN = /\b(?=[A-Z0-9\-/.]*\d)[A-Z0-9][A-Z0-9\-/.]{3,}\b/g

const NOT_A_PART = new Set([
  '1/2IN', '3/4IN', 'THHN', 'THWN', 'XHHW', 'MC', 'AC', 'EMT', 'IMC', 'RMC', 'PVC',
])

function extractPartNumber(text: string): string | null {
  const upper = text.toUpperCase()
  const candidates = upper.match(PART_TOKEN) ?? []

  for (const candidate of candidates) {
    if (NOT_A_PART.has(candidate)) continue
    // Wire sizes ("12/2", "500MCM") and dimensions ("4-11/16") read as part
    // numbers otherwise, and a wrong hint is worse than none.
    if (/^\d+\/\d+$/.test(candidate)) continue
    if (/^\d+(\.\d+)?(MCM|AWG|KCMIL)$/.test(candidate)) continue
    if (/^\d+[-/]\d+[-/]\d+$/.test(candidate)) continue
    if (!/[A-Z]/.test(candidate)) continue
    return candidate
  }
  return null
}

function extractManufacturer(text: string): string | null {
  const lower = text.toLowerCase()
  // Longest name first, so "cutler hammer" is not shortened to nothing and
  // "ge lighting" beats "ge".
  const sorted = [...MANUFACTURERS].sort((a, b) => b.length - a.length)
  for (const name of sorted) {
    const pattern = new RegExp(`(?:^|[^a-z])${name.replace(/[&]/g, '\\&')}(?:[^a-z]|$)`, 'i')
    if (pattern.test(lower)) return name
  }
  return null
}

// ---------------------------------------------------------------------------
// What is a line item, and what is chatter
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
  /^(?:hi|hello|hey|good (?:morning|afternoon))\b/i,
  /^(?:thanks|thank you|regards|best|sincerely|cheers)\b/i,
  /^(?:please|can you|could you|let me know|need(?:ed)? (?:by|asap))\b/i,
  /^(?:sent from|get outlook|this email|confidential)/i,
  /^(?:from|to|cc|bcc|sent|subject|date):/i,
  /^[-=_*\s]{3,}$/,
  /^(?:page\s+\d+|\d+\s+of\s+\d+)$/i,
  /^(?:qty|quantity|item|description|part|unit|uom|price|total|no\.?|#)\b[\s|,]*$/i,
]

/** Header rows in a pasted table: mostly column names, no real content. */
const HEADER_ROW = /^(?:\s*(?:qty|quantity|item|no\.?|#|description|desc|part|part\s*(?:no|number|#)|mfg|mfr|manufacturer|unit|uom|u\/m|price|cost|ext|total|line)\b[\s|,\-–—]*){2,}$/i

function isNoise(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  if (HEADER_ROW.test(trimmed)) return true
  return NOISE_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/**
 * A line worth quoting names something.
 *
 * Material lines nearly always carry a number -- a quantity, a wire size, a
 * part number -- so a digit is enough on its own. A line without one has to
 * earn its place by being a real phrase, which is what keeps a signature like
 * "Mike" out while letting "Square D QO breakers, assorted" through.
 */
function looksLikeLineItem(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3) return false
  if (/^\d+$/.test(trimmed)) return false
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(trimmed)) return false
  if (!/[a-z]/i.test(trimmed)) return false

  if (/\d/.test(trimmed)) return true
  return trimmed.split(/\s+/).filter((word) => word.length > 1).length >= 3
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const META_PATTERNS: [keyof ExtractedMetadata, RegExp][] = [
  ['jobName', /^\s*(?:job|project|job\s*name|project\s*name|job\s*#|jobsite|site)\s*[:#-]\s*(.+)$/i],
  ['contractorName', /^\s*(?:contractor|company|customer|from|account)\s*[:-]\s*(.+)$/i],
  ['dueDate', /^\s*(?:due|needed|need\s*by|required\s*by|bid\s*date|quote\s*due)\s*(?:by)?\s*[:-]\s*(.+)$/i],
  ['deliveryAddress', /^\s*(?:deliver(?:y)?(?:\s*to)?|ship\s*to|address|jobsite\s*address)\s*[:-]\s*(.+)$/i],
]

function readMetadata(text: string): Partial<ExtractedMetadata> | null {
  for (const [key, pattern] of META_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      const value = match[1].trim()
      if (value.length > 0 && value.length < 200) return { [key]: value }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// One line
// ---------------------------------------------------------------------------

export function parseLine(rawText: string, lineNumber: number): ExtractedLine {
  const base: ExtractedLine = {
    lineNumber,
    rawText,
    description: null,
    quantity: null,
    uomAsWritten: null,
    manufacturer: null,
    partNumber: null,
    isParsed: false,
    parseError: null,
  }

  const text = rawText.replace(/\s+/g, ' ').trim()
  if (text.length === 0) {
    return { ...base, parseError: 'Empty line' }
  }

  // A list marker is stripped before looking for a quantity, so "1. 500ft of
  // 12/2" does not read as a quantity of 1.
  const withoutMarker = text.replace(LIST_MARKER, '')

  let quantity: number | null = null
  let uom: string | null = null
  let remainder = withoutMarker

  const leading = withoutMarker.match(LEADING_QTY)
  const trailing = withoutMarker.match(TRAILING_QTY)

  /**
   * A bare leading number with no unit is ambiguous: "25 4-square boxes" opens
   * with a quantity, while "3  1/2in EMT couplings - 300 ea" opens with an item
   * number. LIST_MARKER only strips the second when it is punctuated ("3." or
   * "3)"), and plenty of contractors align their columns with spaces instead —
   * at which point the item number was read as the quantity and the real one
   * was left behind in the description. Every line of a twelve-line takeoff
   * came through as "quantity 1" through "quantity 12".
   *
   * The trailing quantity settles it. A line carrying one has already said what
   * it wants; a leading bare integer in front of that is a list marker, not a
   * second opinion. A leading number that names its unit — "500ft of 12/2",
   * "12 EA connectors" — still wins, because that is a quantity stated outright.
   */
  const leadingIsBareInteger =
    Boolean(leading?.groups?.qty) && !leading?.groups?.uom && /^\d{1,3}$/.test(leading!.groups!.qty!)
  const preferTrailing = leadingIsBareInteger && Boolean(trailing?.groups?.qty)

  if (!preferTrailing && leading?.groups?.qty && leading.groups.rest?.trim()) {
    quantity = toQuantity(leading.groups.qty)
    uom = leading.groups.uom ?? null
    remainder = leading.groups.rest.trim()
  } else if (trailing?.groups?.qty && trailing.groups.rest?.trim()) {
    quantity = toQuantity(trailing.groups.qty)
    uom = trailing.groups.uom ?? null
    // The list marker the leading pattern would have eaten is still on the
    // front, so take it off before this becomes the description.
    remainder = trailing.groups.rest.trim().replace(/^\d{1,3}\s+(?!\s*\/)/, '')
  }

  const description = remainder.replace(/^[\s:.\-–—|]+|[\s:.\-–—|]+$/g, '').trim()

  if (description.length === 0) {
    return { ...base, parseError: 'No description found' }
  }

  return {
    ...base,
    description,
    quantity,
    uomAsWritten: uom,
    manufacturer: extractManufacturer(description),
    partNumber: extractPartNumber(description),
    // A line with no quantity still counts as parsed: contractors leave it off
    // constantly, and the rep fills it in. What it must not be is invented.
    isParsed: true,
    parseError: quantity === null ? null : null,
  }
}

// ---------------------------------------------------------------------------
// A whole document
// ---------------------------------------------------------------------------

export function extractFromText(
  text: string,
  options: { sourceDocument?: string } = {},
): ExtractionResult {
  const metadata: ExtractedMetadata = {}
  const lines: ExtractedLine[] = []
  let lineNumber = 0

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) continue

    const meta = readMetadata(trimmed)
    if (meta) {
      Object.assign(metadata, meta)
      continue
    }

    if (isNoise(trimmed)) continue

    if (!looksLikeLineItem(trimmed)) {
      // Not obviously an item, but not obviously chatter either. It is kept as
      // an unparsed row rather than thrown away.
      if (/\d/.test(trimmed)) {
        lineNumber += 1
        lines.push({
          lineNumber,
          rawText: trimmed,
          description: null,
          quantity: null,
          uomAsWritten: null,
          manufacturer: null,
          partNumber: null,
          isParsed: false,
          parseError: 'Could not tell what this line is asking for',
          sourceDocument: options.sourceDocument,
        })
      }
      continue
    }

    lineNumber += 1
    lines.push({ ...parseLine(trimmed, lineNumber), sourceDocument: options.sourceDocument })
  }

  return { lines, metadata }
}

// ---------------------------------------------------------------------------
// A spreadsheet, where the columns already say what they mean
// ---------------------------------------------------------------------------

const QTY_HEADERS = ['qty', 'quantity', 'qnty', 'count', 'amount', 'ea', 'pcs', 'no of', 'number']
const DESC_HEADERS = ['description', 'desc', 'item', 'material', 'product', 'part description', 'details']
const UOM_HEADERS = ['uom', 'unit', 'u/m', 'um', 'unit of measure', 'units']
const PART_HEADERS = ['part', 'part no', 'part number', 'part #', 'catalog', 'cat no', 'mfg part', 'mpn', 'sku', 'item no', 'item number']
const MFG_HEADERS = ['mfg', 'mfr', 'manufacturer', 'brand', 'make', 'vendor']

function findColumn(headers: string[], candidates: string[]): string | null {
  const normalized = headers.map((h) => ({ header: h, key: h.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() }))
  for (const candidate of candidates) {
    const exact = normalized.find((h) => h.key === candidate)
    if (exact) return exact.header
  }
  for (const candidate of candidates) {
    const loose = normalized.find((h) => h.key.includes(candidate))
    if (loose) return loose.header
  }
  return null
}

/**
 * Rows from a spreadsheet or a PDF table. Where a description column exists it
 * is trusted; where it does not, the whole row is flattened and read as text,
 * which is what an unlabelled two-column list amounts to.
 */
export function extractFromRows(
  headers: string[],
  rows: Record<string, string>[],
  options: { sourceDocument?: string } = {},
): ExtractionResult {
  const qtyColumn = findColumn(headers, QTY_HEADERS)
  const descColumn = findColumn(headers, DESC_HEADERS)
  const uomColumn = findColumn(headers, UOM_HEADERS)
  const partColumn = findColumn(headers, PART_HEADERS)
  const mfgColumn = findColumn(headers, MFG_HEADERS)

  const lines: ExtractedLine[] = []
  let lineNumber = 0

  for (const row of rows) {
    const values = Object.values(row).map((v) => (v ?? '').trim())
    const flattened = values.filter(Boolean).join(' ')
    if (flattened.length === 0) continue
    if (isNoise(flattened)) continue

    lineNumber += 1

    if (!descColumn) {
      lines.push({ ...parseLine(flattened, lineNumber), rawText: flattened, sourceDocument: options.sourceDocument })
      continue
    }

    const description = (row[descColumn] ?? '').trim()
    const quantityText = qtyColumn ? (row[qtyColumn] ?? '').trim() : ''
    const quantity = quantityText ? toQuantity(quantityText.replace(/[^\d.,]/g, '')) : null

    if (description.length === 0) {
      lines.push({
        lineNumber,
        rawText: flattened,
        description: null,
        quantity,
        uomAsWritten: uomColumn ? (row[uomColumn] ?? '').trim() || null : null,
        manufacturer: null,
        partNumber: null,
        isParsed: false,
        parseError: 'Row has no description',
        sourceDocument: options.sourceDocument,
      })
      continue
    }

    const partNumber = partColumn ? (row[partColumn] ?? '').trim() || null : null
    const manufacturer = mfgColumn ? (row[mfgColumn] ?? '').trim() || null : null

    lines.push({
      lineNumber,
      rawText: flattened,
      description,
      quantity,
      uomAsWritten: uomColumn ? (row[uomColumn] ?? '').trim() || null : null,
      manufacturer: manufacturer ?? extractManufacturer(description),
      partNumber: partNumber ?? extractPartNumber(description),
      isParsed: true,
      parseError: null,
      sourceDocument: options.sourceDocument,
    })
  }

  return { lines, metadata: {} }
}
