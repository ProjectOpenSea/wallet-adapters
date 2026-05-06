/**
 * Turnkey wallet adapter.
 *
 * Uses Turnkey's API to sign and send transactions via HSM-backed
 * signing infrastructure. Authentication uses Turnkey's stamp scheme:
 * each request body is hashed and signed with a P-256 ECDSA key.
 *
 * # Security model
 *
 * This adapter is **signing-only by design.** It exposes only the
 * primitives an agent needs to sign transactions and read user
 * metadata: `getAddress`, `sendTransaction`, `signMessage`,
 * `signTypedData`, and `getWalletInfo`. Future contributors: **do not
 * add `createPolicy`, `deletePolicy`, `createApiKeys`, `updateUser`,
 * `exportWallet`, or any other administrative activity submission to
 * this adapter.** If they exist, an agent will find and use them.
 *
 * Effective hardening requires creating the API user as a **non-root
 * user** with a tightly scoped sign-only policy:
 *
 *   1. Root users in Turnkey bypass the policy engine entirely. A
 *      leaked root-user API key has the same blast radius as a raw
 *      private key — it can sign anything, mutate any policy, mint new
 *      wallets, and export keys. Do not use a root user as the agent's
 *      API user.
 *
 *   2. Create a non-root API user, then attach a policy that allows
 *      only `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` (and
 *      `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2` if EIP-712 is needed) for
 *      the wallet addresses the agent should be able to sign for.
 *      Default-deny on everything else; Turnkey policies default to
 *      deny so this is mostly a matter of writing the allowlist.
 *
 *   3. Note that Turnkey policies are stateless per-activity
 *      evaluators — they cannot enforce aggregate (daily/weekly) caps.
 *      Use the hot/cold wallet float pattern documented in
 *      `packages/skill/opensea-wallet/references/wallet-funding.md`
 *      for aggregate ceilings.
 *
 * `getWalletInfo()` calls `whoami` and `get_organization` to surface
 * whether the API user is in the root quorum, so `opensea wallet info`
 * can warn loudly if the agent is running as root.
 *
 * Required environment variables:
 *   TURNKEY_API_PUBLIC_KEY   — Turnkey API public key (hex-encoded)
 *   TURNKEY_API_PRIVATE_KEY  — Turnkey API private key (hex-encoded P-256)
 *   TURNKEY_ORGANIZATION_ID  — Turnkey organization ID
 *   TURNKEY_WALLET_ADDRESS   — Ethereum address managed by Turnkey
 *   TURNKEY_RPC_URL          — RPC endpoint for gas estimation and broadcast
 *
 * Optional:
 *   TURNKEY_API_BASE_URL   — Override the Turnkey API base URL
 *   TURNKEY_PRIVATE_KEY_ID — Turnkey private key ID (for signing with a specific key)
 *
 * @see https://docs.turnkey.com/concepts/policies/overview
 * @see https://docs.turnkey.com/concepts/users/best-practices
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
import { hashPersonalMessage, hashTypedData } from "../util/eip712.js"

export interface TurnkeyConfig {
  apiPublicKey: string
  apiPrivateKey: string
  organizationId: string
  walletAddress: string
  rpcUrl: string
  privateKeyId?: string
  baseUrl?: string
}

const TURNKEY_API_BASE = "https://api.turnkey.com"

export class TurnkeyAdapter implements WalletAdapter {
  readonly name = "turnkey"
  readonly capabilities: WalletCapabilities = {
    signMessage: true,
    signTypedData: true,
    managedGas: false,
    managedNonce: false,
  }
  onRequest?: (method: string, params: unknown) => void
  onResponse?: (method: string, result: unknown, durationMs: number) => void
  private config: TurnkeyConfig

  constructor(config: TurnkeyConfig) {
    this.config = config
  }

  static fromEnv(): TurnkeyAdapter {
    const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY
    const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY
    const organizationId = process.env.TURNKEY_ORGANIZATION_ID
    const walletAddress = process.env.TURNKEY_WALLET_ADDRESS

    if (!apiPublicKey) {
      throw new Error("TURNKEY_API_PUBLIC_KEY environment variable is required")
    }
    if (!apiPrivateKey) {
      throw new Error(
        "TURNKEY_API_PRIVATE_KEY environment variable is required",
      )
    }
    if (!organizationId) {
      throw new Error(
        "TURNKEY_ORGANIZATION_ID environment variable is required",
      )
    }
    if (!walletAddress) {
      throw new Error("TURNKEY_WALLET_ADDRESS environment variable is required")
    }

    const rpcUrl = process.env.TURNKEY_RPC_URL
    if (!rpcUrl) {
      throw new Error(
        "TURNKEY_RPC_URL environment variable is required. " +
          "It is used for gas estimation and transaction broadcasting.",
      )
    }

    return new TurnkeyAdapter({
      apiPublicKey,
      apiPrivateKey,
      organizationId,
      walletAddress,
      rpcUrl,
      privateKeyId: process.env.TURNKEY_PRIVATE_KEY_ID,
      baseUrl: process.env.TURNKEY_API_BASE_URL,
    })
  }

  getRpcUrl(): string {
    return this.config.rpcUrl
  }

  private get baseUrl(): string {
    return this.config.baseUrl ?? TURNKEY_API_BASE
  }

  private async stamp(body: string): Promise<string> {
    const encoder = new TextEncoder()
    const bodyHash = await crypto.subtle.digest("SHA-256", encoder.encode(body))

    const keyData = hexToBytes(this.config.apiPrivateKey)
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      derEncodeP256PrivateKey(keyData),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    )

    // WebCrypto ECDSA sign hashes internally, so this signs SHA-256(SHA-256(body)).
    // Turnkey's server verifier expects this — matches packages/cli/src/wallet/turnkey.ts.
    const p1363Sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      bodyHash,
    )

    const derSig = p1363ToDer(new Uint8Array(p1363Sig))
    const signatureHex = bytesToHex(derSig)

    const stampJson = JSON.stringify({
      publicKey: this.config.apiPublicKey,
      scheme: "SIGNATURE_SCHEME_TK_API_P256",
      signature: signatureHex,
    })

    return Buffer.from(stampJson).toString("base64url")
  }

  private async signedRequest(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const bodyStr = JSON.stringify(body)
    const stampValue = await this.stamp(bodyStr)

    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stamp": stampValue,
      },
      body: bodyStr,
    })
  }

  async getAddress(): Promise<string> {
    return this.config.walletAddress
  }

  async getWalletInfo(): Promise<WalletInfo> {
    const whoamiResponse = await this.signedRequest("/public/v1/query/whoami", {
      organizationId: this.config.organizationId,
    })

    if (!whoamiResponse.ok) {
      const body = await whoamiResponse.text()
      throw new Error(
        `Turnkey getWalletInfo whoami failed (${whoamiResponse.status}): ${body}`,
      )
    }

    const whoami = (await whoamiResponse.json()) as {
      organizationId: string
      organizationName?: string
      userId: string
      username?: string
    }

    const orgResponse = await this.signedRequest(
      "/public/v1/query/get_organization",
      { organizationId: this.config.organizationId },
    )

    if (!orgResponse.ok) {
      const body = await orgResponse.text()
      throw new Error(
        `Turnkey getWalletInfo get_organization failed (${orgResponse.status}): ${body}`,
      )
    }

    const orgData = (await orgResponse.json()) as {
      organizationData?: {
        rootQuorum?: { userIds?: string[] }
      }
    }
    const rootUserIds = orgData.organizationData?.rootQuorum?.userIds ?? []

    return {
      provider: "turnkey",
      address: this.config.walletAddress,
      organizationId: whoami.organizationId,
      userId: whoami.userId,
      username: whoami.username ?? "",
      isRootUser: rootUserIds.includes(whoami.userId),
    }
  }

  async sendTransaction(tx: TransactionRequest): Promise<TransactionResult> {
    this.onRequest?.("sendTransaction", tx)
    const startTime = Date.now()

    const { rpcUrl } = this.config
    const gasParams = await this.estimateGasParams(rpcUrl, tx)

    const rlpHex = rlpEncodeEip1559Tx({
      chainId: tx.chainId,
      nonce: gasParams.nonce,
      maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
      maxFeePerGas: gasParams.maxFeePerGas,
      gasLimit: gasParams.gasLimit,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    })

    const signWith = this.config.privateKeyId ?? this.config.walletAddress

    const response = await this.signedRequest(
      "/public/v1/submit/sign_transaction",
      {
        type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
        organizationId: this.config.organizationId,
        timestampMs: Date.now().toString(),
        parameters: {
          signWith,
          type: "TRANSACTION_TYPE_ETHEREUM",
          unsignedTransaction: rlpHex,
        },
      },
    )

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Turnkey sendTransaction failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as {
      activity: {
        status: string
        result?: {
          signTransactionResult?: { signedTransaction: string }
        }
      }
    }

    const signedTx =
      data.activity.result?.signTransactionResult?.signedTransaction
    if (!signedTx) {
      throw new Error(
        `Turnkey sign transaction did not return a signed payload (activity status: ${data.activity.status})`,
      )
    }

    const rpcResponse = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [signedTx],
      }),
    })

    if (!rpcResponse.ok) {
      const rpcBody = await rpcResponse.text()
      throw new Error(
        `Turnkey broadcast failed (${rpcResponse.status}): ${rpcBody}`,
      )
    }

    const rpcData = (await rpcResponse.json()) as {
      result?: string
      error?: { message: string }
    }

    if (rpcData.error) {
      throw new Error(`Turnkey broadcast RPC error: ${rpcData.error.message}`)
    }

    if (!rpcData.result) {
      throw new Error("Turnkey broadcast returned no tx hash")
    }

    const result = { hash: rpcData.result }
    this.onResponse?.("sendTransaction", result, Date.now() - startTime)
    return result
  }

  async signMessage(request: SignMessageRequest): Promise<string> {
    this.onRequest?.("signMessage", request)
    const startTime = Date.now()

    const hash = bytesToHex(hashPersonalMessage(request.message))
    const signature = await this.signRawPayload(hash)
    this.onResponse?.("signMessage", signature, Date.now() - startTime)
    return signature
  }

  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    this.onRequest?.("signTypedData", request)
    const startTime = Date.now()

    const hash = bytesToHex(
      hashTypedData(
        request.domain,
        request.primaryType,
        request.message,
        request.types as Record<string, Array<{ name: string; type: string }>>,
      ),
    )
    const signature = await this.signRawPayload(hash)
    this.onResponse?.("signTypedData", signature, Date.now() - startTime)
    return signature
  }

  private async signRawPayload(hashHex: string): Promise<string> {
    const signWith = this.config.privateKeyId ?? this.config.walletAddress

    const response = await this.signedRequest(
      "/public/v1/submit/sign_raw_payload",
      {
        type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
        organizationId: this.config.organizationId,
        timestampMs: Date.now().toString(),
        parameters: {
          signWith,
          payload: hashHex,
          encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
          hashFunction: "HASH_FUNCTION_NO_OP",
        },
      },
    )

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Turnkey signRawPayload failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as {
      activity: {
        status: string
        result?: {
          signRawPayloadResult?: { r: string; s: string; v: string }
        }
      }
    }

    const sigResult = data.activity.result?.signRawPayloadResult
    if (!sigResult) {
      throw new Error(
        `Turnkey sign raw payload did not return a result (status: ${data.activity.status})`,
      )
    }

    const r = sigResult.r.padStart(64, "0")
    const s = sigResult.s.padStart(64, "0")
    const vNum = Number.parseInt(sigResult.v, 16) + 27
    const v = vNum.toString(16).padStart(2, "0")
    return `0x${r}${s}${v}`
  }

  private async estimateGasParams(
    rpcUrl: string,
    tx: TransactionRequest,
  ): Promise<{
    nonce: bigint
    gasLimit: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
  }> {
    // Use pre-estimated values if provided by caller (avoids double estimation)
    if (tx.gas && tx.nonce !== undefined && tx.maxFeePerGas) {
      return {
        nonce: BigInt(tx.nonce),
        gasLimit: BigInt(tx.gas),
        maxFeePerGas: BigInt(tx.maxFeePerGas),
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas
          ? BigInt(tx.maxPriorityFeePerGas)
          : 1_500_000_000n,
      }
    }

    const from = this.config.walletAddress
    const txValue =
      tx.value === "0" ? "0x0" : `0x${BigInt(tx.value).toString(16)}`

    const [nonceResult, gasEstimateResult, feeDataResult] = await Promise.all([
      this.rpcCall(rpcUrl, "eth_getTransactionCount", [from, "pending"]),
      this.rpcCall(rpcUrl, "eth_estimateGas", [
        {
          from,
          to: tx.to,
          data: tx.data || "0x",
          value: txValue,
        },
      ]),
      this.rpcCall(rpcUrl, "eth_feeHistory", [1, "latest", [50]]),
    ])

    const nonce = BigInt(nonceResult as string)

    const rawGasLimit = BigInt(gasEstimateResult as string)
    const gasLimit = (rawGasLimit * 120n) / 100n

    const feeHistory = feeDataResult as {
      baseFeePerGas: string[]
      reward?: string[][]
    }
    const latestBaseFee = BigInt(
      feeHistory.baseFeePerGas[1] ?? feeHistory.baseFeePerGas[0],
    )
    const maxPriorityFeePerGas = feeHistory.reward?.[0]?.[0]
      ? BigInt(feeHistory.reward[0][0])
      : 1_500_000_000n

    const maxFeePerGas = latestBaseFee * 2n + maxPriorityFeePerGas

    return { nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas }
  }

  private async rpcCall(
    rpcUrl: string,
    method: string,
    params: unknown[],
  ): Promise<unknown> {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Turnkey RPC ${method} failed (${response.status}): ${body}`,
      )
    }

    const data = (await response.json()) as {
      result?: unknown
      error?: { message: string }
    }

    if (data.error) {
      throw new Error(`Turnkey RPC ${method} error: ${data.error.message}`)
    }

    return data.result
  }
}

/**
 * RLP-encode an unsigned EIP-1559 (type 2) transaction.
 * Returns hex string without 0x prefix, as expected by Turnkey.
 */
export function rlpEncodeEip1559Tx(tx: {
  chainId: number
  nonce: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  gasLimit: bigint
  to: string
  data: string
  value: string
}): string {
  const chainIdBytes = bigIntToBytes(BigInt(tx.chainId))
  const nonce = bigIntToBytes(tx.nonce)
  const maxPriorityFeePerGas = bigIntToBytes(tx.maxPriorityFeePerGas)
  const maxFeePerGas = bigIntToBytes(tx.maxFeePerGas)
  const gasLimit = bigIntToBytes(tx.gasLimit)
  const toBytes = hexToBytes(tx.to)
  const valueBytes =
    tx.value === "0" ? new Uint8Array(0) : bigIntToBytes(BigInt(tx.value))
  const dataBytes = tx.data ? hexToBytes(tx.data) : new Uint8Array(0)

  const fields = [
    rlpEncodeBytes(chainIdBytes),
    rlpEncodeBytes(nonce),
    rlpEncodeBytes(maxPriorityFeePerGas),
    rlpEncodeBytes(maxFeePerGas),
    rlpEncodeBytes(gasLimit),
    rlpEncodeBytes(toBytes),
    rlpEncodeBytes(valueBytes),
    rlpEncodeBytes(dataBytes),
    rlpEncodeList([]),
  ]

  const rlpList = rlpEncodeList(fields)

  const result = new Uint8Array(1 + rlpList.length)
  result[0] = 0x02
  result.set(rlpList, 1)

  return bytesToHex(result)
}

function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 0x80) {
    return bytes
  }
  if (bytes.length === 0) {
    return new Uint8Array([0x80])
  }
  if (bytes.length <= 55) {
    const result = new Uint8Array(1 + bytes.length)
    result[0] = 0x80 + bytes.length
    result.set(bytes, 1)
    return result
  }
  const lenBytes = bigIntToBytes(BigInt(bytes.length))
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

  const lenBytes = bigIntToBytes(BigInt(totalLen))
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

function bigIntToBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0)
  const hex = value.toString(16)
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`
  return hexToBytes(padded)
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16)
  }
  return bytes
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Convert an ECDSA signature from IEEE P1363 format (raw r||s) to DER encoding.
 */
export function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const r = p1363.subarray(0, 32)
  const s = p1363.subarray(32, 64)

  const rDer = integerToDer(r)
  const sDer = integerToDer(s)

  const seqLen = rDer.length + sDer.length
  const result = new Uint8Array(2 + seqLen)
  result[0] = 0x30
  result[1] = seqLen
  result.set(rDer, 2)
  result.set(sDer, 2 + rDer.length)
  return result
}

function integerToDer(bytes: Uint8Array): Uint8Array {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const stripped = bytes.subarray(start)

  const needsPad = stripped[0] >= 0x80
  const len = stripped.length + (needsPad ? 1 : 0)

  const result = new Uint8Array(2 + len)
  result[0] = 0x02
  result[1] = len
  if (needsPad) {
    result[2] = 0x00
    result.set(stripped, 3)
  } else {
    result.set(stripped, 2)
  }
  return result
}

function derEncodeP256PrivateKey(rawKey: Uint8Array): ArrayBuffer {
  const header = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
    0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
    0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
  ])

  const result = new Uint8Array(header.length + rawKey.length)
  result.set(header)
  result.set(rawKey, header.length)
  return result.buffer
}
