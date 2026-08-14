/**
 * Session spend estimate: provider token usage at the official DeepSeek price
 * table (deepseek-prices.generated.ts, synced at build time), choosing the
 * base, peak, or off-peak rate by the current Beijing time and the official
 * effective date. The estimate is a display reference, not a billing input.
 */
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { DEEPSEEK_PRICES, type DeepSeekPriceEntry } from './deepseek-prices.generated.ts'

/** Beijing wall-clock hour (China observes no DST; UTC+8 is fixed). */
export function beijingHour(now: number): number {
  return new Date(now + 8 * 3600_000).getUTCHours()
}

/** Whether `now` (epoch ms) falls inside a Beijing peak window. */
export function isBeijingPeak(now: number): boolean {
  const hour = beijingHour(now)
  return DEEPSEEK_PRICES.peakHours.some(window => hour >= window.start && hour < window.end)
}

/**
 * The price entry in force at `now` for `model`, or undefined when the model
 * has no entry. Before the official effective instant the base rate applies;
 * afterwards the peak/off-peak rate is chosen by Beijing hour.
 * @param model - provider model id.
 * @param now - epoch ms.
 * @returns the price entry, or undefined.
 */
export function deepSeekPriceFor(model: string, now: number): DeepSeekPriceEntry | undefined {
  const key = model.toLowerCase()
  if (now < DEEPSEEK_PRICES.effectiveFromMs) return DEEPSEEK_PRICES.base[key]
  return (isBeijingPeak(now) ? DEEPSEEK_PRICES.peak : DEEPSEEK_PRICES.offPeak)[key]
}

/**
 * The session's most recent assistant model id, from its request config.
 * @param nodes - settled conversation nodes.
 * @returns the model id, or undefined before any request.
 */
export function sessionModel(nodes: readonly ConversationNode[]): string | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (node === undefined) continue
    if (node.kind === 'assistant' && node.requestConfig?.model !== undefined) return node.requestConfig.model
  }
  return undefined
}

/** Sum the four disjoint provider token buckets. */
export function totalSessionTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
}

/**
 * Estimate the session's spend in CNY (元) from provider-reported usage. Cache
 * writes are not billed by DeepSeek, so they contribute nothing.
 * @param usage - the tokenUsage projection buckets.
 * @param now - epoch ms used for the peak/off-peak and effective-date choice.
 * @param model - the session's model id; undefined when no request happened.
 * @returns the estimated spend in yuan, or undefined when the model has no price.
 */
export function estimateSessionCostYuan(
  usage: TokenUsageProjection,
  now: number,
  model: string | undefined,
): number | undefined {
  if (model === undefined) return undefined
  const price = deepSeekPriceFor(model, now)
  if (price === undefined) return undefined
  return usage.uncachedInputTokens / 1_000_000 * price.inputCacheMissYuanPerM
    + usage.cacheReadTokens / 1_000_000 * price.inputCacheHitYuanPerM
    + usage.outputTokens / 1_000_000 * price.outputYuanPerM
}

/**
 * Compact yuan display: two decimals at or above 1, three below.
 * @param cost - spend in yuan.
 * @returns display string.
 */
export function formatYuan(cost: number): string {
  return cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)
}

/**
 * Account-balance display: always two decimals, with the CNY symbol when the
 * platform reports CNY — the platform's balance carries cent precision and
 * the status bar must not round it away.
 * @param balance - account balance in its currency unit.
 * @param currency - ISO currency code (e.g. CNY), when reported.
 * @returns display string.
 */
export function formatBalance(balance: number, currency: string | undefined): string {
  const amount = balance.toFixed(2)
  return currency === 'CNY' ? `¥${amount}` : `${amount}${currency === undefined ? '' : ` ${currency}`}`
}
