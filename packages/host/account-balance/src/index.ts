/**
 * @deepseek-ai/dsh-host-account-balance — DeepSeek account balance for the Web
 * status bar: resolves the provider API key through the credential seam (the
 * same `DEEPSEEK_API_KEY` reference the llm-deepseek route reads) and serves
 * `GET /api/balance` from the webserver. The client refetches after each
 * completed turn; the response never carries the key.
 * @module @deepseek-ai/dsh-host-account-balance
 */

import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-credentials'

/** Stable Cordis plugin name. */
export const name = 'account-balance'

/** Services required before the route can be claimed. */
export const inject = ['webServer']

/** The credential reference the provider route reads (shared with llm-deepseek). */
const API_KEY_REF = credentialRef('DEEPSEEK_API_KEY')

/** DeepSeek platform balance endpoint. */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** Balance JSON served to the client; never carries the key. */
export interface AccountBalancePayload {
  /** Whether the platform reported a usable balance for the resolved key. */
  isAvailable: boolean
  /** Total balance in the entry's currency; absent when the platform reports none. */
  balance?: number
  /** ISO currency code of the reported balance (e.g. CNY). */
  currency?: string
}

/**
 * Parse the platform `/user/balance` response into the client payload.
 * @param body - the parsed JSON body.
 * @returns the client payload; `isAvailable` is false when no balance entry exists.
 */
export function parseBalanceResponse(body: unknown): AccountBalancePayload {
  const record = (typeof body === 'object' && body !== null ? body : {}) as {
    is_available?: unknown
    balance_infos?: unknown
  }
  const infos = Array.isArray(record.balance_infos) ? record.balance_infos : []
  const first = infos[0] as { currency?: unknown; total_balance?: unknown } | undefined
  const total = typeof first?.total_balance === 'string' ? Number(first.total_balance) : first?.total_balance
  return {
    isAvailable: record.is_available !== false && infos.length > 0,
    ...(typeof total === 'number' && Number.isFinite(total) ? { balance: total } : {}),
    ...(typeof first?.currency === 'string' ? { currency: first.currency } : {}),
  }
}

/**
 * Query the platform balance with the resolved API key.
 * @param key - the provider API key.
 * @returns the parsed payload.
 */
export async function fetchAccountBalance(key: string): Promise<AccountBalancePayload> {
  const response = await fetch(BALANCE_URL, { headers: { Authorization: `Bearer ${key}` } })
  if (!response.ok) throw new Error(`balance API HTTP ${response.status}`)
  return parseBalanceResponse(await response.json())
}

/**
 * Resolve the provider API key through the credential seam, falling back to
 * the ambient environment when the seam is absent (mirrors llm-deepseek).
 * @param ctx - registrant context carrying the optional credentials service.
 * @returns the key, or undefined when none is configured.
 */
async function resolveApiKey(ctx: Context): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(API_KEY_REF)
    if (hit !== undefined) return hit.value
  }
  return process.env.DEEPSEEK_API_KEY
}

/**
 * Register the `GET /api/balance` route. Missing keys and platform failures
 * both answer `{ isAvailable: false }` so the client shows a single
 * "balance unknown" state instead of branching on transport errors.
 * @param ctx - registrant context carrying the webserver service.
 * @returns the route's disposer.
 */
export function apply(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: '/api/balance',
    handler: async (_req, res: ServerResponse) => {
      let payload: AccountBalancePayload = { isAvailable: false }
      const key = await resolveApiKey(ctx)
      if (key !== undefined) {
        try {
          payload = await fetchAccountBalance(key)
        } catch {
          payload = { isAvailable: false }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    },
  })
}
