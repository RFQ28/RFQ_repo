import Papa from 'papaparse'
import ExcelJS from 'exceljs'

export type TabularSheet = {
  name: string | null
  headers: string[]
  /** Row objects keyed by header. Row numbers are 1-based over data rows. */
  rows: Record<string, string>[]
}

export class UnsupportedFileError extends Error {}

/** Trailing spaces and BOMs in export headers are the norm, not the exception. */
export function normalizeHeader(header: string): string {
  return header.replace(/^﻿/, '').trim()
}

function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map((raw, index) => {
    const base = normalizeHeader(raw) || `column_${index + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}_${count + 1}`
  })
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const cell = value as { text?: unknown; result?: unknown; richText?: { text: string }[] }
    if (Array.isArray(cell.richText)) return cell.richText.map((r) => r.text).join('').trim()
    if (cell.text !== undefined) return cellToString(cell.text)
    if (cell.result !== undefined) return cellToString(cell.result)
  }
  return String(value).trim()
}

export function parseCsv(content: string): TabularSheet {
  const parsed = Papa.parse<string[]>(content, {
    skipEmptyLines: 'greedy',
    // Everything stays a string here; coercion happens in validation, where a
    // bad value can be reported against a named field instead of vanishing.
  })

  const table = parsed.data.filter((row) => row.some((cell) => cell !== ''))
  if (table.length === 0) return { name: null, headers: [], rows: [] }

  const headers = dedupeHeaders(table[0])
  const rows = table.slice(1).map((row) => {
    const record: Record<string, string> = {}
    headers.forEach((header, i) => {
      record[header] = (row[i] ?? '').trim()
    })
    return record
  })

  return { name: null, headers, rows }
}

export async function parseXlsx(buffer: ArrayBuffer): Promise<TabularSheet> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  const sheet = workbook.worksheets.find((w) => w.rowCount > 1) ?? workbook.worksheets[0]
  if (!sheet) return { name: null, headers: [], rows: [] }

  const matrix: string[][] = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = []
    // `values` is 1-based with a leading hole, so index 0 is dropped.
    const values = row.values as unknown[]
    for (let i = 1; i < values.length; i++) cells.push(cellToString(values[i]))
    matrix.push(cells)
  })

  const table = matrix.filter((row) => row.some((cell) => cell !== ''))
  if (table.length === 0) return { name: sheet.name, headers: [], rows: [] }

  const width = Math.max(...table.map((r) => r.length))
  const headers = dedupeHeaders(
    Array.from({ length: width }, (_, i) => table[0][i] ?? `column_${i + 1}`),
  )

  const rows = table.slice(1).map((row) => {
    const record: Record<string, string> = {}
    headers.forEach((header, i) => {
      record[header] = row[i] ?? ''
    })
    return record
  })

  return { name: sheet.name, headers, rows }
}

/**
 * Reads a catalogue export into rows of strings.
 *
 * .xls (the old binary format) is deliberately not handled: the distributors we
 * are onboarding can export .xlsx or .csv, and guessing at BIFF here would give
 * us a silent-corruption path rather than a clear error.
 */
export async function readTabular(
  file: { name: string; buffer: ArrayBuffer },
): Promise<TabularSheet> {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''

  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    return parseCsv(new TextDecoder('utf-8').decode(file.buffer))
  }
  if (ext === 'xlsx' || ext === 'xlsm') {
    return parseXlsx(file.buffer)
  }
  if (ext === 'xls') {
    throw new UnsupportedFileError(
      'Legacy .xls files are not supported. Re-save the export as .xlsx or .csv and upload again.',
    )
  }
  throw new UnsupportedFileError(`Unsupported catalogue file type: .${ext}`)
}
