/**
 * Core types for the wallet adapter interface.
 *
 * These types define the contract between consumers and wallet providers.
 * Designed to be provider-agnostic and extensible for future signing
 * capabilities (EIP-712, EIP-191, batch transactions, etc.).
 */

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

export type WalletProvider = "privy" | "turnkey" | "fireblocks" | "private-key"

export const WALLET_PROVIDERS: WalletProvider[] = [
  "privy",
  "turnkey",
  "fireblocks",
  "private-key",
]
