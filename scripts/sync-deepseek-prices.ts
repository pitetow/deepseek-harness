/**
 * Sync DeepSeek official API prices into a generated client module at build
 * time. Fetches the pricing page (Docusaurus SSR HTML), parses the base and
 * peak/off-peak tables plus the peak-hour windows and the effective date, and
 * rewrites `packages/client/ui-conversation/src/client/deepseek-prices.generated.ts`.
 * A fetch or parse failure keeps the last committed prices and warns — the
 * generated module is the committed fallback, so builds stay offline-safe.
 *
 * Ownership: the official pricing page is the only source of truth; the
 * generated module is consumed by the conversation StatsLine cost estimate.
 */

import { writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const GENERATED_PATH = resolve(
  fileURLToPath(new URL('..', import.meta.url)),
  'packages/client/ui-conversation/src/client/deepseek-prices.generated.ts',
)

/** One model's per-1M-token prices, in CNY (元). */
export interface DeepSeekPriceEntry {
  readonly inputCacheHitYuanPerM: number
  readonly inputCacheMissYuanPerM: number
  readonly outputYuanPerM: number
}

/** Parsed official price table. */
export interface DeepSeekPrices {
  readonly sourceUrl: string
  /** ISO instant of the last successful sync. */
  readonly fetchedAt: string
  /** Beijing-time peak windows ([startHour, endHour), hour in Beijing time). */
  readonly peakHours: readonly { readonly start: number; readonly end: number }[]
  /** Epoch ms of the Beijing-time instant peak/off-peak pricing takes effect. */
  readonly effectiveFromMs: number
  /** Prices before `effectiveFromMs` (Beijing time). */
  readonly base: Readonly<Record<string, DeepSeekPriceEntry>>
  /** Off-peak prices from `effectiveFromMs`. */
  readonly offPeak: Readonly<Record<string, DeepSeekPriceEntry>>
  /** Peak prices from `effectiveFromMs` during `peakHours`. */
  readonly peak: Readonly<Record<string, DeepSeekPriceEntry>>
}

/** Extract `<table>` blocks, each as rows of stripped cell texts. */
export function tablesOf(html: string): string[][][] {
  const tables: string[][][] = []
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi
  for (const table of html.matchAll(tableRe)) {
    const body = table[1]
    if (body === undefined) continue
    const rows: string[][] = []
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
    for (const row of body.matchAll(rowRe)) {
      const cellsBody = row[1]
      if (cellsBody === undefined) continue
      const cells: string[] = []
      const cellRe = /<t[h d][^>]*>([\s\S]*?)<\/t[h d]>/gi
      for (const cell of cellsBody.matchAll(cellRe)) {
        cells.push((cell[1] ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
      }
      if (cells.length > 0) rows.push(cells)
    }
    tables.push(rows)
  }
  return tables
}

/** Parse a price cell like `0.02元` / `1元` / `3.0元` into a number. */
function priceOf(cell: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)/.exec(cell)
  return match === null ? undefined : Number(match[1])
}

/**
 * Parse the official pricing page into the price table, or null when the page
 * structure no longer matches (the parser then keeps the last generated file).
 *
 * The page's SSR HTML carries two price sources: the base prices live at the
 * tail of the model-overview table (rows headed `价格(1)` with one price cell
 * per model column), and the peak/off-peak prices are their own table with
 * `空闲时段`/`高峰时段` rows. Peak hours and the effective instant come from
 * the prose paragraph between them.
 * @param html - the pricing page's SSR HTML.
 * @returns the parsed table, or null.
 */
export function parseDeepSeekPricingPage(html: string): DeepSeekPrices | null {
  const tables = tablesOf(html)
  // Model-overview table: header `模型 | <model> | <model>`; base prices are its
  // trailing rows (first cell 价格(1), second the metric name).
  const overviewTable = tables.find(rows =>
    rows[0]?.[0]?.includes('模型') && rows[0].slice(1).every(cell => /deepseek-/i.test(cell)))
  // Peak/off-peak table: header `模型 | 命中 | 未命中 | 输出` with 空闲/高峰 rows.
  const peakTable = tables.find(rows => rows.some(row => row[0]?.includes('空闲时段') || row[0]?.includes('高峰时段')))
  if (overviewTable === undefined || peakTable === undefined) return null

  const base: Record<string, DeepSeekPriceEntry> = {}
  const header = overviewTable[0]
  if (header === undefined) return null
  const models = header.slice(1)
  // The `价格(1)` price rows: the metric cell (缓存命中/缓存未命中/输出) is the
  // first cell matching the keyword — the leading `价格(1)` cell is rowspan
  // only on the first row, so the metric is not at a fixed index. The cells
  // after the metric are the per-model prices in header column order.
  const metricRow = (predicate: (cell: string) => boolean): (number | undefined)[] | undefined => {
    const row = overviewTable.find(cells => cells.some(predicate))
    if (row === undefined) return undefined
    const metricIndex = row.findIndex(predicate)
    return row.slice(metricIndex + 1).map(cell => priceOf(cell))
  }
  // Strict metric labels: the overview table also carries feature rows like
  // `输出长度 最大 384K`, so the output metric is matched by its full label.
  const [hits, misses, outputs] = [
    metricRow(cell => cell.includes('缓存命中')),
    metricRow(cell => cell.includes('缓存未命中')),
    metricRow(cell => cell.includes('百万tokens输出')),
  ]
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    if (model === undefined) continue
    const [hit, miss, out] = [hits?.[i], misses?.[i], outputs?.[i]]
    if (hit === undefined || miss === undefined || out === undefined) continue
    base[model.toLowerCase()] = { inputCacheHitYuanPerM: hit, inputCacheMissYuanPerM: miss, outputYuanPerM: out }
  }
  if (Object.keys(base).length === 0) return null

  const offPeak: Record<string, DeepSeekPriceEntry> = {}
  const peak: Record<string, DeepSeekPriceEntry> = {}
  // The peak table's model cell is rowspan across its 空闲/高峰 pair, so a row
  // may omit it; track the current model from the row that carries it.
  let currentModel: string | undefined
  for (const row of peakTable) {
    const periodIndex = row.findIndex(cell => cell.includes('时段'))
    if (periodIndex === -1) continue
    const lead = row[0] ?? ''
    if (!lead.includes('时段') && !lead.includes('缓存') && lead !== '模型') {
      currentModel = lead.toLowerCase()
    }
    if (currentModel === undefined) continue
    const period = row[periodIndex]
    if (period === undefined) continue
    const [hit, miss, out] = row.slice(periodIndex + 1).map(cell => priceOf(cell))
    if (hit === undefined || miss === undefined || out === undefined) continue
    const entry: DeepSeekPriceEntry = { inputCacheHitYuanPerM: hit, inputCacheMissYuanPerM: miss, outputYuanPerM: out }
    if (period.includes('空闲')) offPeak[currentModel] = entry
    else if (period.includes('高峰')) peak[currentModel] = entry
  }
  if (Object.keys(peak).length === 0 || Object.keys(offPeak).length === 0) return null

  // Peak windows: "高峰时段为北京时间 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）".
  const windows: { start: number; end: number }[] = []
  const windowRe = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g
  for (const match of html.matchAll(windowRe)) {
    windows.push({ start: Number(match[1]), end: Number(match[3]) })
  }
  const peakHours = windows.length > 0 ? windows : [{ start: 9, end: 12 }, { start: 14, end: 18 }]

  // Effective instant: "新价格将于北京时间 2026 年 8 月 17 日 00:00 开始生效".
  let effectiveFromMs = Date.UTC(2026, 7, 16, 16, 0, 0) // 2026-08-17T00:00:00+08:00
  const dateRe = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2}))?/g
  for (const match of html.matchAll(dateRe)) {
    const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
    const hour = match[4] === undefined ? 0 : Number(match[4])
    const minute = match[5] === undefined ? 0 : Number(match[5])
    if (year >= 2024) effectiveFromMs = Date.UTC(year, month - 1, day, hour - 8, minute, 0)
  }

  return {
    sourceUrl: PRICING_URL,
    fetchedAt: new Date().toISOString(),
    peakHours,
    effectiveFromMs,
    base,
    offPeak,
    peak,
  }
}

/** Render the generated TypeScript module. */
export function renderPricesModule(prices: DeepSeekPrices): string {
  const entry = (e: DeepSeekPriceEntry): string =>
    `{ inputCacheHitYuanPerM: ${e.inputCacheHitYuanPerM}, inputCacheMissYuanPerM: ${e.inputCacheMissYuanPerM}, outputYuanPerM: ${e.outputYuanPerM} }`
  const record = (r: Readonly<Record<string, DeepSeekPriceEntry>>): string =>
    `{\n${Object.entries(r).map(([model, e]) => `    '${model}': ${entry(e)},`).join('\n')}\n  }`
  return `// GENERATED by scripts/sync-deepseek-prices.ts — do not edit by hand.
// Source: ${prices.sourceUrl}
// Fetched at: ${prices.fetchedAt}

/** One model's per-1M-token prices, in CNY (元). */
export interface DeepSeekPriceEntry {
  readonly inputCacheHitYuanPerM: number
  readonly inputCacheMissYuanPerM: number
  readonly outputYuanPerM: number
}

/** Official DeepSeek price table, synced at build time. */
export interface DeepSeekPrices {
  readonly sourceUrl: string
  /** ISO instant of the last successful sync. */
  readonly fetchedAt: string
  /** Beijing-time peak windows ([startHour, endHour), hour in Beijing time). */
  readonly peakHours: readonly { readonly start: number; readonly end: number }[]
  /** Epoch ms of the Beijing-time instant peak/off-peak pricing takes effect. */
  readonly effectiveFromMs: number
  /** Prices before \`effectiveFromMs\` (Beijing time). */
  readonly base: Readonly<Record<string, DeepSeekPriceEntry>>
  /** Off-peak prices from \`effectiveFromMs\`. */
  readonly offPeak: Readonly<Record<string, DeepSeekPriceEntry>>
  /** Peak prices from \`effectiveFromMs\` during \`peakHours\`. */
  readonly peak: Readonly<Record<string, DeepSeekPriceEntry>>
}

export const DEEPSEEK_PRICES: DeepSeekPrices = {
  sourceUrl: '${prices.sourceUrl}',
  fetchedAt: '${prices.fetchedAt}',
  peakHours: [${prices.peakHours.map(w => `{ start: ${w.start}, end: ${w.end} }`).join(', ')}],
  effectiveFromMs: ${prices.effectiveFromMs},
  base: ${record(prices.base)},
  offPeak: ${record(prices.offPeak)},
  peak: ${record(prices.peak)},
}
`
}

/**
 * Whether the freshly parsed table differs from the committed generated module.
 * The committed file is the build-to-build baseline: identical prices leave it
 * untouched (fetchedAt stays at the last observation that changed something),
 * so a routine build does not dirty the working tree.
 * @param prices - the freshly parsed table.
 * @returns true when the committed module already carries these prices.
 */
async function pricesUnchanged(prices: DeepSeekPrices): Promise<boolean> {
  if (!existsSync(GENERATED_PATH)) return false
  try {
    const imported = await import(`${pathToFileURL(GENERATED_PATH).href}?t=${Date.now()}`) as { DEEPSEEK_PRICES?: DeepSeekPrices }
    const previous = imported.DEEPSEEK_PRICES
    if (previous === undefined) return false
    const signature = (p: DeepSeekPrices): string => JSON.stringify({
      base: p.base, offPeak: p.offPeak, peak: p.peak, peakHours: p.peakHours, effectiveFromMs: p.effectiveFromMs,
    })
    return signature(prices) === signature(previous)
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  let html: string
  try {
    const response = await fetch(PRICING_URL, { headers: { 'User-Agent': 'dsh-price-sync/0.1' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    html = await response.text()
  } catch (error) {
    const fallback = existsSync(GENERATED_PATH)
    console.warn(`[sync-deepseek-prices] fetch failed (${String(error)}); ${fallback ? 'keeping last generated prices' : 'no generated prices present'}`)
    if (!fallback) process.exitCode = 1
    return
  }
  const prices = parseDeepSeekPricingPage(html)
  if (prices === null) {
    const fallback = existsSync(GENERATED_PATH)
    console.warn(`[sync-deepseek-prices] parse failed; ${fallback ? 'keeping last generated prices' : 'no generated prices present'}`)
    if (!fallback) process.exitCode = 1
    return
  }
  if (await pricesUnchanged(prices)) {
    console.log(`[sync-deepseek-prices] prices unchanged (${Object.keys(prices.base).length} models)`)
    return
  }
  writeFileSync(GENERATED_PATH, renderPricesModule(prices))
  console.log(`[sync-deepseek-prices] synced ${Object.keys(prices.base).length} models from ${PRICING_URL}`)
}

// Direct execution (tsx scripts/sync-deepseek-prices.ts); imported by the unit spec.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
