/**
 * Private key wallet adapter.
 *
 * Signs and sends transactions using a raw private key with secp256k1.
 *
 * Intended for development and testing. For production use, prefer a
 * managed wallet provider (Privy, Turnkey, Fireblocks).
 *
 * Required environment variables:
 *   PRIVATE_KEY — Hex-encoded private key (with or without 0x prefix)
 *   RPC_URL    — JSON-RPC endpoint for broadcasting and gas estimation
 *
 * Optional:
 *   WALLET_ADDRESS — Pre-computed address (skips derivation)
 */

import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { bytesToHex as nobleToHex } from "@noble/hashes/utils.js"
import type {
  SignMessageRequest,
  SignTypedDataRequest,
  TransactionRequest,
  TransactionResult,
  WalletAdapter,
  WalletCapabilities,
} from "../types/index.js"
import { hashPersonalMessage, hashTypedData } from "../util/eip712.js"
import { bytesToHex, hexToBytes, rlpEncodeEip1559Tx } from "./turnkey.js"

export interface PrivateKeyConfig {
  privateKey: string
  rpcUrl: string
  address?: string
}

export class PrivateKeyAdapter implements WalletAdapter {
  readonly name = "private-key"
  readonly capabilities: WalletCapabilities = {
    signMessage: true,
    signTypedData: true,
    managedGas: false,
    managedNonce: false,
  }
  onRequest?: (method: string, params: unknown) => void
  onResponse?: (method: string, result: unknown, durationMs: number) => void
  private config: PrivateKeyConfig
  private cachedAddress?: string

  constructor(config: PrivateKeyConfig) {
    this.config = config
    this.cachedAddress = config.address
  }

  static fromEnv(): PrivateKeyAdapter {
    const privateKey = process.env.PRIVATE_KEY
    const rpcUrl = process.env.RPC_URL

    if (!privateKey) {
      throw new Error("PRIVATE_KEY environment variable is required")
    }
    if (!rpcUrl) {
      throw new Error("RPC_URL environment variable is required")
    }

    const clean = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
      throw new Error(
        "PRIVATE_KEY must be a 64-character hex string (with or without 0x prefix)",
      )
    }

    return new PrivateKeyAdapter({
      privateKey,
      rpcUrl,
      address: process.env.WALLET_ADDRESS,
    })
  }

  getRpcUrl(): string {
    return this.config.rpcUrl
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress

    const clean = this.config.privateKey.startsWith("0x")
      ? this.config.privateKey.slice(2)
      : this.config.privateKey
    const pubKey = secp256k1.getPublicKey(clean, false)
    // keccak256 of uncompressed pubkey (without 04 prefix) → last 20 bytes
    const hash = keccak_256(pubKey.subarray(1))
    this.cachedAddress = `0x${nobleToHex(hash.subarray(12))}`
    return this.cachedAddress
  }

  async sendTransaction(tx: TransactionRequest): Promise<TransactionResult> {
    this.onRequest?.("sendTransaction", tx)
    const startTime = Date.now()

    const from = await this.getAddress()
    const { rpcUrl } = this.config

    let nonce: bigint
    let gasLimit: bigint
    let maxFeePerGas: bigint
    let maxPriorityFeePerGas: bigint

    if (tx.gas && tx.nonce !== undefined && tx.maxFeePerGas) {
      nonce = BigInt(tx.nonce)
      gasLimit = BigInt(tx.gas)
      maxFeePerGas = BigInt(tx.maxFeePerGas)
      maxPriorityFeePerGas = tx.maxPriorityFeePerGas
        ? BigInt(tx.maxPriorityFeePerGas)
        : 1_500_000_000n
    } else {
      const txValue =
        tx.value === "0" ? "0x0" : `0x${BigInt(tx.value).toString(16)}`

      const [nonceResult, gasEstimateResult, feeDataResult] = await Promise.all(
        [
          this.rpcCall(rpcUrl, "eth_getTransactionCount", [from, "pending"]),
          this.rpcCall(rpcUrl, "eth_estimateGas", [
            { from, to: tx.to, data: tx.data || "0x", value: txValue },
          ]),
          this.rpcCall(rpcUrl, "eth_feeHistory", [1, "latest", [50]]),
        ],
      )

      nonce = BigInt(nonceResult as string)
      const rawGas = BigInt(gasEstimateResult as string)
      gasLimit = (rawGas * 120n) / 100n

      const feeHistory = feeDataResult as {
        baseFeePerGas: string[]
        reward?: string[][]
      }
      const latestBaseFee = BigInt(
        feeHistory.baseFeePerGas[1] ?? feeHistory.baseFeePerGas[0],
      )
      maxPriorityFeePerGas = feeHistory.reward?.[0]?.[0]
        ? BigInt(feeHistory.reward[0][0])
        : 1_500_000_000n
      maxFeePerGas = latestBaseFee * 2n + maxPriorityFeePerGas
    }

    // RLP-encode unsigned EIP-1559 tx (includes 0x02 type prefix)
    const unsignedHex = rlpEncodeEip1559Tx({
      chainId: tx.chainId,
      nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    })

    // Hash the typed envelope for signing
    const unsignedBytes = hexToBytes(unsignedHex)
    const txHash = keccak_256(unsignedBytes)

    // Sign with secp256k1 (RFC 6979 deterministic k)
    const clean = this.config.privateKey.startsWith("0x")
      ? this.config.privateKey.slice(2)
      : this.config.privateKey
    const sig = secp256k1.sign(txHash, clean)

    // Encode signed tx
    const signedHex = encodeSignedEip1559Tx(
      {
        chainId: tx.chainId,
        nonce,
        maxPriorityFeePerGas,
        maxFeePerGas,
        gasLimit,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      },
      sig.recovery,
      sig.r,
      sig.s,
    )

    // Broadcast
    const hash = (await this.rpcCall(rpcUrl, "eth_sendRawTransaction", [
      `0x${signedHex}`,
    ])) as string

    const result = { hash }
    this.onResponse?.("sendTransaction", result, Date.now() - startTime)
    return result
  }

  async signMessage(request: SignMessageRequest): Promise<string> {
    this.onRequest?.("signMessage", request)
    const startTime = Date.now()

    const hash = hashPersonalMessage(request.message)
    const clean = this.config.privateKey.startsWith("0x")
      ? this.config.privateKey.slice(2)
      : this.config.privateKey
    const sig = secp256k1.sign(hash, clean)
    const result = encodeEcdsaSignature(sig.r, sig.s, sig.recovery)
    this.onResponse?.("signMessage", result, Date.now() - startTime)
    return result
  }

  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    this.onRequest?.("signTypedData", request)
    const startTime = Date.now()

    const hash = hashTypedData(
      request.domain,
      request.primaryType,
      request.message,
      request.types as Record<string, Array<{ name: string; type: string }>>,
    )
    const clean = this.config.privateKey.startsWith("0x")
      ? this.config.privateKey.slice(2)
      : this.config.privateKey
    const sig = secp256k1.sign(hash, clean)
    const result = encodeEcdsaSignature(sig.r, sig.s, sig.recovery)
    this.onResponse?.("signTypedData", result, Date.now() - startTime)
    return result
  }

  private async rpcCall(
    rpcUrl: string,
    method: string,
    params: unknown[],
  ): Promise<unknown> {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`RPC ${method} failed (${response.status}): ${body}`)
    }

    const data = (await response.json()) as {
      result?: unknown
      error?: { message: string }
    }

    if (data.error) {
      throw new Error(`RPC ${method} error: ${data.error.message}`)
    }

    return data.result
  }
}

function bigIntToMinBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0)
  const hex = value.toString(16)
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`
  return hexToBytes(padded)
}

function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes
  if (bytes.length === 0) return new Uint8Array([0x80])
  if (bytes.length <= 55) {
    const result = new Uint8Array(1 + bytes.length)
    result[0] = 0x80 + bytes.length
    result.set(bytes, 1)
    return result
  }
  const lenBytes = bigIntToMinBytes(BigInt(bytes.length))
  const result = new Uint8Array(1 + lenBytes.length + bytes.length)
  result[0] = 0xb7 + lenBytes.length
  result.set(lenBytes, 1)
  result.set(bytes, 1 + lenBytes.length)
  return result
}

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  let totalLen = 0
  for (const item of items) totalLen += item.length
  if (totalLen <= 55) {
    const result = new Uint8Array(1 + totalLen)
    result[0] = 0xc0 + totalLen
    let offset = 1
    for (const item of items) {
      result.set(item, offset)
      offset += item.length
    }
    return result
  }
  const lenBytes = bigIntToMinBytes(BigInt(totalLen))
  const result = new Uint8Array(1 + lenBytes.length + totalLen)
  result[0] = 0xf7 + lenBytes.length
  result.set(lenBytes, 1)
  let offset = 1 + lenBytes.length
  for (const item of items) {
    result.set(item, offset)
    offset += item.length
  }
  return result
}

function encodeSignedEip1559Tx(
  tx: {
    chainId: number
    nonce: bigint
    maxPriorityFeePerGas: bigint
    maxFeePerGas: bigint
    gasLimit: bigint
    to: string
    data: string
    value: string
  },
  v: number,
  r: bigint,
  s: bigint,
): string {
  const fields = [
    rlpEncodeBytes(bigIntToMinBytes(BigInt(tx.chainId))),
    rlpEncodeBytes(bigIntToMinBytes(tx.nonce)),
    rlpEncodeBytes(bigIntToMinBytes(tx.maxPriorityFeePerGas)),
    rlpEncodeBytes(bigIntToMinBytes(tx.maxFeePerGas)),
    rlpEncodeBytes(bigIntToMinBytes(tx.gasLimit)),
    rlpEncodeBytes(hexToBytes(tx.to)),
    rlpEncodeBytes(
      tx.value === "0" ? new Uint8Array(0) : bigIntToMinBytes(BigInt(tx.value)),
    ),
    rlpEncodeBytes(tx.data ? hexToBytes(tx.data) : new Uint8Array(0)),
    rlpEncodeList([]), // empty access list
    rlpEncodeBytes(v === 0 ? new Uint8Array(0) : new Uint8Array([v])),
    rlpEncodeBytes(bigIntToMinBytes(r)),
    rlpEncodeBytes(bigIntToMinBytes(s)),
  ]

  const rlpList = rlpEncodeList(fields)
  const signed = new Uint8Array(1 + rlpList.length)
  signed[0] = 0x02
  signed.set(rlpList, 1)
  return bytesToHex(signed)
}

function encodeEcdsaSignature(r: bigint, s: bigint, v: number): string {
  const rHex = r.toString(16).padStart(64, "0")
  const sHex = s.toString(16).padStart(64, "0")
  const vHex = (v + 27).toString(16).padStart(2, "0")
  return `0x${rHex}${sHex}${vHex}`
}
