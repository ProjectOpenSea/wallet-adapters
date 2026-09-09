/**
 * Shared HTTP surface for the Privy adapters.
 *
 * `PrivyAdapter` (EVM) and `PrivySvmAdapter` (Solana) speak to the same two endpoints with the
 * same credentials and the same authorization-signature scheme. Only the RPC method names and
 * payloads differ, so everything else lives here rather than in two copies that drift.
 *
 * The security model, and the list of methods deliberately absent from these adapters, is
 * documented at the top of `privy.ts`. It applies to both chains: this transport exposes signing
 * and read-only introspection, never policy or signer mutation.
 */

import type { WalletInfo } from "../types/index.js"

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

export const PRIVY_API_BASE = "https://api.privy.io"

const PRIVY_401_ECHO_HINT =
  " (hint: if you're verifying credentials via curl, use " +
  `'printf %s "$PRIVY_APP_ID:$PRIVY_APP_SECRET" | base64' — ` +
  "'echo' adds a trailing newline that breaks basic auth)"

export interface PrivyWalletResponse {
  id: string
  address: string
  chain_type: string
  policy_ids?: string[]
  owner_id?: string | null
  additional_signers?: Array<{ signer_id: string }>
}

/** Reads the three required variables for a wallet on one chain, or throws naming the missing one. */
export function privyConfigFromEnv(walletIdVar: string): PrivyConfig {
  const appId = process.env.PRIVY_APP_ID
  const appSecret = process.env.PRIVY_APP_SECRET
  const walletId = process.env[walletIdVar]

  if (!appId) {
    throw new Error("PRIVY_APP_ID environment variable is required")
  }
  if (!appSecret) {
    throw new Error("PRIVY_APP_SECRET environment variable is required")
  }
  if (!walletId) {
    throw new Error(`${walletIdVar} environment variable is required`)
  }

  return {
    appId,
    appSecret,
    walletId,
    baseUrl: process.env.PRIVY_API_BASE_URL,
    authSigningKey: process.env.PRIVY_AUTH_SIGNING_KEY,
  }
}

export class PrivyTransport {
  private cachedAddress?: string

  constructor(readonly config: PrivyConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl ?? PRIVY_API_BASE
  }

  get rpcUrl(): string {
    return `${this.baseUrl}/v1/wallets/${this.config.walletId}/rpc`
  }

  get basicAuthHeaders(): Record<string, string> {
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
   * Build headers for a POST /rpc call, including the authorization signature when
   * `authSigningKey` is configured. Lazy-imports `@privy-io/node` so users who don't enable
   * auth-key signing don't need the optional peer dependency installed.
   */
  private async rpcHeaders(
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Record<string, string>> {
    const headers = { ...this.basicAuthHeaders }
    if (idempotencyKey) headers["privy-idempotency-key"] = idempotencyKey
    // The authorization signature covers only the headers named below, so adding the idempotency
    // key here does not invalidate it.
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
        url: this.rpcUrl,
        body,
        headers: { "privy-app-id": this.config.appId },
      },
    })
    headers["privy-authorization-signature"] = signature
    return headers
  }

  private async fail(operation: string, response: Response): Promise<never> {
    const body = await response.text()
    const hint =
      response.status === 401 && body.includes("Invalid app ID or app secret")
        ? PRIVY_401_ECHO_HINT
        : ""
    throw new Error(
      `Privy ${operation} failed (${response.status}): ${body}${hint}`,
    )
  }

  /** GET /v1/wallets/{id}. Caches the address, since `getAddress` and `getWalletInfo` share it. */
  async getWallet(operation: string): Promise<PrivyWalletResponse> {
    const response = await fetch(
      `${this.baseUrl}/v1/wallets/${this.config.walletId}`,
      { headers: this.basicAuthHeaders },
    )
    if (!response.ok) return this.fail(operation, response)

    const data = (await response.json()) as PrivyWalletResponse
    this.cachedAddress = data.address
    return data
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress
    return (await this.getWallet("getAddress")).address
  }

  /** POST /v1/wallets/{id}/rpc, returning the `data` envelope Privy wraps every result in. */
  /**
   * @param idempotencyKey forwarded as `privy-idempotency-key`. Privy stores the request and its
   *   response for 24 hours and returns the stored response rather than re-executing, which is what
   *   makes a retried send safe. That only works when the retry carries the *same* key, so a
   *   caller generates one per transaction and reuses it across retries; a fresh key per retry
   *   sends again. Reusing a key with a changed body is a 400.
   */
  async rpc<T>(
    operation: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: await this.rpcHeaders(body, idempotencyKey),
      body: JSON.stringify(body),
    })
    if (!response.ok) return this.fail(operation, response)

    const { data } = (await response.json()) as { data: T }
    return data
  }
}

/** The same read-only posture summary for either chain's adapter. */
export function toWalletInfo(data: PrivyWalletResponse): WalletInfo {
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
