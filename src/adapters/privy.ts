/**
 * Privy wallet adapter.
 *
 * Uses Privy's server-side wallet API to sign and send transactions.
 * Transactions are governed by Privy's programmable policy engine —
 * policies are evaluated in a trusted execution environment before signing.
 *
 * Required environment variables:
 *   PRIVY_APP_ID      — Privy application ID
 *   PRIVY_APP_SECRET  — Privy application secret
 *   PRIVY_WALLET_ID   — Wallet ID to use for signing
 *
 * Optional:
 *   PRIVY_API_BASE_URL — Override the Privy API base URL
 *
 * @see https://docs.privy.io/wallets/wallets/server-side-access
 * @see https://docs.privy.io/controls/policies/overview
 */

import type {
  SignMessageRequest,
  SignTypedDataRequest,
  TransactionRequest,
  TransactionResult,
  WalletAdapter,
  WalletCapabilities,
} from "../types/index.js"

export interface PrivyConfig {
  appId: string
  appSecret: string
  walletId: string
  baseUrl?: string
}

const PRIVY_API_BASE = "https://api.privy.io"

export class PrivyAdapter implements WalletAdapter {
  readonly name = "privy"
  readonly capabilities: WalletCapabilities = {
    signMessage: true,
    signTypedData: true,
    managedGas: true,
    managedNonce: true,
  }
  onRequest?: (method: string, params: unknown) => void
  onResponse?: (method: string, result: unknown, durationMs: number) => void
  private config: PrivyConfig
  private cachedAddress?: string

  constructor(config: PrivyConfig) {
    this.config = config
  }

  static fromEnv(): PrivyAdapter {
    const appId = process.env.PRIVY_APP_ID
    const appSecret = process.env.PRIVY_APP_SECRET
    const walletId = process.env.PRIVY_WALLET_ID

    if (!appId) {
      throw new Error("PRIVY_APP_ID environment variable is required")
    }
    if (!appSecret) {
      throw new Error("PRIVY_APP_SECRET environment variable is required")
    }
    if (!walletId) {
      throw new Error("PRIVY_WALLET_ID environment variable is required")
    }

    return new PrivyAdapter({
      appId,
      appSecret,
      walletId,
      baseUrl: process.env.PRIVY_API_BASE_URL,
    })
  }

  private get baseUrl(): string {
    return this.config.baseUrl ?? PRIVY_API_BASE
  }

  private get authHeaders(): Record<string, string> {
    const credentials = Buffer.from(
      `${this.config.appId}:${this.config.appSecret}`,
    ).toString("base64")
    return {
      Authorization: `Basic ${credentials}`,
      "privy-app-id": this.config.appId,
      "Content-Type": "application/json",
    }
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress

    const response = await fetch(
      `${this.baseUrl}/v1/wallets/${this.config.walletId}`,
      { headers: this.authHeaders },
    )

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Privy getAddress failed (${response.status}): ${body}`)
    }

    const data = (await response.json()) as { address: string }
    this.cachedAddress = data.address
    return data.address
  }

  async sendTransaction(tx: TransactionRequest): Promise<TransactionResult> {
    this.onRequest?.("sendTransaction", tx)
    const startTime = Date.now()

    const caip2 = `eip155:${tx.chainId}`

    const response = await fetch(
      `${this.baseUrl}/v1/wallets/${this.config.walletId}/rpc`,
      {
        method: "POST",
        headers: this.authHeaders,
        body: JSON.stringify({
          method: "eth_sendTransaction",
          caip2,
          params: {
            transaction: {
              to: tx.to,
              data: tx.data,
              value: tx.value,
            },
          },
        }),
      },
    )

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Privy sendTransaction failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as { data: { hash: string } }
    const result = { hash: data.data.hash }
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

    const response = await fetch(
      `${this.baseUrl}/v1/wallets/${this.config.walletId}/rpc`,
      {
        method: "POST",
        headers: this.authHeaders,
        body: JSON.stringify({
          method: "personal_sign",
          params: { message },
        }),
      },
    )

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Privy signMessage failed (${response.status}): ${body}`)
    }

    const data = (await response.json()) as { data: { signature: string } }
    this.onResponse?.(
      "signMessage",
      data.data.signature,
      Date.now() - startTime,
    )
    return data.data.signature
  }

  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    this.onRequest?.("signTypedData", request)
    const startTime = Date.now()

    const response = await fetch(
      `${this.baseUrl}/v1/wallets/${this.config.walletId}/rpc`,
      {
        method: "POST",
        headers: this.authHeaders,
        body: JSON.stringify({
          method: "eth_signTypedData_v4",
          params: {
            typedData: JSON.stringify({
              domain: request.domain,
              types: request.types,
              primaryType: request.primaryType,
              message: request.message,
            }),
          },
        }),
      },
    )

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Privy signTypedData failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as { data: { signature: string } }
    this.onResponse?.(
      "signTypedData",
      data.data.signature,
      Date.now() - startTime,
    )
    return data.data.signature
  }
}
