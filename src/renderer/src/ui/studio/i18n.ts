import { useLayoutEffect, type RefObject } from 'react'
import { EN, PATTERNS } from './i18n.en'

// Studio language. The studio is written in Spanish; in English mode a MutationObserver
// translates the rendered text (text nodes are what React writes, so JSX pieces map 1:1 to
// dictionary entries) plus title/placeholder attributes, confirm() dialogs, PDF reports and CSVs.

export type StudioLang = 'es' | 'en'
export type StudioLangPref = 'auto' | StudioLang

let current: StudioLang = 'es'

export function studioLang(): StudioLang {
  return current
}

export function resolveLang(pref: StudioLangPref | undefined): StudioLang {
  if (pref === 'es' || pref === 'en') return pref
  return (navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en'
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const COMPILED = PATTERNS.map(([es, en]) => {
  const parts = es.split(/\{(\d+)\}/)
  const order: number[] = []
  let re = '^'
  parts.forEach((p, i) => {
    if (i % 2) {
      re += '(.+?)'
      order.push(Number(p))
    } else re += escapeRe(p)
  })
  return { re: new RegExp(re + '$', 's'), order, en }
})

const SOLFEGE: Record<string, string> = { Do: 'C', Re: 'D', Mi: 'E', Fa: 'F', Sol: 'G', La: 'A', Si: 'B' }
const cache = new Map<string, string>()

/** Translates one piece of Spanish UI text (unchanged when unknown) */
export function translateText(text: string): string {
  // Multi-line tooltips: one entry per line
  if (text.trim().includes('\n')) return text.split('\n').map(translateText).join('\n')
  const t = text.replace(/\s+/g, ' ').trim()
  if (!/[A-Za-zÀ-ÿ]{2}/.test(t)) return text
  const hit = cache.get(t)
  if (hit !== undefined) return hit === t ? text : keepSpaces(text, hit)
  const out = translateCore(t, 0)
  if (cache.size > 5000) cache.clear()
  cache.set(t, out)
  return out === t ? text : keepSpaces(text, out)
}

function keepSpaces(original: string, translated: string): string {
  const lead = /^\s*/.exec(original)![0]
  const trail = /\s*$/.exec(original)![0]
  return lead + translated + trail
}

function translateCore(t: string, depth: number): string {
  const exact = EN[t]
  if (exact !== undefined) return exact
  if (depth > 4) return t
  for (const p of COMPILED) {
    const m = p.re.exec(t)
    if (!m) continue
    const vals: string[] = []
    p.order.forEach((idx, k) => (vals[idx] = m[k + 1]))
    return p.en.replace(/\{(\d+)\}/g, (_, i: string) => translateCore(vals[Number(i)] ?? '', depth + 1))
  }
  // Composite readings joined with " · " or "; " (descriptions, notes, report lines)
  for (const sep of [' · ', '; ']) {
    if (!t.includes(sep)) continue
    const parts = t.split(sep)
    const tr = parts.map((x) => translateCore(x, depth + 1))
    if (tr.some((x, i) => x !== parts[i])) return tr.join(sep)
  }
  const note = /^(Do|Re|Mi|Fa|Sol|La|Si)(#?)(-?\d)$/.exec(t)
  if (note) return SOLFEGE[note[1]] + note[2] + note[3]
  return t
}

// ---- DOM translation

// 'label' covers <optgroup> headings
const ATTRS = ['title', 'placeholder', 'aria-label', 'label']

function translateTextNode(n: Node): void {
  const parent = n.parentNode as Element | null
  if (parent && (parent.nodeName === 'TEXTAREA' || parent.nodeName === 'SCRIPT' || parent.nodeName === 'STYLE')) return
  const v = n.nodeValue ?? ''
  const t = translateText(v)
  if (t !== v) n.nodeValue = t
}

function translateAttrs(el: Element): void {
  for (const a of ATTRS) {
    const v = el.getAttribute(a)
    if (!v) continue
    const t = translateText(v)
    if (t !== v) el.setAttribute(a, t)
  }
}

export function translateTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return translateTextNode(root)
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return
  if (root.nodeType === Node.ELEMENT_NODE) translateAttrs(root as Element)
  const doc = root.ownerDocument ?? (root as Document)
  const w = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateTextNode(n)
    else translateAttrs(n as Element)
  }
}

/** Translates everything rendered under `ref` while `on`; also routes confirm() through it */
export function useStudioTranslation(on: boolean, ref: RefObject<HTMLElement>): void {
  // Layout effect: translate before the first paint so Spanish never flashes
  useLayoutEffect(() => {
    const root = ref.current
    if (!on || !root) return
    current = 'en'
    translateTree(root)
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') translateTextNode(m.target)
        else if (m.type === 'attributes') translateAttrs(m.target as Element)
        else m.addedNodes.forEach((n) => translateTree(n))
      }
    })
    obs.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })
    const confirm = window.confirm
    window.confirm = (msg?: string) => confirm.call(window, translateText(msg ?? ''))
    return () => {
      obs.disconnect()
      window.confirm = confirm
      current = 'es'
    }
  }, [on, ref])
}

/** English version of a generated report (PDF) when the studio is in English */
export function localizeHtml(html: string): string {
  if (current !== 'en') return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.documentElement.setAttribute('lang', 'en')
  translateTree(doc)
  return '<!doctype html>' + doc.documentElement.outerHTML
}

/** Translates the quoted cells of a semicolon CSV when the studio is in English */
export function localizeCsv(csv: string): string {
  if (current !== 'en') return csv
  return csv.replace(/"((?:[^"]|"")*)"/g, (_, cell: string) => `"${translateText(cell.replace(/""/g, '"')).replace(/"/g, '""')}"`)
}
