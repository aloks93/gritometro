/**
 * Minimal .xlsx reader: just enough to pull the cell text of the first sheet.
 * An .xlsx is a zip of XML files; entries are inflated with the platform's DecompressionStream
 * (Chromium and Node 18+), so no spreadsheet library is needed.
 */

interface ZipEntry {
  method: number
  compSize: number
  localOffset: number
}

function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // End of central directory: scan back over a possible trailing comment
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('El archivo no es un Excel (.xlsx) válido')
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  const entries = new Map<string, ZipEntry>()
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    entries.set(name, {
      method: view.getUint16(p + 10, true),
      compSize: view.getUint32(p + 20, true),
      localOffset: view.getUint32(p + 42, true)
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function readZipText(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const p = entry.localOffset
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true)
  const raw = bytes.slice(start, start + entry.compSize)
  if (entry.method === 0) return new TextDecoder().decode(raw)
  if (entry.method !== 8) throw new Error('Compresión de Excel no soportada')
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** All <t> runs of a string item joined (rich text splits one string into several runs) */
function textRuns(xml: string): string {
  let out = ''
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1])
  return out
}

function columnIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase()
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Path of the first sheet in workbook order (falls back to the first worksheet file) */
async function firstSheetPath(bytes: Uint8Array, entries: Map<string, ZipEntry>): Promise<string> {
  const wb = entries.get('xl/workbook.xml')
  const rels = entries.get('xl/_rels/workbook.xml.rels')
  if (wb && rels) {
    const rid = (await readZipText(bytes, wb)).match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1]
    const relsXml = await readZipText(bytes, rels)
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      if (rid && m[0].includes(`Id="${rid}"`)) {
        const target = m[0].match(/Target="([^"]+)"/)?.[1]
        if (target) return target.startsWith('/') ? target.slice(1) : `xl/${target}`
      }
    }
  }
  const sheets = [...entries.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()
  if (!sheets.length) throw new Error('El Excel no tiene hojas')
  return sheets[0]
}

/** Rows of the first sheet as text (empty cells are ''), in sheet order */
export async function readXlsxRows(data: ArrayBuffer): Promise<string[][]> {
  const bytes = new Uint8Array(data)
  const entries = readZipDirectory(bytes)
  const sst = entries.get('xl/sharedStrings.xml')
  const shared = sst ? [...(await readZipText(bytes, sst)).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1])) : []
  const path = await firstSheetPath(bytes, entries)
  const sheet = entries.get(path)
  if (!sheet) throw new Error('No se encontró la hoja del Excel')
  const xml = await readZipText(bytes, sheet)

  const rows: string[][] = []
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = []
    let next = 0
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]
      const body = cm[2] ?? ''
      const ref = attrs.match(/\br="([A-Z]+\d*)"/i)?.[1]
      const col = ref ? columnIndex(ref) : next
      next = col + 1
      const type = attrs.match(/\bt="([^"]+)"/)?.[1]
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      let text = ''
      if (type === 's') text = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') text = textRuns(body)
      else if (v !== undefined) text = decodeXml(v)
      while (row.length < col) row.push('')
      row[col] = text.trim()
    }
    rows.push(row)
  }
  return rows
}
