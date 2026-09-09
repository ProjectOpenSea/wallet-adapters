/**
 * Privy wallet adapter for Solana.
 *
 * The EVM counterpart, its security model, and the Privy-side hardening this adapter assumes are
 * documented at the top of `privy.ts`. All of it applies here: **do not add `setPolicy`,
 * `rotateOwner`, `addSigner`, key export, or wallet deletion.** An agent will find and use them.
 *
 * A Privy wallet is bound to one `chain_type`, so a Solana wallet is a different wallet with a
 * different id, not the same one addressed differently. That is why this reads
 * `PRIVY_SVM_WALLET_ID` rather than sharing `PRIVY_WALLET_ID`, and why both can be configured at
 * once.
 *
 * # Where this runs, and whose wallet it signs for
 *
 * `@opensea/wallet-adapters` is a published library. It runs in the environment of whoever
 * installs it, against the Privy app and wallet named by *their* `PRIVY_APP_ID`,
 * `PRIVY_APP_SECRET` and `PRIVY_SVM_WALLET_ID`. It is not part of an OpenSea service, and no
 * OpenSea-operated process signs or submits through it. The wallet belongs to the operator who
 * configured it, so `sendTransaction` broadcasts that operator's own transaction from their own
 * infrastructure, exactly as `PrivyAdapter.sendTransaction` has for EVM since 0.1.0.
 *
 * `sendTransaction` is optional on this interface while `signTransaction` is required, the
 * reverse of the EVM side. An integrator who wants to broadcast themselves, or to simulate or
 * have a fee payer co-sign first, can use `signTransaction` alone and never call
 * `signAndSendTransaction`.
 *
 * Required environment variables:
 *   PRIVY_APP_ID           — Privy application ID
 *   PRIVY_APP_SECRET       — Privy application secret
 *   PRIVY_SVM_WALLET_ID    — id of a wallet whose chain_type is `solana`
 *
 * Optional: PRIVY_API_BASE_URL, PRIVY_AUTH_SIGNING_KEY (see `privy.ts`).
 *
 * @see https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction
 */

import type {
  SignMessageRequest,
  SvmSignedTransaction,
  SvmTransactionRequest,
  SvmWalletAdapter,
  SvmWalletCapabilities,
  TransactionResult,
  WalletInfo,
} from "../types/index.js"
import { requireIdempotencySupport } from "../types/index.js"
import type { PrivyConfig } from "./privy-transport.js"
import {
  PrivyTransport,
  privyConfigFromEnv,
  toWalletInfo,
} from "./privy-transport.js"

/**
 * CAIP-2 for Solana mainnet, used when a request does not name a cluster.
 *
 * Privy requires `caip2` on `signAndSendTransaction` and ignores it for sign-only, which is why
 * `SvmTransactionRequest.caip2` is optional. Devnet is
 * `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`.
 */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

/**
 * Normalize either request representation to the base64 string Privy accepts.
 *
 * Privy's SVM RPCs take `encoding: "base64"` and nothing else, so the `Uint8Array` form callers
 * may hold has to be converted here rather than passed through.
 */
export function toBase64Transaction(
  transaction: SvmTransactionRequest["transaction"],
): string {
  return typeof transaction === "string"
    ? transaction
    : Buffer.from(transaction).toString("base64")
}

export function buildSvmTransactionParams(tx: SvmTransactionRequest): {
  transaction: string
  encoding: "base64"
} {
  return {
    transaction: toBase64Transaction(tx.transaction),
    encoding: "base64",
  }
}

export function buildSvmSignMessageParams(request: SignMessageRequest): {
  message: string
  encoding: "base64"
} {
  // base64, not the hex-or-utf-8 pair the EVM `personal_sign` takes.
  const message =
    typeof request.message === "string"
      ? Buffer.from(request.message, "utf8").toString("base64")
      : Buffer.from(request.message).toString("base64")
  return { message, encoding: "base64" }
}

export class PrivySvmAdapter implements SvmWalletAdapter {
  readonly chainType = "svm" as const

  readonly name = "privy-svm"
  readonly capabilities: SvmWalletCapabilities = {
    signMessage: true,
    // Pinned to `false` by the type: Solana has no EIP-712 equivalent.
    signTypedData: false,
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

  static fromEnv(): PrivySvmAdapter {
    return new PrivySvmAdapter(privyConfigFromEnv("PRIVY_SVM_WALLET_ID"))
  }

  /** Base58, as Solana public keys are. Nothing downstream may checksum this. */
  async getAddress(): Promise<string> {
    return this.transport.getAddress()
  }

  async getWalletInfo(): Promise<WalletInfo> {
    return toWalletInfo(await this.transport.getWallet("getWalletInfo"))
  }

  /**
   * Sign without broadcasting.
   *
   * Required on this interface while `sendTransaction` is optional, the reverse of EVM: a fee
   * payer may co-sign, the transaction may be simulated first, or the caller may already hold a
   * connection with its own commitment and retry policy.
   */
  async signTransaction(
    tx: SvmTransactionRequest,
  ): Promise<SvmSignedTransaction> {
    requireIdempotencySupport(this, tx)
    this.onRequest?.("signTransaction", tx)
    const startTime = Date.now()

    const data = await this.transport.rpc<{
      signed_transaction: string
      encoding: string
    }>(
      "signTransaction",
      { method: "signTransaction", params: buildSvmTransactionParams(tx) },
      tx.idempotencyKey,
    )

    // Already base64, since that is the only encoding Privy returns here.
    const result = { signedTransaction: data.signed_transaction }
    this.onResponse?.("signTransaction", result, Date.now() - startTime)
    return result
  }

  /** Sign and broadcast, returning the transaction signature as `hash`. */
  async sendTransaction(tx: SvmTransactionRequest): Promise<TransactionResult> {
    // Supported here, so this only rejects a blank key: forwarding one is a silent no-op.
    requireIdempotencySupport(this, tx)
    this.onRequest?.("sendTransaction", tx)
    const startTime = Date.now()

    const data = await this.transport.rpc<{ hash: string; caip2: string }>(
      "sendTransaction",
      {
        method: "signAndSendTransaction",
        // Required by this RPC, unlike sign-only.
        caip2: tx.caip2 ?? SOLANA_MAINNET_CAIP2,
        params: buildSvmTransactionParams(tx),
      },
      tx.idempotencyKey,
    )

    const result = { hash: data.hash }
    this.onResponse?.("sendTransaction", result, Date.now() - startTime)
    return result
  }

  /** Returns a base64 signature, which is what Privy gives for Solana. */
  async signMessage(request: SignMessageRequest): Promise<string> {
    this.onRequest?.("signMessage", request)
    const startTime = Date.now()

    const data = await this.transport.rpc<{
      signature: string
      encoding: string
    }>("signMessage", {
      method: "signMessage",
      params: buildSvmSignMessageParams(request),
    })

    this.onResponse?.("signMessage", data.signature, Date.now() - startTime)
    return data.signature
  }
}
