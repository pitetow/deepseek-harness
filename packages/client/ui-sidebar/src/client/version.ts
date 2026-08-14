/**
 * Repository version, substituted into the browser bundle by the tsdown
 * `__DSH_VERSION__` define (tsdown.config.ts) and into unit specs by the
 * vitest define (vitest.config.ts); the sidebar edition badge renders it.
 */
declare const __DSH_VERSION__: string

/** The repository version rendered by the sidebar edition badge. */
export const DSH_VERSION: string = __DSH_VERSION__
