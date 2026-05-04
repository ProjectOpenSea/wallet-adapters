/**
 * Bankr wallet adapter.
 *
 * Uses Bankr's Wallet API to sign and send transactions via a managed
 * agent wallet. Authentication is done via API key in the X-API-Key header.
 *
 * Required environment variables:
 *   BANKR_API_KEY — Bankr API key with Wallet API access enabled
 *
 * Optional:
 *   BANKR_API_BASE_URL — Override the Bankr API base URL
 *
 * @see https://docs.bankr.bot/agent-api/authentication
 * @see https://docs.bankr.bot/wallet-api/wallet-info
 */

import type {
  SignMessageRequest,
  SignTypedDataRequest,
  TransactionRequest,
  TransactionResult,
  WalletAdapter,
  WalletCapabilities,
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

    const response = await fetch(`${this.baseUrl}/wallet/sign`, {
      method: "POST",
      headers: this.authHeaders,
      body: JSON.stringify({
        signatureType: "eth_signTypedData_v4",
        typedData: {
          domain: request.domain,
          types: request.types,
          primaryType: request.primaryType,
          message: request.message,
        },
      }),
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
