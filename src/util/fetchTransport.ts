/**
 * Shared invocation of an adapter's configured `fetchImpl`.
 *
 * This mirrors `fetchWith` in `@opensea/sdk` (`src/utils/fetchTransport.ts`) so the two packages
 * agree on how an injected transport is called. It is duplicated rather than imported:
 * `@opensea/wallet-adapters` deliberately ships with only `@noble/hashes` and `@noble/curves` as
 * runtime dependencies, and depending on the SDK to reach five lines would pull in `ethers` and
 * `@opensea/seaport-js` and add a cross-package edge to a package that is also published from its
 * own standalone mirror. If the semantics below ever change, change both copies.
 */

import type { FetchImpl } from "../types/index.js"

/**
 * Perform a request through `impl`, or through the global `fetch` when no transport was
 * configured.
 *
 * The receiver is always `globalThis`. Per Web IDL, an operation hanging off the global replaces a
 * `null` or `undefined` receiver with the global object, so a bare `impl(input, init)` happens to
 * work for unbound native fetch; a receiver that is some *other* object does not. Verified in
 * Chrome 152: `fetch.call(undefined, url)` and `fetch.call(null, url)` both resolve, while
 * `fetch.call({}, url)` rejects with "Failed to execute 'fetch' on 'Window': Illegal invocation".
 * Passing `globalThis` explicitly is what keeps that distinction from depending on how the call
 * site happens to be written, so reading the transport off `this.config` at the point of call
 * cannot turn the config object into the receiver.
 *
 * A bound function or an arrow ignores the `thisArg`, so a transport the caller deliberately bound
 * keeps its own receiver.
 *
 * The global is read at call time rather than captured, so a caller who swaps `globalThis.fetch`
 * after the adapter is constructed still takes effect.
 */
export function fetchWith(
  impl: FetchImpl | undefined,
  ...args: Parameters<FetchImpl>
): Promise<Response> {
  const transport = impl ?? globalThis.fetch
  return transport.call(globalThis, ...args)
}
