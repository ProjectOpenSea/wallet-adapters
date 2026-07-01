/**
 * Bankr wallet adapter.
 *
 * Uses Bankr's Wallet API to sign and send transactions via a managed
 * agent wallet. Authentication is done via API key in the X-API-Key header.
 *
 * # Security model
 *
 * This adapter is **signing-only by design.** It exposes only the
 * primitives an agent needs: `getAddress`, `sendTransaction`,
 * `signMessage`, `signTypedData`, and `getWalletInfo`. Future
 * contributors: do not add scope-mutation or key-management surfaces
 * here — Bankr does not expose them via API anyway, and adding
 * adapter-side wrappers around dashboard ops would be a footgun.
 *
 * Effective hardening is done at the API key configuration level on
 * bankr.bot/api, not in this adapter:
 *
 *   1. For monitoring-only agents, enable the key's `readOnly` flag —
 *      `/wallet/sign` and `/wallet/submit` will return 403.
 *
 *   2. For signing agents, set `allowedRecipients` (an EVM/Solana
 *      address allowlist) and `allowedIps` (CIDR allowlist) on the
 *      key. Disable `agentApiEnabled` if the agent does not need
 *      Bankr's prompt API.
 *
 *   3. Set per-key daily message limits at bankr.bot/api.
 *
 *   4. Bankr does not expose key-scope flags via API, so
 *      `getWalletInfo()` cannot verify these settings at runtime —
 *      `opensea wallet info` reminds the user to verify scope at the
 *      dashboard. Re-confirm after any key rotation.
 *
 *   5. Bankr keys cannot enforce aggregate dollar/ETH spend caps; daily
 *      message-quota limits are not the same thing. Use the hot/cold
 *      wallet float pattern documented in
 *      `packages/skill/opensea-wallet/references/wallet-funding.md`.
 *
 * Required environment variables:
 *   BANKR_API_KEY — Bankr API key with Wallet API access enabled
 *
 * Optional:
 *   BANKR_API_BASE_URL — Override the Bankr API base URL
 *
 * @see https://docs.bankr.bot/agent-api/authentication
 * @see https://docs.bankr.bot/agent-api/access-control
 */

import type {
  SignMessageRequest,
  SignTypedDataRequest,
  TransactionRequest,
  TransactionResult,
  WalletAdapter,
  WalletCapabilities,
  WalletInfo,
} from "../types/index.js"

export interface BankrConfig {
  apiKey: string
  baseUrl?: string
}

const BANKR_API_BASE = "https://api.bankr.bot"

export class BankrAdapter implements WalletAdapter {
  readonly name = "bankr"
  readonly capabilities: WalletCapabilities = {
    signMessage: true,
    signTypedData: true,
    managedGas: true,
    managedNonce: true,
  }
  onRequest?: (method: string, params: unknown) => void
  onResponse?: (method: string, result: unknown, durationMs: number) => void
  private config: BankrConfig
  private cachedAddress?: string

  constructor(config: BankrConfig) {
    this.config = config
  }

  static fromEnv(): BankrAdapter {
    const apiKey = process.env.BANKR_API_KEY

    if (!apiKey) {
      throw new Error("BANKR_API_KEY environment variable is required")
    }

    return new BankrAdapter({
      apiKey,
      baseUrl: process.env.BANKR_API_BASE_URL,
    })
  }

  private get baseUrl(): string {
    return this.config.baseUrl ?? BANKR_API_BASE
  }

  private get authHeaders(): Record<string, string> {
    return {
      "X-API-Key": this.config.apiKey,
      "Content-Type": "application/json",
    }
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress

    const response = await fetch(`${this.baseUrl}/wallet/me`, {
      headers: this.authHeaders,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Bankr getAddress failed (${response.status}): ${body}`)
    }

    const data = (await response.json()) as {
      wallets: Array<{ chain: string; address: string }>
    }
    const evmWallet = data.wallets.find(w => w.chain === "evm")
    if (!evmWallet) {
      throw new Error("Bankr wallet has no EVM address")
    }
    this.cachedAddress = evmWallet.address
    return evmWallet.address
  }

  async getWalletInfo(): Promise<WalletInfo> {
    const address = await this.getAddress()
    return {
      provider: "bankr",
      address,
      scopeIntrospectable: false,
    }
  }

  async sendTransaction(tx: TransactionRequest): Promise<TransactionResult> {
    this.onRequest?.("sendTransaction", tx)
    const startTime = Date.now()

    const transaction: Record<string, unknown> = {
      to: tx.to,
      data: tx.data,
      value: tx.value,
      chainId: tx.chainId,
    }
    if (tx.gas) transaction.gas = tx.gas
    if (tx.nonce !== undefined) transaction.nonce = tx.nonce
    if (tx.maxFeePerGas) transaction.maxFeePerGas = tx.maxFeePerGas
    if (tx.maxPriorityFeePerGas)
      transaction.maxPriorityFeePerGas = tx.maxPriorityFeePerGas

    const response = await fetch(`${this.baseUrl}/wallet/submit`, {
      method: "POST",
      headers: this.authHeaders,
      body: JSON.stringify({
        transaction,
        waitForConfirmation: true,
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Bankr sendTransaction failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as { transactionHash: string }
    const result = { hash: data.transactionHash }
    this.onResponse?.("sendTransaction", result, Date.now() - startTime)
    return result
  }

  async signMessage(request: SignMessageRequest): Promise<string> {
    this.onRequest?.("signMessage", request)
    const startTime = Date.now()

    const message =
      typeof request.message === "string"
        ? request.message
        : `0x${Buffer.from(request.message).toString("hex")}`

    const response = await fetch(`${this.baseUrl}/wallet/sign`, {
      method: "POST",
      headers: this.authHeaders,
      body: JSON.stringify({
        signatureType: "personal_sign",
        message,
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Bankr signMessage failed (${response.status}): ${body}`)
    }

    const data = (await response.json()) as { signature: string }
    this.onResponse?.("signMessage", data.signature, Date.now() - startTime)
    return data.signature
  }

  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    this.onRequest?.("signTypedData", request)
    const startTime = Date.now()

    // EIP-712 typed data commonly carries BigInt fields (e.g. EIP-3009
    // `value`/`validAfter`/`validBefore`, chainId). JSON.stringify throws on
    // BigInt, so serialize them to strings for the Bankr API.
    const replacer = (_k: string, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v
    const response = await fetch(`${this.baseUrl}/wallet/sign`, {
      method: "POST",
      headers: this.authHeaders,
      body: JSON.stringify(
        {
          signatureType: "eth_signTypedData_v4",
          typedData: {
            domain: request.domain,
            types: request.types,
            primaryType: request.primaryType,
            message: request.message,
          },
        },
        replacer,
      ),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Bankr signTypedData failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as { signature: string }
    this.onResponse?.("signTypedData", data.signature, Date.now() - startTime)
    return data.signature
  }
}
