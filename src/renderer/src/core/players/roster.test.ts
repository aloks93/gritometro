import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createPlayer } from './players'
import { clashingCodes, findByCode, mergeRoster, normalizeCode, parseCsv, rowsToRoster } from './roster'
import { readXlsxRows } from './xlsx'
import { screamTitle, SCREAM_TITLES, topScreamers } from '../game/leaderboard'

/** Builds a zip in memory (deflated entries, like Excel writes them) */
function zip(files: Record<string, string>): ArrayBuffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = deflateRawSync(Buffer.from(text))
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt16LE(nameBuf.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBuf)
    parts.push(local, nameBuf, data)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  const all = Buffer.concat([...parts, cd, end])
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength)
}

describe('roster import', () => {
  it('reads the first sheet of an xlsx with shared and inline strings', async () => {
    const book = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Invitados" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Nombre completo</t></si><si><t>Código</t></si><si><t>Edad</t></si><si><r><t>Luna </t></r><r><t>P&amp;érez</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1001</v></c><c r="C2"><v>8</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>Mateo</t></is></c><c r="C3"><v>7</v></c></row></sheetData></worksheet>'
    })
    const rows = await readXlsxRows(book)
    expect(rows).toEqual([
      ['Nombre completo', 'Código', 'Edad'],
      ['Luna P&érez', '1001', '8'],
      ['Mateo', '', '7']
    ])
    const { entries } = rowsToRoster(rows)
    expect(entries).toEqual([
      { name: 'Luna P&érez', code: '1001', age: 8 },
      { name: 'Mateo', code: undefined, age: 7 }
    ])
  })

  it('parses Spanish-Excel CSV with headers in any order and a surname column', () => {
    const rows = parseCsv('﻿Edad;Apellido;Nombre;N° empleado\r\n8;Pérez;Luna;"0012"\r\n;;;\r\n7 años;Gómez;Mateo;13\r\n')
    const { entries, skipped } = rowsToRoster(rows)
    expect(skipped).toBe(0)
    expect(entries).toEqual([
      { name: 'Luna Pérez', code: '0012', age: 8 },
      { name: 'Mateo Gómez', code: '13', age: 7 }
    ])
  })

  it('assumes name, code, age without a header and reports duplicate codes', () => {
    const res = rowsToRoster(parseCsv('Ana,5,6\nBeto,5,9\n,7,4'))
    expect(res.entries).toEqual([{ name: 'Beto', code: '5', age: 9 }])
    expect(res.duplicateCodes).toEqual(['5'])
    expect(res.skipped).toBe(1)
  })

  it('merges by code keeping photo and monster, and by name for players without code', () => {
    const luna = { ...createPlayer('Luna'), code: '7', photo: 'data:x' }
    const tomi = createPlayer('Tomi')
    const res = mergeRoster([luna, tomi], [
      { name: 'Luna Pérez', code: '007', age: 8 },
      { name: 'tomi', code: '9', age: 6 },
      { name: 'Nueva', code: '10' }
    ])
    expect(res.added).toBe(1)
    expect(res.updated).toBe(2)
    expect(res.players[0]).toMatchObject({ id: luna.id, name: 'Luna Pérez', photo: 'data:x', avatar: luna.avatar, age: 8 })
    expect(res.players[1]).toMatchObject({ id: tomi.id, code: '9' })
    expect(res.players[2]).toMatchObject({ name: 'Nueva', code: '10' })
  })

  it('finds badges ignoring leading zeros and flags clashes', () => {
    const ps = [{ ...createPlayer('A'), code: '0042' }, { ...createPlayer('B'), code: '42' }, { ...createPlayer('C'), code: 'X1' }]
    expect(normalizeCode(' 0042 ')).toBe('42')
    expect(findByCode(ps, '42')?.name).toBe('A')
    expect(findByCode(ps, 'x1')?.name).toBe('C')
    expect(findByCode(ps, '')).toBeUndefined()
    expect([...clashingCodes(ps)]).toEqual(['42'])
  })
})

describe('leaderboard', () => {
  it('maps every score to one title, lowest to highest', () => {
    expect(screamTitle(0).emoji).toBe('🍼')
    expect(screamTitle(14.9).emoji).toBe('🍼')
    expect(screamTitle(50).label).toBe('Monstruo con hipo')
    expect(screamTitle(100).label).toBe(SCREAM_TITLES[SCREAM_TITLES.length - 1].label)
    expect(SCREAM_TITLES.map((t) => t.min)).toEqual([...SCREAM_TITLES.map((t) => t.min)].sort((a, b) => a - b))
  })

  it('keeps only the best scream per player and skips precision screams', () => {
    const a = { ...createPlayer('Ana'), id: 'a', code: '1' }
    const b = { ...createPlayer('Beto'), id: 'b' }
    const recs = [
      { playerId: 'a', playerName: 'Ana', score: 40, modeId: 'ranking' },
      { playerId: 'b', playerName: 'Beto', score: 60, modeId: 'ranking' },
      { playerId: 'a', playerName: 'Ana', score: 70, modeId: 'badge' },
      { playerId: 'b', playerName: 'Beto', score: 99, modeId: 'target' },
      // Same badge after the list was re-imported under a new id
      { playerId: 'old', playerCode: '001', playerName: 'Ana vieja', score: 80, modeId: 'ranking' }
    ]
    const top = topScreamers(recs, [a, b])
    expect(top.map((e) => [e.name, e.score])).toEqual([
      ['Ana', 80],
      ['Beto', 60]
    ])
    expect(topScreamers(recs, [a, b], 1)).toHaveLength(1)
  })
})
