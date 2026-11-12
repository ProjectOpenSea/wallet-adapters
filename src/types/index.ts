/**
 * Core types for the wallet adapter interface.
 *
 * The contract between consumers and wallet providers. Provider-agnostic,
 * and open to new signing capabilities (EIP-712, EIP-191, batch
 * transactions, etc.).
 */

/**
 * Provider-shaped wallet metadata used by the `opensea wallet info` CLI
 * command and by callers auditing the security posture of an agent wallet.
 *
 * Each variant reports only what the provider's API exposes for the calling
 * credentials. Fields that signal a hardening gap (no onchain policy
 * enforcement, no off-machine credential gating administrative changes,
 * etc.) are reported as falsy values rather than omitted, so callers can
 * warn the user.
 */
export type WalletInfo =
  | {
      provider: "privy"
      address: string
      chainType: string
      policyIds: string[]
      ownerKeyId: string | null
      additionalSignerCount: number
      /**
       * True iff the wallet has an `owner_id` set, in which case all
       * `/v1/wallets/{id}/rpc` requests must carry an authorization
       * signature from the owner's key quorum. False means the env app
       * secret can sign and rewrite policy unilaterally.
       */
      ownerEnforcesAuthKey: boolean
    }
  | {
      provider: "turnkey"
      address: string
      organizationId: string
      userId: string
      username: string
      /**
       * True iff the calling API user is in the organization's root
       * quorum. Root users bypass Turnkey's policy engine entirely, so a
       * leaked root API key has the same blast radius as a raw private
       * key: it can sign, change policy, and export without limits.
       */
      isRootUser: boolean
    }
  | {
      provider: "fireblocks"
      address: string
      vaultId: string
      /**
       * Fireblocks does not expose the API user's role through the API.
       * The CLI shows a static reminder to verify the role at the console.
       */
      roleIntrospectable: false
    }
  | {
      provider: "bankr"
      address: string
      /**
       * Bankr does not expose key-scope flags via API. The CLI surfaces
       * a static reminder to verify scope at bankr.bot/api.
       */
      scopeIntrospectable: false
    }

/**
 * Which family of chains an adapter signs for.
 *
 * The discriminant on {@link WalletAdapter}. EVM and SVM do not share a transaction shape, an
 * address format, or a signing scheme, so a single adapter interface covering both would be a
 * union of optional methods where half are always absent. Splitting on this instead lets each
 * side declare exactly what it has, and lets callers narrow with {@link isEvmAdapter} /
 * {@link isSvmAdapter}.
 */
export type ChainType = "evm" | "svm"

/** An EVM transaction to sign and broadcast. */
export interface EvmTransactionRequest {
  /**
   * Optional key making a retry of this exact request safe, forwarded to providers that support
   * one. Privy stores the request and response for 24 hours and returns the stored response
   * instead of re-executing, so a retried send cannot broadcast twice.
   *
   * **One key per transaction you want to happen once, reused on every retry of it.** The reuse is
   * the whole mechanism: a retry carrying the same key gets the stored response, while a retry
   * carrying a fresh key is a second transaction. So generate the key where you decide to send,
   * not inside the retry loop.
   *
   * A different key means a different transaction. Reusing a key with a changed body is rejected
   * with a 400, which ties the key to the request you actually built rather than to the caller or
   * the session.
   *
   * A provider that cannot honour a key throws rather than dropping it, so this can never be
   * silently ineffective. Check `capabilities.idempotentSend` to know which you have.
   */
  idempotencyKey?: string
  to: string
  data: string
  value: string
  chainId: number
  /** Pre-estimated gas limit (avoids redundant RPC call when provided) */
  gas?: string
  /** Pre-fetched nonce */
  nonce?: number
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
}

/**
 * @deprecated Renamed to {@link EvmTransactionRequest} now that SVM has its own shape. Kept as an
 * alias so the rename alone does not break a consumer that only handles EVM.
 */
export type TransactionRequest = EvmTransactionRequest

/**
 * A Solana transaction to sign and, optionally, broadcast.
 *
 * Carried as the serialized wire message rather than a structured `to`/`data`/`value`, because a
 * Solana transaction is a set of instructions over accounts with no single recipient or amount.
 * Callers build it with whatever they already use (`@solana/web3.js`, an OpenSea quote response)
 * and hand over the bytes, which keeps this package free of a Solana SDK dependency.
 */
export interface SvmTransactionRequest {
  /** See {@link EvmTransactionRequest.idempotencyKey}. Honoured by `PrivySvmAdapter`. */
  idempotencyKey?: string
  /**
   * The serialized transaction message. `Uint8Array` is the wire form; a `string` is accepted as
   * base64, which is what most Solana RPC surfaces and OpenSea's own swap responses return.
   */
  transaction: Uint8Array | string
  /**
   * CAIP-2 chain id, for example `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. Defaults to Solana
   * mainnet when omitted. Providers that route by cluster need this; local signers ignore it.
   */
  caip2?: string
}

/**
 * A signed but unbroadcast Solana transaction.
 *
 * Always base64, whichever form the request used. `SvmTransactionRequest.transaction` accepts
 * `Uint8Array` or base64 because callers build transactions with different tools; the signed result
 * is normalized because base64 is what every Solana RPC `sendTransaction` takes, so returning bytes
 * would just move the encoding to the caller.
 */
export interface SvmSignedTransaction {
  /** The signed transaction, base64-encoded regardless of the request's representation. */
  signedTransaction: string
}

export interface TransactionResult {
  hash: string
}

export interface SignMessageRequest {
  message: string | Uint8Array
}

export interface SignTypedDataRequest {
  domain: Record<string, unknown>
  types: Record<string, Array<{ name: string; type: string }>>
  primaryType: string
  message: Record<string, unknown>
}

/**
 * Core wallet adapter interface.
 *
 * Implement this interface to add a new wallet provider. At minimum,
 * a provider must support `getAddress()` and `sendTransaction()`.
 * Optional capabilities (message signing, typed data signing) can be
 * declared via the `capabilities` property.
 */
export interface BaseWalletAdapter {
  /** Human-readable provider name for logging and error messages */
  readonly name: string

  /** Which chain family this adapter signs for. Narrow on this before reaching for chain-specific methods. */
  readonly chainType: ChainType

  /** Declared capabilities of this adapter */
  readonly capabilities: WalletCapabilities

  /**
   * Get the wallet address, in that chain's native format: a `0x` hex address for EVM, a base58
   * public key for SVM.
   */
  getAddress(): Promise<string>

  /** Sign a raw message. Throws if not supported. */
  signMessage?(request: SignMessageRequest): Promise<string>

  /**
   * Read-only metadata about the wallet's security posture. Used by the
   * `opensea wallet info` CLI to report hardening gaps (no policy, no
   * authorization-key gating, root-user API key, etc.). Optional because
   * some adapters have nothing to introspect; the private-key adapter, for
   * one, has nothing to report.
   */
  getWalletInfo?(): Promise<WalletInfo>

  /** Optional RPC URL for read operations (gas estimation, nonce, etc.) */
  getRpcUrl?(): string | undefined

  /** Optional hook called before each adapter request (for metrics/logging) */
  onRequest?: (method: string, params: unknown) => void

  /** Optional hook called after each adapter response (for metrics/logging) */
  onResponse?: (method: string, result: unknown, durationMs: number) => void
}

/** A wallet that signs for EVM chains. */
export interface EvmWalletAdapter extends BaseWalletAdapter {
  readonly chainType: "evm"

  /** Sign and send a transaction, returns the tx hash */
  sendTransaction(tx: EvmTransactionRequest): Promise<TransactionResult>

  /** Sign EIP-712 typed data. Throws if not supported. */
  signTypedData?(request: SignTypedDataRequest): Promise<string>
}

/**
 * A wallet that signs for Solana.
 *
 * `signTransaction` is required and `sendTransaction` is optional, the reverse of the EVM side.
 * Solana callers routinely sign and broadcast separately: a fee payer co-signs, a transaction is
 * simulated before submission, or the caller already holds a connection with its own commitment
 * and retry policy. A provider that only signs is fully useful here, so requiring it to broadcast
 * would exclude it for no gain.
 */
export interface SvmWalletAdapter extends BaseWalletAdapter {
  readonly chainType: "svm"

  /** Narrower than the base declaration: typed-data signing cannot exist here. */
  readonly capabilities: SvmWalletCapabilities

  /** Sign a transaction and return it without broadcasting. */
  signTransaction(tx: SvmTransactionRequest): Promise<SvmSignedTransaction>

  /** Sign and broadcast, returning the signature. Absent on sign-only providers. */
  sendTransaction?(tx: SvmTransactionRequest): Promise<TransactionResult>
}

/**
 * A wallet adapter for any supported chain family.
 *
 * A union rather than one interface with optional methods, so `chainType` narrowing gives you
 * exactly the methods that exist. Use {@link isEvmAdapter} / {@link isSvmAdapter} at the boundary.
 */
export type WalletAdapter = EvmWalletAdapter | SvmWalletAdapter

/** Narrows to an EVM adapter. */
export function isEvmAdapter(
  adapter: WalletAdapter,
): adapter is EvmWalletAdapter {
  return adapter.chainType === "evm"
}

/** Narrows to a Solana adapter. */
export function isSvmAdapter(
  adapter: WalletAdapter,
): adapter is SvmWalletAdapter {
  return adapter.chainType === "svm"
}

/**
 * Thrown when a flow needs a chain family the configured wallet does not sign for.
 *
 * Carries the adapter and the requirement rather than only a string, so a CLI can print it and a
 * library caller can branch on it.
 */
export class WrongChainTypeError extends Error {
  constructor(
    readonly adapter: BaseWalletAdapter,
    readonly required: ChainType,
    readonly purpose: string,
  ) {
    super(
      `wallet "${adapter.name}" signs for ${adapter.chainType}; ` +
        `${purpose} requires an ${required.toUpperCase()} wallet`,
    )
    this.name = "WrongChainTypeError"
  }
}

/**
 * Narrows to an EVM adapter or throws {@link WrongChainTypeError}.
 *
 * One helper rather than a hand-written guard at each call site: the four EVM-only flows in this
 * monorepo (x402 settlement, the viem bridge, swap execution, the EIP-712 CLI commands) all need
 * the same check and the same message, and four copies drift.
 *
 * @param purpose what needs the EVM wallet, used in the message. Phrase it as a noun: "x402
 *   payment", "swap execution".
 */
export function requireEvmAdapter(
  adapter: WalletAdapter,
  purpose: string,
): EvmWalletAdapter {
  if (!isEvmAdapter(adapter)) {
    throw new WrongChainTypeError(adapter, "evm", purpose)
  }
  return adapter
}

/**
 * Thrown when a request carries an `idempotencyKey` the adapter cannot honour.
 *
 * Louder than dropping the key, because the caller supplied it precisely to make a retry safe: a
 * silently ignored key turns a retry into a second transaction.
 */
export class IdempotencyUnsupportedError extends Error {
  constructor(readonly adapter: BaseWalletAdapter) {
    super(
      `wallet "${adapter.name}" does not support an idempotency key, so retrying this request ` +
        "could send twice. Remove idempotencyKey, or use a provider whose " +
        "capabilities.idempotentSend is true.",
    )
    this.name = "IdempotencyUnsupportedError"
  }
}

/** Thrown when an `idempotencyKey` is present but blank, which protects nothing. */
export class BlankIdempotencyKeyError extends Error {
  constructor(readonly adapter: BaseWalletAdapter) {
    super(
      `wallet "${adapter.name}" was given a blank idempotency key. Privy accepts one with a 200 ` +
        "and it protects nothing, so retrying this request could send twice. Generate one value " +
        "per transaction, such as a v4 UUID, reuse it on every retry of that transaction, or " +
        "omit the field.",
    )
    this.name = "BlankIdempotencyKeyError"
  }
}

/**
 * Validates a supplied `idempotencyKey` and rejects one the adapter cannot honour. Call it at the
 * top of `sendTransaction` in **every** adapter, including those that do forward a key: the blank
 * check applies to all of them and only the support check is conditional.
 *
 * A blank key is rejected rather than dropped or forwarded. Verified against the live API: Privy
 * answers 200 to both an empty and a whitespace-only `privy-idempotency-key`, so forwarding one
 * buys nothing and dropping one leaves a caller believing a retry is safe when it is not. An empty
 * string usually arrives from an unset variable, so it is a caller mistake worth naming rather than
 * absorbing.
 */
export function requireIdempotencySupport(
  adapter: BaseWalletAdapter,
  request: { idempotencyKey?: string },
): void {
  const key = request.idempotencyKey
  // Presence, not truthiness, so "" reaches the checks below instead of looking like an omission.
  if (key === undefined) return
  if (key.trim() === "") throw new BlankIdempotencyKeyError(adapter)
  if (adapter.capabilities.idempotentSend !== true) {
    throw new IdempotencyUnsupportedError(adapter)
  }
}

/**
 * Declares which optional operations an adapter supports.
 * Consumers can check capabilities before calling optional methods.
 */
export interface WalletCapabilities {
  /** Whether signMessage() is supported */
  signMessage: boolean
  /** Whether signTypedData() is supported (EIP-712). Pinned to `false` on SVM adapters by
   * {@link SvmWalletCapabilities}, which have no typed-data scheme. */
  signTypedData: boolean
  /** Whether the provider manages gas estimation internally */
  managedGas: boolean
  /** Whether the provider manages nonce internally */
  managedNonce: boolean
  /**
   * Whether the provider honours `idempotencyKey` on a transaction request.
   *
   * Optional so an adapter written against an earlier version still satisfies this type; absent
   * means not supported. An adapter that declares `false` or omits it must throw when handed a key,
   * via {@link requireIdempotencySupport}, so a caller expecting protection never silently loses it.
   */
  idempotentSend?: boolean
}

/**
 * Capabilities of an SVM adapter, with `signTypedData` pinned to the literal `false`.
 *
 * EIP-712 is an Ethereum scheme and {@link SvmWalletAdapter} declares no `signTypedData` method,
 * so a `true` here would advertise an operation that cannot be called. Pinning the literal turns
 * that into a compile error instead of a doc convention the next adapter can quietly break.
 */
export type SvmWalletCapabilities = Omit<
  WalletCapabilities,
  "signTypedData"
> & {
  signTypedData: false
}

/**
 * The `fetch` an adapter should use for every HTTP call it makes.
 *
 * Every adapter config takes one as `fetchImpl`, defaulting to the global
 * `fetch`. `baseUrl` can already point an adapter at a local server, but
 * asserting on a request then means running one; `onRequest`/`onResponse`
 * observe a call rather than standing in for the transport. Injecting the
 * transport is what lets a test read the URL, headers and body an adapter
 * produces without a network and without reassigning a global.
 */
export type FetchImpl = typeof globalThis.fetch

export type WalletProvider =
  | "privy"
  | "turnkey"
  | "fireblocks"
  | "bankr"
  | "private-key"

export const WALLET_PROVIDERS: WalletProvider[] = [
  "privy",
  "turnkey",
  "fireblocks",
  "bankr",
  "private-key",
]
