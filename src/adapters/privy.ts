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
  EvmTransactionRequest,
  EvmWalletAdapter,
  SignMessageRequest,
  SignTypedDataRequest,
  TransactionResult,
  WalletCapabilities,
  WalletInfo,
} from "../types/index.js"
import { requireIdempotencySupport } from "../types/index.js"
import type { PrivyConfig } from "./privy-transport.js"
import {
  PrivyTransport,
  privyConfigFromEnv,
  toWalletInfo,
} from "./privy-transport.js"

export type { PrivyConfig } from "./privy-transport.js"

/**
 * Builders for the `params` object of each Privy RPC body.
 *
 * Split out of the call sites so `privy-rpc-shapes.test.ts` can check them against the types
 * `@privy-io/node` publishes, rather than against a copy of what this file happens to send. That
 * copy is how `eth_signTypedData_v4` shipped wrong: it sent a `typedData` JSON string with
 * `primaryType`, where Privy takes a `typed_data` object with `primary_type`, and the test parsed
 * back the same wrong shape it had just written.
 */
export function buildPersonalSignParams(request: SignMessageRequest): {
  message: string
  encoding: "utf-8" | "hex"
} {
  const isBytes = typeof request.message !== "string"
  return {
    message: isBytes
      ? `0x${Buffer.from(request.message as Uint8Array).toString("hex")}`
      : (request.message as string),
    encoding: isBytes ? "hex" : "utf-8",
  }
}

export function buildSignTypedDataParams(request: SignTypedDataRequest): {
  typed_data: {
    domain: Record<string, unknown>
    types: Record<string, Array<{ name: string; type: string }>>
    primary_type: string
    message: Record<string, unknown>
  }
} {
  return {
    typed_data: {
      domain: request.domain,
      types: request.types,
      // snake_case, and a real object. Privy rejects `primaryType` and a JSON string.
      primary_type: request.primaryType,
      message: request.message,
    },
  }
}

export class PrivyAdapter implements EvmWalletAdapter {
  readonly chainType = "evm" as const

  readonly name = "privy"
  readonly capabilities: WalletCapabilities = {
    signMessage: true,
    signTypedData: true,
    managedGas: true,
    managedNonce: true,
    idempotentSend: true,
  }
  onRequest?: (method: string, params: unknown) => void
  onResponse?: (method: string, result: unknown, durationMs: number) => void
  private transport: PrivyTransport

  constructor(config: PrivyConfig) {
    this.transport = new PrivyTransport(config)
  }

  static fromEnv(): PrivyAdapter {
    return new PrivyAdapter(privyConfigFromEnv("PRIVY_WALLET_ID"))
  }

  async getAddress(): Promise<string> {
    return this.transport.getAddress()
  }

  async getWalletInfo(): Promise<WalletInfo> {
    return toWalletInfo(await this.transport.getWallet("getWalletInfo"))
  }

  async sendTransaction(tx: EvmTransactionRequest): Promise<TransactionResult> {
    // Supported here, so this only rejects a blank key: forwarding one is a silent no-op.
    requireIdempotencySupport(this, tx)
    this.onRequest?.("sendTransaction", tx)
    const startTime = Date.now()

    const data = await this.transport.rpc<{ hash: string }>(
      "sendTransaction",
      {
        method: "eth_sendTransaction",
        caip2: `eip155:${tx.chainId}`,
        params: {
          transaction: {
            to: tx.to,
            data: tx.data,
            value: tx.value,
          },
        },
      },
      tx.idempotencyKey,
    )
    const result = { hash: data.hash }
    this.onResponse?.("sendTransaction", result, Date.now() - startTime)
    return result
  }

  async signMessage(request: SignMessageRequest): Promise<string> {
    this.onRequest?.("signMessage", request)
    const startTime = Date.now()

    const data = await this.transport.rpc<{ signature: string }>(
      "signMessage",
      {
        method: "personal_sign",
        params: buildPersonalSignParams(request),
      },
    )

    this.onResponse?.("signMessage", data.signature, Date.now() - startTime)
    return data.signature
  }

  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    this.onRequest?.("signTypedData", request)
    const startTime = Date.now()

    const data = await this.transport.rpc<{ signature: string }>(
      "signTypedData",
      {
        method: "eth_signTypedData_v4",
        params: buildSignTypedDataParams(request),
      },
    )

    this.onResponse?.("signTypedData", data.signature, Date.now() - startTime)
    return data.signature
  }
}
