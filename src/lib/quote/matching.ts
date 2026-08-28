import type { ConfidenceBand, MatchAlternative } from '@/lib/db/types'

/**
 * Catalogue matching and confidence (PRD 6.4, 6.8).
 *
 * Candidates arrive from several places -- a prior correction, an exact
 * manufacturer part number, the distributor's own SKU, a UPC, a trigram search,
 * a vector search. This module decides which one wins, how sure we are, and why
 * in words a rep can read on hover.
 *
 * Two things drive the design:
 *
 *   - A prior confirmed correction for the same tenant and customer outranks
 *     every other signal (6.8). That is the moat: nobody else has six months of
 *     this distributor's own corrections.
 *   - "1/2in EMT connector" and "3/4in EMT connector" are nearly identical to a
 *     description matcher and are not the same product. A conflicting size,
 *     gauge, amperage or voltage demotes a candidate hard, because a confident
 *     wrong match costs more than an honest low-confidence one.
 */

export type CandidateSource = 'correction' | 'mpn' | 'sku' | 'upc' | 'semantic' | 'trigram'

export type MatchCandidate = {
  productId: string
  sku: string
  description: string
  manufacturer: string | null
  manufacturerPartNumber: string | null
  upc: string | null
  source: CandidateSource
  /** Cosine similarity for `semantic`, trigram similarity for `trigram`. */
  rawScore?: number
  /** How many times a correction has been reinforced, for `correction`. */
  timesReinforced?: number
}

export type MatchLine = {
  rawText: string
  description: string | null
  partNumber: string | null
  manufacturer: string | null
}

export type ConfidenceThresholds = { high: number; medium: number; low: number }

export const DEFAULT_THRESHOLDS: ConfidenceThresholds = { high: 0.92, medium: 0.75, low: 0.55 }

export type MatchResult = {
  productId: string | null
  confidence: number
  band: ConfidenceBand
  method: CandidateSource | 'none'
  reasoning: string
  /** Top 3-5 runners-up, always returned below high confidence (6.4). */
  alternatives: MatchAlternative[]
  flagReasons: string[]
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** The form corrections are stored and looked up by (6.8). */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9/.\-# ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const STOP_WORDS = new Set([
  'the', 'and', 'or', 'of', 'for', 'with', 'a', 'an', 'to', 'in', 'on', 'by',
  'ea', 'each', 'pcs', 'pc', 'qty', 'assorted', 'misc', 'type',
])

function tokens(text: string): string[] {
  return normalizeForMatch(text)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
}

/** Jaccard overlap of the meaningful words in two descriptions. */
export function descriptionOverlap(a: string, b: string): number {
  const left = new Set(tokens(a))
  const right = new Set(tokens(b))
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

// ---------------------------------------------------------------------------
// Specifications that must not differ
// ---------------------------------------------------------------------------

export type Specs = {
  /** Trade sizes and fractions: 1/2, 3/4, 4-11/16. */
  sizes: Set<string>
  /** Conductor configurations: 12/2, 10/3. */
  wire: Set<string>
  /** Wire gauge: #12, 12 AWG, 500 MCM. */
  gauge: Set<string>
  amps: Set<string>
  volts: Set<string>
  poles: Set<string>
}

/** "4-11/16" — always a trade size. */
const MIXED_SIZE_RE = /\b(\d{1,2}-\d{1,2}\/\d{1,2})(?![\d/])/g
/**
 * "2in", "3 inch", '4"' — a whole-number trade size. The lookbehind keeps it
 * off the denominator of "1/2in", which the fraction pass already owns.
 */
const INCH_SIZE_RE = /(?<![\d/])(\d{1,2})\s*(?:in\b|inch(?:es)?\b|")/gi
/** Any bare fraction. Which kind it is depends on the numbers — see below. */
const FRACTION_RE = /(?<![\d./])(\d{1,3})\/(\d{1,2})(?![\d/])/g
const GAUGE_RE = /\b(?:#\s*(\d{1,2})\b|(\d{1,2})\s*awg\b|(\d{3,4})\s*(?:mcm|kcmil)\b)/gi
const AMP_RE = /\b(\d{1,4})\s*(?:a|amp|amps|ampere)\b/gi
const VOLT_RE = /\b(\d{2,4})\s*(?:v|volt|volts|vac|vdc)\b/gi
const POLE_RE = /\b(\d)\s*(?:p|pole|poles)\b/gi

function collect(text: string, pattern: RegExp): Set<string> {
  const out = new Set<string>()
  for (const match of text.matchAll(pattern)) {
    const value = match.slice(1).find(Boolean)
    if (value) out.add(value.toLowerCase().replace(/\s+/g, ''))
  }
  return out
}

export function extractSpecs(text: string): Specs {
  const lower = ` ${text.toLowerCase()} `

  const sizes = new Set([...collect(lower, MIXED_SIZE_RE), ...collect(lower, INCH_SIZE_RE)])
  const wire = new Set<string>()

  // A bare fraction is a trade size when it is a real fraction ("1/2", "3/4")
  // and a conductor configuration when it is not ("12/2" is twelve-gauge,
  // two-conductor). Catalogue descriptions write both without a unit, so the
  // numbers themselves have to settle it.
  for (const match of lower.matchAll(FRACTION_RE)) {
    const numerator = Number(match[1])
    const denominator = Number(match[2])
    const value = `${match[1]}/${match[2]}`
    if (numerator < denominator) sizes.add(value)
    else wire.add(value)
  }

  return {
    sizes,
    wire,
    gauge: collect(lower, GAUGE_RE),
    amps: collect(lower, AMP_RE),
    volts: collect(lower, VOLT_RE),
    poles: collect(lower, POLE_RE),
  }
}

const SPEC_LABELS: [keyof Specs, string][] = [
  ['sizes', 'size'],
  ['wire', 'conductors'],
  ['gauge', 'gauge'],
  ['amps', 'amps'],
  ['volts', 'volts'],
  ['poles', 'poles'],
]

/**
 * Specs the line states that the candidate contradicts.
 *
 * A spec the candidate simply does not mention is not a conflict -- catalogue
 * descriptions are abbreviated and half of them omit the voltage. Only a stated
 * difference counts.
 */
export function specConflicts(line: string, candidate: string): string[] {
  const a = extractSpecs(line)
  const b = extractSpecs(candidate)
  const conflicts: string[] = []

  for (const [key, label] of SPEC_LABELS) {
    if (a[key].size === 0 || b[key].size === 0) continue
    const shared = [...a[key]].some((value) => b[key].has(value))
    if (!shared) {
      conflicts.push(`${label} ${[...a[key]].join('/')} vs ${[...b[key]].join('/')}`)
    }
  }

  return conflicts
}

/**
 * Spec categories where the line and the candidate state the same value.
 *
 * The mirror of `specConflicts`, and it earns its place: "12/2" appearing in
 * both is far stronger evidence than the same weight of ordinary word overlap,
 * because it is the part of the description a contractor never gets wrong.
 * Rewarding only the absence of conflict would leave that evidence on the floor.
 */
export function specAgreements(line: string, candidate: string): string[] {
  const a = extractSpecs(line)
  const b = extractSpecs(candidate)
  const agreements: string[] = []

  for (const [key, label] of SPEC_LABELS) {
    if (a[key].size === 0 || b[key].size === 0) continue
    const shared = [...a[key]].filter((value) => b[key].has(value))
    if (shared.length > 0) agreements.push(`${label} ${shared.join('/')}`)
  }

  return agreements
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Where each signal starts before adjustment. Order follows 6.4. */
const BASE_SCORE: Record<CandidateSource, number> = {
  correction: 0.99,
  mpn: 0.96,
  sku: 0.95,
  upc: 0.94,
  semantic: 0.0, // taken from rawScore
  trigram: 0.0,
}

function sameManufacturer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const left = norm(a)
  const right = norm(b)
  return left === right || left.includes(right) || right.includes(left)
}

export type ScoredCandidate = {
  candidate: MatchCandidate
  confidence: number
  reasoning: string
  conflicts: string[]
}

export function scoreCandidate(line: MatchLine, candidate: MatchCandidate): ScoredCandidate {
  const lineText = line.description ?? line.rawText
  const reasons: string[] = []

  let score: number
  switch (candidate.source) {
    case 'correction': {
      const reinforced = candidate.timesReinforced ?? 1
      score = BASE_SCORE.correction
      reasons.push(
        reinforced > 1
          ? `A rep has matched this wording to this product ${reinforced} times before`
          : 'A rep matched this wording to this product before',
      )
      break
    }
    case 'mpn':
      score = BASE_SCORE.mpn
      reasons.push(`Manufacturer part number ${candidate.manufacturerPartNumber} matches exactly`)
      break
    case 'sku':
      score = BASE_SCORE.sku
      reasons.push(`Catalogue SKU ${candidate.sku} matches exactly`)
      break
    case 'upc':
      score = BASE_SCORE.upc
      reasons.push(`UPC ${candidate.upc} matches exactly`)
      break
    case 'semantic':
    case 'trigram':
      // Blended below, from two views of the same evidence.
      score = 0
      break
  }

  const overlap = descriptionOverlap(lineText, candidate.description)

  // A prior correction is the top signal and nothing corroborates it further
  // (6.8). Letting the bonuses below apply to it would only push it into the
  // clamp alongside an exact part-number match and lose the ordering the PRD
  // asks for. A contradicted spec still demotes it, further down.
  const corroborate = candidate.source !== 'correction'

  if (candidate.source === 'semantic' || candidate.source === 'trigram') {
    // Raw similarity and token overlap are averaged rather than one damping the
    // other. Trigram similarity is structurally low whenever the catalogue
    // description is longer than the request -- "12/2 MC cable" against "12/2
    // MC cable with ground, 250ft roll" scores 0.39 even though it is exactly
    // right -- and catalogue descriptions are nearly always the longer of the
    // two. Jaccard overlap is length-normalised and does not suffer that, so
    // the pair together reads a match far better than either alone.
    const raw = candidate.rawScore ?? 0
    score = raw * 0.5 + overlap * 0.5
    reasons.push(
      candidate.source === 'semantic'
        ? `Description is a close match (${Math.round(raw * 100)}% similar)`
        : `Description text overlaps (${Math.round(raw * 100)}% similar)`,
    )
    if (overlap > 0.5) reasons.push('Wording lines up closely')
  }

  if (corroborate && sameManufacturer(line.manufacturer, candidate.manufacturer)) {
    score += 0.02
    reasons.push(`Same manufacturer (${candidate.manufacturer})`)
  } else if (corroborate && line.manufacturer && candidate.manufacturer) {
    score -= 0.05
    reasons.push(`Different manufacturer (asked for ${line.manufacturer}, this is ${candidate.manufacturer})`)
  }

  // A contradicted specification is the expensive failure. Even an exact part
  // number match drops out of the high band when the size disagrees, because
  // one of the two readings is wrong and a person should say which.
  const conflicts = specConflicts(lineText, candidate.description)
  if (conflicts.length > 0) {
    score *= 0.55
    reasons.push(`Specification differs: ${conflicts.join('; ')}`)
  } else {
    // Agreement on the numbers is worth more than its length in words, and is
    // capped so it lifts a plausible match rather than manufacturing one.
    const agreements = corroborate ? specAgreements(lineText, candidate.description) : []
    if (agreements.length > 0) {
      score += Math.min(0.15, agreements.length * 0.12)
      reasons.push(`Specification matches: ${agreements.join(', ')}`)
    }
  }

  // Corrections clamp above everything else, so a confirmed one always sorts
  // ahead of an exact part number rather than tying with it.
  const ceiling = candidate.source === 'correction' ? 0.995 : 0.98

  return {
    candidate,
    confidence: Math.max(0, Math.min(ceiling, Math.round(score * 1000) / 1000)),
    reasoning: reasons.join('. '),
    conflicts,
  }
}

export function bandFor(confidence: number, thresholds: ConfidenceThresholds): ConfidenceBand {
  if (confidence >= thresholds.high) return 'high'
  if (confidence >= thresholds.medium) return 'medium'
  if (confidence >= thresholds.low) return 'low'
  return 'no_match'
}

/**
 * Picks the winner and packages the runners-up.
 *
 * Alternatives are returned for anything below high confidence, so the review
 * screen always has something to offer instead of a dead end (6.4).
 */
export function matchLine(
  line: MatchLine,
  candidates: MatchCandidate[],
  thresholds: ConfidenceThresholds = DEFAULT_THRESHOLDS,
): MatchResult {
  if (candidates.length === 0) {
    return {
      productId: null,
      confidence: 0,
      band: 'no_match',
      method: 'none',
      reasoning: 'Nothing in the catalogue matched this line',
      alternatives: [],
      flagReasons: ['no_match'],
    }
  }

  // One entry per product: the same product can arrive from several searches,
  // and the strongest signal for it is the one that counts.
  const best = new Map<string, ScoredCandidate>()
  for (const candidate of candidates) {
    const scored = scoreCandidate(line, candidate)
    const existing = best.get(candidate.productId)
    if (!existing || scored.confidence > existing.confidence) {
      best.set(candidate.productId, scored)
    }
  }

  const ranked = [...best.values()].sort((a, b) => b.confidence - a.confidence)
  const winner = ranked[0]
  const band = bandFor(winner.confidence, thresholds)

  const flagReasons: string[] = []
  if (band === 'low' || band === 'no_match') flagReasons.push(band === 'low' ? 'low_confidence' : 'no_match')
  if (winner.conflicts.length > 0) flagReasons.push('spec_conflict')

  // Two candidates that are equally good is itself a reason to ask.
  const runnerUp = ranked[1]
  if (runnerUp && winner.confidence - runnerUp.confidence < 0.03 && band !== 'no_match') {
    flagReasons.push('ambiguous')
  }

  const toAlternative = (scored: ScoredCandidate): MatchAlternative => ({
    product_id: scored.candidate.productId,
    sku: scored.candidate.sku,
    description: scored.candidate.description,
    confidence: scored.confidence,
    method: scored.candidate.source,
    reasoning: scored.reasoning,
  })

  // Below `no_match` the line carries no product, so the winner is not the
  // match -- but it must still be offered. Slicing from 1 here would drop the
  // best candidate we found on the floor and tell the rep nothing matched,
  // which is the worst of both: no answer and no lead.
  const alternatives: MatchAlternative[] =
    band === 'high' && !flagReasons.includes('ambiguous')
      ? []
      : ranked.slice(band === 'no_match' ? 0 : 1, band === 'no_match' ? 5 : 6).map(toAlternative)

  return {
    productId: band === 'no_match' ? null : winner.candidate.productId,
    confidence: winner.confidence,
    band,
    method: winner.candidate.source,
    reasoning: winner.reasoning,
    alternatives,
    flagReasons,
  }
}
