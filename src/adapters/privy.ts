/**
 * Privy wallet adapter.
 *
 * Uses Privy's server-side wallet API to sign and send transactions.
 * Transactions are governed by Privy's programmable policy engine —
 * policies are evaluated in a trusted execution environment before signing.
 *
 * # Security model
 *
 * This adapter is **signing-only by design.** It exposes only the
 * primitives an agent needs to sign transactions and read wallet
 * metadata: `getAddress`, `sendTransaction`, `signMessage`,
 * `signTypedData`, and `getWalletInfo`. It deliberately does not, and
 * should not, expose policy mutation, owner-key rotation, additional-
 * signer changes, key export, or wallet deletion. Future contributors:
 * **do not add `setPolicy`, `rotateOwner`, `addSigner`, or similar
 * mutation methods to this adapter.** If they exist, an agent will find
 * and use them — including raising its own spending cap.
 *
 * Effective hardening requires Privy-side configuration in addition to
 * this adapter's defaults:
 *
 *   1. Create the wallet with an `owner_id` (a key quorum). The owner's
 *      private key MUST live outside the agent environment — on a
 *      trusted operator machine, in a hardware wallet, or in a separate
 *      vault. The owner gates all `PATCH /v1/wallets/{id}` and similar
 *      administrative operations.
 *
 *   2. Register the agent's signing key as an `additional_signer` on the
 *      wallet, with `override_policy_ids` set to the policy you want
 *      the agent to be subject to. The agent's signing key may live in
 *      env (`PRIVY_AUTH_SIGNING_KEY`) — it has signing power but cannot
 *      mutate policy, signers, or owner.
 *
 *   3. Apply a Privy policy that caps per-tx spend, allowlists
 *      contracts, and restricts chains. Policies are stateless per-tx
 *      evaluators — they cannot enforce aggregate (daily/weekly)
 *      caps. Use the hot/cold wallet float pattern documented in
 *      `packages/skill/opensea-wallet/references/wallet-funding.md`
 *      for aggregate ceilings.
 *
 * Required environment variables:
 *   PRIVY_APP_ID      — Privy application ID
 *   PRIVY_APP_SECRET  — Privy application secret
 *   PRIVY_WALLET_ID   — Wallet ID to use for signing
 *
 * Optional:
 *   PRIVY_API_BASE_URL      — Override the Privy API base URL
 *   PRIVY_AUTH_SIGNING_KEY  — Base64-encoded PKCS8 P-256 private key for
 *                             an `additional_signer` on this wallet. When
 *                             set, the adapter signs every POST /rpc
 *                             request with it and attaches the
 *                             `privy-authorization-signature` header.
 *                             Required when the wallet has an `owner_id`
 *                             set; ignored when it does not.
 *
 * @see https://docs.privy.io/wallets/wallets
 * @see https://docs.privy.io/controls/policies/overview
 * @see https://docs.privy.io/controls/authorization-keys/overview
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

export interface PrivyConfig {
  appId: string
  appSecret: string
  walletId: string
  baseUrl?: string
  /**
   * Optional base64-encoded PKCS8 P-256 authorization private key.
   * When set, every POST /v1/wallets/{id}/rpc request is signed with it
   * and the resulting signature is attached as
   * `privy-authorization-signature`. Use this when the wallet has an
   * `owner_id` configured and the agent's key is registered as an
   * `additional_signer`.
   */
  authSigningKey?: string
}

const PRIVY_API_BASE = "https://api.privy.io"

const PRIVY_401_ECHO_HINT =
  " (hint: if you're verifying credentials via curl, use " +
  `'printf %s "$PRIVY_APP_ID:$PRIVY_APP_SECRET" | base64' — ` +
  "'echo' adds a trailing newline that breaks basic auth)"

interface PrivyWalletResponse {
  id: string
  address: string
  chain_type: string
  policy_ids?: string[]
  owner_id?: string | null
  additional_signers?: Array<{ signer_id: string }>
}

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
      authSigningKey: process.env.PRIVY_AUTH_SIGNING_KEY,
    })
  }

  private get baseUrl(): string {
    return this.config.baseUrl ?? PRIVY_API_BASE
  }

  private get basicAuthHeaders(): Record<string, string> {
    const credentials = Buffer.from(
      `${this.config.appId}:${this.config.appSecret}`,
    ).toString("base64")
    return {
      Authorization: `Basic ${credentials}`,
      "privy-app-id": this.config.appId,
      "Content-Type": "application/json",
    }
  }

  /**
   * Build headers for a POST /rpc call, including the authorization
   * signature when `authSigningKey` is configured. Lazy-imports
   * `@privy-io/node` so users who don't enable auth-key signing don't
   * need the optional peer dependency installed.
   */
  private async rpcHeaders(
    body: Record<string, unknown>,
    rpcUrl: string,
  ): Promise<Record<string, string>> {
    const headers = { ...this.basicAuthHeaders }
    if (!this.config.authSigningKey) return headers

    let generateAuthorizationSignature: typeof import("@privy-io/node").generateAuthorizationSignature
    try {
      ;({ generateAuthorizationSignature } = await import("@privy-io/node"))
    } catch (cause) {
      throw new Error(
        "PRIVY_AUTH_SIGNING_KEY is set but @privy-io/node is not installed. " +
          "Install it with `pnpm add @privy-io/node` (or your package manager equivalent).",
        { cause: cause as Error },
      )
    }

    const signature = generateAuthorizationSignature({
      authorizationPrivateKey: this.config.authSigningKey,
      input: {
        version: 1,
        method: "POST",
        url: rpcUrl,
        body,
        headers: { "privy-app-id": this.config.appId },
      },
    })
    headers["privy-authorization-signature"] = signature
    return headers
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress

    const response = await fetch(
      `${this.baseUrl}/v1/wallets/${this.config.walletId}`,
      { headers: this.basicAuthHeaders },
    )

    if (!response.ok) {
      const body = await response.text()
      const hint =
        response.status === 401 && body.includes("Invalid app ID or app secret")
          ? PRIVY_401_ECHO_HINT
          : ""
      throw new Error(
        `Privy getAddress failed (${response.status}): ${body}${hint}`,
      )
    }

    const data = (await response.json()) as PrivyWalletResponse
    this.cachedAddress = data.address
    return data.address
  }

  async getWalletInfo(): Promise<WalletInfo> {
    const response = await fetch(
      `${this.baseUrl}/v1/wallets/${this.config.walletId}`,
      { headers: this.basicAuthHeaders },
    )

    if (!response.ok) {
      const body = await response.text()
      const hint =
        response.status === 401 && body.includes("Invalid app ID or app secret")
          ? PRIVY_401_ECHO_HINT
          : ""
      throw new Error(
        `Privy getWalletInfo failed (${response.status}): ${body}${hint}`,
      )
    }

    const data = (await response.json()) as PrivyWalletResponse
    // Same endpoint as getAddress(); seed the cache so a follow-up
    // getAddress() call (common in `wallet info` flows) doesn't re-fetch.
    this.cachedAddress = data.address
    const ownerKeyId = data.owner_id ?? null
    return {
      provider: "privy",
      address: data.address,
      chainType: data.chain_type,
      policyIds: data.policy_ids ?? [],
      ownerKeyId,
      additionalSignerCount: data.additional_signers?.length ?? 0,
      ownerEnforcesAuthKey: ownerKeyId !== null,
    }
  }

  async sendTransaction(tx: TransactionRequest): Promise<TransactionResult> {
    this.onRequest?.("sendTransaction", tx)
    const startTime = Date.now()

    const caip2 = `eip155:${tx.chainId}`
    const rpcUrl = `${this.baseUrl}/v1/wallets/${this.config.walletId}/rpc`

    const body = {
      method: "eth_sendTransaction",
      caip2,
      params: {
        transaction: {
          to: tx.to,
          data: tx.data,
          value: tx.value,
        },
      },
    }

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: await this.rpcHeaders(body, rpcUrl),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const responseBody = await response.text()
      throw new Error(
        `Privy sendTransaction failed (${response.status}): ${responseBody}`,
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

    const isBytes = typeof request.message !== "string"
    const message = isBytes
      ? `0x${Buffer.from(request.message as Uint8Array).toString("hex")}`
      : (request.message as string)

    const rpcUrl = `${this.baseUrl}/v1/wallets/${this.config.walletId}/rpc`
    const body = {
      method: "personal_sign",
      params: { message, encoding: isBytes ? "hex" : "utf-8" },
    }

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: await this.rpcHeaders(body, rpcUrl),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const responseBody = await response.text()
      throw new Error(
        `Privy signMessage failed (${response.status}): ${responseBody}`,
      )
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

    const rpcUrl = `${this.baseUrl}/v1/wallets/${this.config.walletId}/rpc`
    const body = {
      method: "eth_signTypedData_v4",
      params: {
        typedData: JSON.stringify({
          domain: request.domain,
          types: request.types,
          primaryType: request.primaryType,
          message: request.message,
        }),
      },
    }

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: await this.rpcHeaders(body, rpcUrl),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const responseBody = await response.text()
      throw new Error(
        `Privy signTypedData failed (${response.status}): ${responseBody}`,
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
