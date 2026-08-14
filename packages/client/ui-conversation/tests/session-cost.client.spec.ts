// Session-cost estimate unit spec: Beijing peak-hour and effective-date choice,
// model lookup, token totals, and the yuan math. Expected values derive from
// the generated price table, so an official price change never breaks the
// suite — the sync script updates the table, these tests follow it.
import { describe, expect, it } from 'vitest'
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { DEEPSEEK_PRICES, type DeepSeekPriceEntry } from '../src/client/deepseek-prices.generated.ts'
import {
  beijingHour, deepSeekPriceFor, estimateSessionCostYuan, formatBalance, formatYuan,
  isBeijingPeak, sessionModel, totalSessionTokens,
} from '../src/client/session-cost.ts'

/** Epoch ms for `hour` Beijing time on a fixed date (UTC+8, no DST). */
function beijingEpoch(hour: number): number {
  return Date.UTC(2026, 7, 20, hour - 8, 0, 0)
}

/** An hour outside every peak window (always exists: the windows cannot cover 0-23). */
const offPeakHour = Array.from({ length: 24 }, (_, hour) => hour)
  .find(hour => !DEEPSEEK_PRICES.peakHours.some(w => hour >= w.start && hour < w.end))!

/** First peak window; the generated table always carries the official pair. */
const firstWindow = DEEPSEEK_PRICES.peakHours[0]
if (firstWindow === undefined) throw new Error('generated price table has no peak windows')

/** First model key of a price record; the generated table is never empty. */
function firstModel(record: Readonly<Record<string, DeepSeekPriceEntry>>): string {
  const key = Object.keys(record)[0]
  if (key === undefined) throw new Error('generated price table is empty')
  return key
}

const USAGE: TokenUsageProjection = {
  uncachedInputTokens: 1_500_000,
  outputTokens: 500_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 0,
}

describe('session cost estimate', () => {
  it('converts an epoch to the Beijing wall-clock hour', () => {
    // 2026-08-20T02:00:00Z == Beijing 10:00; 00:00Z == Beijing 08:00.
    expect(beijingHour(Date.UTC(2026, 7, 20, 2, 0))).toBe(10)
    expect(beijingHour(Date.UTC(2026, 7, 20, 0, 0))).toBe(8)
  })

  it('flags the official peak windows by Beijing hour', () => {
    expect(isBeijingPeak(beijingEpoch(firstWindow.start + 1))).toBe(true)
    expect(isBeijingPeak(beijingEpoch(offPeakHour))).toBe(false)
  })

  it('uses base prices before the effective instant, peak/off-peak after', () => {
    const model = firstModel(DEEPSEEK_PRICES.base)
    const before = DEEPSEEK_PRICES.effectiveFromMs - 1_000
    expect(deepSeekPriceFor(model, before)).toBe(DEEPSEEK_PRICES.base[model])
    // 1s past the effective instant is Beijing 00:00 — inside no peak window.
    const afterOffPeak = DEEPSEEK_PRICES.effectiveFromMs + 1_000
    expect(deepSeekPriceFor(model, afterOffPeak)).toBe(DEEPSEEK_PRICES.offPeak[model])
    const afterPeak = beijingEpoch(firstWindow.start + 1)
    expect(deepSeekPriceFor(model, afterPeak)).toBe(DEEPSEEK_PRICES.peak[model])
  })

  it('returns undefined for a model without a price entry', () => {
    expect(deepSeekPriceFor('no-such-model', Date.now())).toBeUndefined()
  })

  it('reads the most recent assistant model from request configs', () => {
    const nodes = [
      { kind: 'tool-result', seq: 1, time: 1 } as unknown as ConversationNode,
      { kind: 'assistant', seq: 2, time: 2, turn: 1, step: 1, blocks: [] } as unknown as ConversationNode,
      { kind: 'assistant', seq: 3, time: 3, turn: 1, step: 2, blocks: [], requestConfig: { provider: 'deepseek', model: 'deepseek-v4-flash' } } as unknown as ConversationNode,
    ]
    expect(sessionModel(nodes)).toBe('deepseek-v4-flash')
    expect(sessionModel([{ kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1, blocks: [] } as unknown as ConversationNode])).toBeUndefined()
  })

  it('estimates the spend from the four token buckets at the in-force price', () => {
    const model = firstModel(DEEPSEEK_PRICES.offPeak)
    const price = DEEPSEEK_PRICES.offPeak[model]
    if (price === undefined) throw new Error('generated price table is empty')
    const expected = 1.5 * price.inputCacheMissYuanPerM + 1 * price.inputCacheHitYuanPerM + 0.5 * price.outputYuanPerM
    expect(estimateSessionCostYuan(USAGE, DEEPSEEK_PRICES.effectiveFromMs + 1_000, model)).toBeCloseTo(expected)
    expect(estimateSessionCostYuan(USAGE, Date.now(), 'no-such-model')).toBeUndefined()
    expect(estimateSessionCostYuan(USAGE, Date.now(), undefined)).toBeUndefined()
  })

  it('sums the four buckets and formats yuan compactly', () => {
    expect(totalSessionTokens({ uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 100 })).toBe(205)
    expect(formatYuan(0.5)).toBe('0.500')
    expect(formatYuan(1.5)).toBe('1.50')
    expect(formatYuan(12.345)).toBe('12.35')
  })

  it('formats the account balance with the CNY symbol when reported', () => {
    expect(formatBalance(110.47, 'CNY')).toBe('¥110.47')
    expect(formatBalance(12.34, 'CNY')).toBe('¥12.34')
    expect(formatBalance(123.4, 'CNY')).toBe('¥123.40')
    expect(formatBalance(12.34, 'USD')).toBe('12.34 USD')
    expect(formatBalance(12.34, undefined)).toBe('12.34')
  })
})
