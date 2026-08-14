/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-account-balance`.
 * @module @deepseek-ai/dsh-host-account-balance/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-account-balance'

/** Cordis companion plugin name. */
export const name = 'host-account-balance-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the only owned relation is the single exact
 * `/api/balance` webserver route, whose register/dispose symmetry is covered
 * by the package's real-composition test — an event-stream probe cannot see
 * route ownership without duplicating the webserver's internal table.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
