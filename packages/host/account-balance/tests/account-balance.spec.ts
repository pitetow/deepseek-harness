/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver and account-balance rows, and the spec
 * observes the served `/api/balance` HTTP surface with a stubbed platform
 * response — the same credential key the provider reads is reused, so nothing
 * beyond `DEEPSEEK_API_KEY` needs configuring.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as AccountBalance from '../src/index.ts'
import { parseBalanceResponse } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
})

/** Boot the webserver + account-balance rows through the real Loader. */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-account-balance-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: balance',
    "  name: '@deepseek-ai/dsh-host-account-balance'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-account-balance', AccountBalance],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('parseBalanceResponse', () => {
  it('extracts the balance and currency from the platform payload', () => {
    expect(parseBalanceResponse({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }],
    })).toEqual({ isAvailable: true, balance: 12.34, currency: 'CNY' })
  })

  it('reports unavailable when no balance entry exists or the shape is foreign', () => {
    expect(parseBalanceResponse({ is_available: true, balance_infos: [] })).toEqual({ isAvailable: false })
    expect(parseBalanceResponse(null)).toEqual({ isAvailable: false })
    expect(parseBalanceResponse('nope')).toEqual({ isAvailable: false })
  })

  it('omits a balance when the reported value is not numeric', () => {
    expect(parseBalanceResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'oops' }] }))
      .toEqual({ isAvailable: true, currency: 'CNY' })
  })
})

describe('real Loader composition', () => {
  it('serves the account balance from /api/balance using the shared credential key', { timeout: 60_000 }, async () => {
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    const previousKey = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    try {
      const loaded = await loadComposition()
      const response = await realFetch(`http://127.0.0.1:${String(loaded.webServer.port)}/api/balance`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ isAvailable: true, balance: 12.34, currency: 'CNY' })
      expect(globalThis.fetch).toHaveBeenCalledWith('https://api.deepseek.com/user/balance', {
        headers: { Authorization: 'Bearer sk-test' },
      })
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previousKey
    }
  })

  it('answers unavailable without a configured key', { timeout: 60_000 }, async () => {
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn())
    const previousKey = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      const loaded = await loadComposition()
      const response = await realFetch(`http://127.0.0.1:${String(loaded.webServer.port)}/api/balance`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ isAvailable: false })
      expect(globalThis.fetch).not.toHaveBeenCalled()
    } finally {
      if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
    }
  })
})
