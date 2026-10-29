import { createPlayer, type Player } from './players'

/** One guest from the spreadsheet: full name, employee badge code, age */
export interface RosterEntry {
  name: string
  code?: string
  age?: number
}

export interface RosterParse {
  entries: RosterEntry[]
  /** Rows with data but no name */
  skipped: number
  /** Codes that appear more than once in the file (the last row wins) */
  duplicateCodes: string[]
}

/** Badge codes compare without spaces, and numerically when both are numbers ("007" = "7") */
export function normalizeCode(code: string | undefined): string {
  const c = (code ?? '').replace(/\s+/g, '').toUpperCase()
  return /^\d+$/.test(c) ? String(Number(c)) : c
}

export function findByCode(players: Player[], code: string): Player | undefined {
  const key = normalizeCode(code)
  return key ? players.find((p) => normalizeCode(p.code) === key) : undefined
}

/** Codes used by more than one player (so the badge login would be ambiguous) */
export function clashingCodes(players: Player[]): Set<string> {
  const seen = new Map<string, number>()
  players.forEach((p) => {
    const k = normalizeCode(p.code)
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1)
  })
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k))
}

/** CSV with `;`, `,` or tab separators (Excel in Spanish saves `;`), quoted fields, BOM */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = [';', '\t', ','].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ';')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) {
      row.push(cell.trim())
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell.trim())
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell.trim())
    rows.push(row)
  }
  return rows
}

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

type Column = 'name' | 'surname' | 'code' | 'age'

function headerColumn(cell: string): Column | null {
  const h = fold(cell)
  if (!h) return null
  if (/apellido|surname|last ?name/.test(h)) return 'surname'
  if (/nombre|name|invitad|jugador|participante/.test(h)) return 'name'
  if (/edad|age|anos/.test(h)) return 'age'
  if (/cod|carnet|credencial|empleado|numero|^n[°ºo.]|^#|^id$|legajo|badge/.test(h)) return 'code'
  return null
}

function parseAge(cell: string | undefined): number | undefined {
  const n = parseInt((cell ?? '').replace(',', '.'), 10)
  return Number.isFinite(n) && n > 0 && n < 120 ? n : undefined
}

/**
 * Turns spreadsheet rows into guests. A header row ("Nombre", "Código", "Edad", optionally
 * "Apellido") is recognized in any order; without one the columns are name, code, age.
 */
export function rowsToRoster(rows: string[][]): RosterParse {
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''))
  let cols: Partial<Record<Column, number>> = { name: 0, code: 1, age: 2 }
  let body = nonEmpty
  const header = nonEmpty[0]?.map(headerColumn) ?? []
  if (header.some((c) => c !== null)) {
    cols = {}
    header.forEach((c, i) => {
      if (c && cols[c] === undefined) cols[c] = i
    })
    body = nonEmpty.slice(1)
  }

  const byCode = new Map<string, number>()
  const duplicateCodes = new Set<string>()
  const entries: RosterEntry[] = []
  let skipped = 0
  for (const r of body) {
    const cell = (c: Column): string => (cols[c] === undefined ? '' : (r[cols[c]!] ?? '').trim())
    const name = [cell('name'), cell('surname')].filter(Boolean).join(' ').replace(/\s+/g, ' ')
    if (!name) {
      skipped++
      continue
    }
    const code = cell('code').replace(/\.0+$/, '') || undefined
    const entry: RosterEntry = { name, code, age: parseAge(cell('age')) }
    const key = normalizeCode(code)
    if (key && byCode.has(key)) {
      duplicateCodes.add(code!)
      entries[byCode.get(key)!] = entry
      continue
    }
    if (key) byCode.set(key, entries.length)
    entries.push(entry)
  }
  return { entries, skipped, duplicateCodes: [...duplicateCodes] }
}

/**
 * Adds the guests to the player list. A guest whose code (or, for players without a code,
 * whose name) already exists updates that player and keeps its photo and monster.
 */
export function mergeRoster(players: Player[], entries: RosterEntry[]): { players: Player[]; added: number; updated: number } {
  const next = [...players]
  let added = 0
  let updated = 0
  for (const e of entries) {
    const key = normalizeCode(e.code)
    let i = key ? next.findIndex((p) => normalizeCode(p.code) === key) : -1
    if (i < 0) i = next.findIndex((p) => !normalizeCode(p.code) && fold(p.name) === fold(e.name))
    if (i >= 0) {
      next[i] = { ...next[i], name: e.name, code: e.code ?? next[i].code, age: e.age ?? next[i].age }
      updated++
    } else {
      next.push({ ...createPlayer(e.name, e.age), code: e.code })
      added++
    }
  }
  return { players: next, added, updated }
}

/** Template the user can open in Excel and fill in */
export const ROSTER_TEMPLATE_CSV = '﻿Nombre completo;Código;Edad\r\nLuna Pérez;1001;8\r\nMateo Gómez;1002;7\r\n'
