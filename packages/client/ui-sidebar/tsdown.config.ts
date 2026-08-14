import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../tsdown.client.ts'

const ROOT_PACKAGE = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }

/** Repository version substituted into the client bundle's `__DSH_VERSION__` define. */
const DSH_VERSION = ROOT_PACKAGE.version ?? '0.0.0'

const base = clientBundle('@deepseek-ai/dsh-client-ui-sidebar', ['lib/types/index.js', 'lib/types/invariant.js'])

// The browser bundle alone references `__DSH_VERSION__` (src/client/version.ts);
// the node half never does, so only the client config carries the define.
export default ((inline: Pick<UserConfig, 'env'>) => base(inline).map((config) =>
  config.name === '@deepseek-ai/dsh-client-ui-sidebar/client'
    ? { ...config, define: { ...config.define, __DSH_VERSION__: JSON.stringify(DSH_VERSION) } }
    : config,
))
