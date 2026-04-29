/**
 * Fireblocks wallet adapter.
 *
 * Uses Fireblocks' REST API to sign and send transactions through their
 * enterprise-grade MPC custody infrastructure.
 *
 * Required environment variables:
 *   FIREBLOCKS_API_KEY       — Fireblocks API key
 *   FIREBLOCKS_API_SECRET    — Fireblocks API secret (RSA private key, PEM-encoded)
 *   FIREBLOCKS_VAULT_ID      — Fireblocks vault account ID
 *
 * Optional:
 *   FIREBLOCKS_API_BASE_URL       — Override the API base URL
 *   FIREBLOCKS_ASSET_ID           — Override the Fireblocks asset ID
 *   FIREBLOCKS_MAX_POLL_ATTEMPTS  — Override max polling attempts (default: 60 = 120s)
 *
 * @see https://developers.fireblocks.com/docs/introduction
 */

import type {
  SignMessageRequest,
  SignTypedDataRequest,
  TransactionRequest,
  TransactionResult,
  WalletAdapter,
  WalletCapabilities,
} from "../types/index.js"
import { hashPersonalMessage, hashTypedData } from "../util/eip712.js"

/** Map EVM chain IDs to Fireblocks asset IDs. */
export const CHAIN_TO_FIREBLOCKS_ASSET: Record<number, string> = {
  1: "ETH",
  10: "ETH-OPT",
  130: "UNICHAIN_ETH",
  137: "MATIC_POLYGON",
  360: "SHAPE_ETH",
  1329: "SEI_EVM",
  1868: "SONEIUM_ETH",
  2741: "ABSTRACT_ETH",
  8453: "BASECHAIN_ETH",
  33139: "APE_CHAIN",
  42161: "ETH-AETH",
  43114: "AVAX",
  80094: "BERA_CHAIN",
  81457: "BLAST_ETH",
  7777777: "ZORA_ETH",
}

export interface FireblocksConfig {
  apiKey: string
  apiSecret: string
  vaultId: string
  assetId?: string
  baseUrl?: string
  maxPollAttempts?: number
}

const FIREBLOCKS_API_BASE = "https://api.fireblocks.io"

export class FireblocksAdapter implements WalletAdapter {
  readonly name = "fireblocks"
  readonly capabilities: WalletCapabilities = {
    signMessage: true,
    signTypedData: true,
    managedGas: true,
    managedNonce: true,
  }
  onRequest?: (method: string, params: unknown) => void
  onResponse?: (method: string, result: unknown, durationMs: number) => void
  private config: FireblocksConfig
  private cachedAddress?: string

  constructor(config: FireblocksConfig) {
    this.config = config
  }

  static fromEnv(): FireblocksAdapter {
    const apiKey = process.env.FIREBLOCKS_API_KEY
    const apiSecret = process.env.FIREBLOCKS_API_SECRET
    const vaultId = process.env.FIREBLOCKS_VAULT_ID

    if (!apiKey) {
      throw new Error("FIREBLOCKS_API_KEY environment variable is required")
    }
    if (!apiSecret) {
      throw new Error("FIREBLOCKS_API_SECRET environment variable is required")
    }
    if (!vaultId) {
      throw new Error("FIREBLOCKS_VAULT_ID environment variable is required")
    }

    const maxPollAttempts = process.env.FIREBLOCKS_MAX_POLL_ATTEMPTS
      ? Number.parseInt(process.env.FIREBLOCKS_MAX_POLL_ATTEMPTS, 10)
      : undefined

    return new FireblocksAdapter({
      apiKey,
      apiSecret,
      vaultId,
      assetId: process.env.FIREBLOCKS_ASSET_ID,
      baseUrl: process.env.FIREBLOCKS_API_BASE_URL,
      maxPollAttempts,
    })
  }

  private get baseUrl(): string {
    return this.config.baseUrl ?? FIREBLOCKS_API_BASE
  }

  private async createJwt(path: string, bodyHash: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000)

    const header = { alg: "RS256", typ: "JWT" }
    const payload = {
      uri: path,
      nonce: crypto.randomUUID(),
      iat: now,
      exp: now + 30,
      sub: this.config.apiKey,
      bodyHash,
    }

    const b64url = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url")

    const unsigned = `${b64url(header)}.${b64url(payload)}`

    const key = await crypto.subtle.importKey(
      "pkcs8",
      this.pemToBuffer(this.config.apiSecret),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    )

    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned),
    )

    return `${unsigned}.${Buffer.from(sig).toString("base64url")}`
  }

  private pemToBuffer(pem: string): ArrayBuffer {
    const lines = pem
      .replace(/-----BEGIN .*-----/, "")
      .replace(/-----END .*-----/, "")
      .replace(/\s/g, "")
    const buf = Buffer.from(lines, "base64")
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }

  private async hashBody(body: string): Promise<string> {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    )
    return Buffer.from(hash).toString("hex")
  }

  private resolveAssetId(chainId: number): string {
    if (this.config.assetId) return this.config.assetId
    const asset = CHAIN_TO_FIREBLOCKS_ASSET[chainId]
    if (!asset) {
      throw new Error(
        `No Fireblocks asset ID mapping for chain ${chainId}. ` +
          `Set FIREBLOCKS_ASSET_ID explicitly or use a supported chain: ${Object.keys(CHAIN_TO_FIREBLOCKS_ASSET).join(", ")}`,
      )
    }
    return asset
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress

    const assetId = this.config.assetId ?? "ETH"
    const path = `/v1/vault/accounts/${this.config.vaultId}/${assetId}/addresses`
    const bodyHash = await this.hashBody("")
    const jwt = await this.createJwt(path, bodyHash)

    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        "X-API-Key": this.config.apiKey,
        Authorization: `Bearer ${jwt}`,
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Fireblocks getAddress failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as { address: string }[]
    if (!data[0]?.address) {
      throw new Error("Fireblocks returned no addresses for vault")
    }
    this.cachedAddress = data[0].address
    return data[0].address
  }

  async sendTransaction(tx: TransactionRequest): Promise<TransactionResult> {
    this.onRequest?.("sendTransaction", tx)
    const startTime = Date.now()

    const assetId = this.resolveAssetId(tx.chainId)
    const path = "/v1/transactions"

    const requestBody = {
      assetId,
      operation: "CONTRACT_CALL",
      source: {
        type: "VAULT_ACCOUNT",
        id: this.config.vaultId,
      },
      destination: {
        type: "ONE_TIME_ADDRESS",
        oneTimeAddress: { address: tx.to },
      },
      amount: tx.value === "0" ? "0" : tx.value,
      extraParameters: {
        contractCallData: tx.data,
      },
    }

    const bodyStr = JSON.stringify(requestBody)
    const bodyHash = await this.hashBody(bodyStr)
    const jwt = await this.createJwt(path, bodyHash)

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.config.apiKey,
        Authorization: `Bearer ${jwt}`,
      },
      body: bodyStr,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Fireblocks sendTransaction failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as { id: string; txHash?: string }

    if (data.txHash) {
      const result = { hash: data.txHash }
      this.onResponse?.("sendTransaction", result, Date.now() - startTime)
      return result
    }

    const result = await this.waitForTransaction(data.id)
    this.onResponse?.("sendTransaction", result, Date.now() - startTime)
    return result
  }

  async signMessage(request: SignMessageRequest): Promise<string> {
    this.onRequest?.("signMessage", request)
    const startTime = Date.now()

    const hash = Buffer.from(hashPersonalMessage(request.message)).toString(
      "hex",
    )
    const signature = await this.signRawMessage(hash)
    this.onResponse?.("signMessage", signature, Date.now() - startTime)
    return signature
  }

  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    this.onRequest?.("signTypedData", request)
    const startTime = Date.now()

    const hash = Buffer.from(
      hashTypedData(
        request.domain,
        request.primaryType,
        request.message,
        request.types as Record<string, Array<{ name: string; type: string }>>,
      ),
    ).toString("hex")
    const signature = await this.signRawMessage(hash)
    this.onResponse?.("signTypedData", signature, Date.now() - startTime)
    return signature
  }

  private async signRawMessage(hashHex: string): Promise<string> {
    const path = "/v1/transactions"
    const requestBody = {
      assetId: this.config.assetId ?? "ETH",
      operation: "RAW",
      source: {
        type: "VAULT_ACCOUNT",
        id: this.config.vaultId,
      },
      extraParameters: {
        rawMessageData: {
          messages: [
            {
              content: hashHex,
            },
          ],
        },
      },
    }

    const bodyStr = JSON.stringify(requestBody)
    const bodyHash = await this.hashBody(bodyStr)
    const jwt = await this.createJwt(path, bodyHash)

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.config.apiKey,
        Authorization: `Bearer ${jwt}`,
      },
      body: bodyStr,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Fireblocks signRawMessage failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as { id: string }
    return this.waitForSignature(data.id)
  }

  private async waitForSignature(txId: string): Promise<string> {
    const maxAttempts = this.config.maxPollAttempts ?? 60
    const pollIntervalMs = 2000

    for (let i = 0; i < maxAttempts; i++) {
      const path = `/v1/transactions/${txId}`
      const bodyHash = await this.hashBody("")
      const jwt = await this.createJwt(path, bodyHash)

      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          "X-API-Key": this.config.apiKey,
          Authorization: `Bearer ${jwt}`,
        },
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(
          `Fireblocks signature poll failed (${response.status}): ${body}`,
        )
      }

      const data = (await response.json()) as {
        status: string
        signedMessages?: Array<{
          signature: { r: string; s: string; v: number }
        }>
      }

      if (data.status === "COMPLETED" && data.signedMessages?.[0]) {
        const { r, s, v } = data.signedMessages[0].signature
        const rHex = r.padStart(64, "0")
        const sHex = s.padStart(64, "0")
        // Fireblocks RAW op returns recovery bit (0 or 1); Ethereum expects 27 or 28.
        const vHex = (v + 27).toString(16).padStart(2, "0")
        return `0x${rHex}${sHex}${vHex}`
      }

      if (
        data.status === "FAILED" ||
        data.status === "REJECTED" ||
        data.status === "CANCELLED" ||
        data.status === "BLOCKED"
      ) {
        throw new Error(
          `Fireblocks signing ${txId} ended with status: ${data.status}`,
        )
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(
      `Fireblocks signing ${txId} did not complete within ${(maxAttempts * pollIntervalMs) / 1000}s`,
    )
  }

  private async waitForTransaction(txId: string): Promise<TransactionResult> {
    const maxAttempts = this.config.maxPollAttempts ?? 60
    const pollIntervalMs = 2000

    for (let i = 0; i < maxAttempts; i++) {
      const path = `/v1/transactions/${txId}`
      const bodyHash = await this.hashBody("")
      const jwt = await this.createJwt(path, bodyHash)

      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          "X-API-Key": this.config.apiKey,
          Authorization: `Bearer ${jwt}`,
        },
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Fireblocks poll failed (${response.status}): ${body}`)
      }

      const data = (await response.json()) as {
        status: string
        txHash?: string
      }

      if (data.status === "COMPLETED" && data.txHash) {
        return { hash: data.txHash }
      }

      if (
        data.status === "FAILED" ||
        data.status === "REJECTED" ||
        data.status === "CANCELLED" ||
        data.status === "BLOCKED"
      ) {
        throw new Error(
          `Fireblocks transaction ${txId} ended with status: ${data.status}`,
        )
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(
      `Fireblocks transaction ${txId} did not complete within ${(maxAttempts * pollIntervalMs) / 1000}s`,
    )
  }
}
