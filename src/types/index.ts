/**
 * Core types for the wallet adapter interface.
 *
 * These types define the contract between consumers and wallet providers.
 * Designed to be provider-agnostic and extensible for future signing
 * capabilities (EIP-712, EIP-191, batch transactions, etc.).
 */

/**
 * Provider-shaped wallet metadata used by the `opensea wallet info` CLI
 * command and by callers auditing the security posture of an agent wallet.
 *
 * Each variant surfaces only what the provider's API actually exposes for
 * the calling credentials. Fields whose absence indicates a hardening gap
 * (no on-chain policy enforcement, no off-machine credential gating
 * administrative changes, etc.) are intentionally surfaced as falsy values
 * rather than hidden, so callers can warn the user.
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
       * key — sign, mutate, export, all unconstrained.
       */
      isRootUser: boolean
    }
  | {
      provider: "fireblocks"
      address: string
      vaultId: string
      /**
       * Fireblocks does not expose API-user role via API. The CLI
       * surfaces a static reminder to verify the role at the console.
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

export interface TransactionRequest {
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
export interface WalletAdapter {
  /** Human-readable provider name for logging and error messages */
  readonly name: string

  /** Declared capabilities of this adapter */
  readonly capabilities: WalletCapabilities

  /** Get the wallet address */
  getAddress(): Promise<string>

  /** Sign and send a transaction, returns the tx hash */
  sendTransaction(tx: TransactionRequest): Promise<TransactionResult>

  /** Sign a raw message (EIP-191). Throws if not supported. */
  signMessage?(request: SignMessageRequest): Promise<string>

  /** Sign EIP-712 typed data. Throws if not supported. */
  signTypedData?(request: SignTypedDataRequest): Promise<string>

  /**
   * Read-only metadata about the wallet's security posture. Used by the
   * `opensea wallet info` CLI to surface hardening gaps (no policy, no
   * authorization-key gating, root-user API key, etc.). Optional because
   * not every adapter has a meaningful introspection surface — the
   * private-key adapter, for instance, has nothing to report.
   */
  getWalletInfo?(): Promise<WalletInfo>

  /** Optional RPC URL for read operations (gas estimation, nonce, etc.) */
  getRpcUrl?(): string

  /** Optional hook called before each adapter request (for metrics/logging) */
  onRequest?: (method: string, params: unknown) => void

  /** Optional hook called after each adapter response (for metrics/logging) */
  onResponse?: (method: string, result: unknown, durationMs: number) => void
}

/**
 * Declares which optional operations an adapter supports.
 * Consumers can check capabilities before calling optional methods.
 */
export interface WalletCapabilities {
  /** Whether signMessage() is supported */
  signMessage: boolean
  /** Whether signTypedData() is supported (EIP-712) */
  signTypedData: boolean
  /** Whether the provider manages gas estimation internally */
  managedGas: boolean
  /** Whether the provider manages nonce internally */
  managedNonce: boolean
}

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
