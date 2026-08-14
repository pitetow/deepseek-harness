// Parser unit spec for the DeepSeek official pricing page: the SSR table
// structures (rowspan quirks included) fold into the price table exactly.
import { describe, expect, it } from 'vitest'
import { parseDeepSeekPricingPage } from './sync-deepseek-prices.ts'

// Mirrors the live Docusaurus page: the model-overview table carries the base
// price rows at its tail (the 价格 cell rowspans three metric rows), and a
// second table holds the 空闲/高峰 rows (the model cell rowspans the pair).
const FIXTURE = `<!doctype html><html lang="zh-cn"><body>
<table>
  <tr><td>模型</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr>
  <tr><td>上下文长度</td><td>1M</td><td>1M</td></tr>
  <tr><td>输出长度</td><td>最大 384K</td><td>最大 384K</td></tr>
  <tr><td rowspan="3">价格<sup>(1)</sup></td><td>百万tokens输入（缓存命中）</td><td>0.02元</td><td>0.025元</td></tr>
  <tr><td>百万tokens输入（缓存未命中）</td><td>1元</td><td>3元</td></tr>
  <tr><td>百万tokens输出</td><td>2元</td><td>6元</td></tr>
</table>
<p>(1) 我们将对 DeepSeek API 价格进行更新调整，采用峰谷定价，空闲时段价格为高峰时段价格的一半。高峰时段为北京时间 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。新价格将于北京时间 2026 年 8 月 17 日 00:00 开始生效，具体如下：</p>
<table>
  <tr><td>模型</td><td>百万tokens输入（缓存命中）</td><td>百万tokens输入（缓存未命中）</td><td>百万tokens输出</td></tr>
  <tr><td rowspan="2">deepseek-v4-flash</td><td>空闲时段</td><td>0.05元</td><td>1.5元</td><td>4.5元</td></tr>
  <tr><td>高峰时段</td><td>0.10元</td><td>3.0元</td><td>9.0元</td></tr>
  <tr><td rowspan="2">deepseek-v4-pro</td><td>空闲时段</td><td>0.15元</td><td>4.5元</td><td>13.5元</td></tr>
  <tr><td>高峰时段</td><td>0.30元</td><td>9.0元</td><td>27.0元</td></tr>
</table>
</body></html>`

describe('parseDeepSeekPricingPage', () => {
  it('parses base, off-peak, and peak prices with the rowspan quirks', () => {
    const prices = parseDeepSeekPricingPage(FIXTURE)
    expect(prices).not.toBeNull()
    expect(prices!.base).toEqual({
      'deepseek-v4-flash': { inputCacheHitYuanPerM: 0.02, inputCacheMissYuanPerM: 1, outputYuanPerM: 2 },
      'deepseek-v4-pro': { inputCacheHitYuanPerM: 0.025, inputCacheMissYuanPerM: 3, outputYuanPerM: 6 },
    })
    expect(prices!.offPeak['deepseek-v4-flash']).toEqual({
      inputCacheHitYuanPerM: 0.05, inputCacheMissYuanPerM: 1.5, outputYuanPerM: 4.5,
    })
    expect(prices!.peak['deepseek-v4-pro']).toEqual({
      inputCacheHitYuanPerM: 0.3, inputCacheMissYuanPerM: 9, outputYuanPerM: 27,
    })
  })

  it('parses the Beijing peak windows and the effective instant', () => {
    const prices = parseDeepSeekPricingPage(FIXTURE)
    expect(prices!.peakHours).toEqual([{ start: 9, end: 12 }, { start: 14, end: 18 }])
    // 2026-08-17T00:00:00+08:00 == 2026-08-16T16:00:00Z.
    expect(prices!.effectiveFromMs).toBe(Date.UTC(2026, 7, 16, 16, 0, 0))
  })

  it('returns null when the page structure no longer matches', () => {
    expect(parseDeepSeekPricingPage('<html><p>no tables here</p></html>')).toBeNull()
    expect(parseDeepSeekPricingPage('<table><tr><td>only</td></tr></table>')).toBeNull()
  })
})
