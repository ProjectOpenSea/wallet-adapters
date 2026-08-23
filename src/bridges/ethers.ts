/**
 * Bridge between WalletAdapter and ethers.js Signer.
 *
 * Creates an ethers.js AbstractSigner from any WalletAdapter, routing
 * transaction signing through the adapter's signing backend.
 *
 * @example
 * ```ts
 * import { createWalletFromEnv } from "@opensea/wallet-adapters"
 * import { walletAdapterToEthersSigner } from "@opensea/wallet-adapters/ethers"
 * import { JsonRpcProvider } from "ethers"
 *
 * const adapter = createWalletFromEnv()
 * const provider = new JsonRpcProvider("https://...")
 * const signer = walletAdapterToEthersSigner(adapter, provider)
 * ```
 *
 * ethers v6 is a peer dependency — consumers must install it separately.
 */

import type { WalletAdapter } from "../types/index.js"

/**
 * Create an ethers.js-compatible Signer from a WalletAdapter.
 *
 * Returns an object that implements the ethers.js Signer interface:
 * - getAddress()
 * - sendTransaction(tx)
 * - signMessage(message) — only if adapter supports it
 * - signTypedData(domain, types, value) — only if adapter supports it
 */
export function walletAdapterToEthersSigner(
  adapter: WalletAdapter,
  provider: any,
): EthersAdapterSigner {
  return new EthersAdapterSigner(adapter, provider)
}

export class EthersAdapterSigner {
  readonly adapter: WalletAdapter
  readonly provider: any

  constructor(adapter: WalletAdapter, provider: any) {
    this.adapter = adapter
    this.provider = provider
  }

  async getAddress(): Promise<string> {
    return this.adapter.getAddress()
  }

  async sendTransaction(tx: {
    to?: string
    data?: string
    value?: bigint | string
    chainId?: number | bigint
    gasLimit?: bigint | string
    maxFeePerGas?: bigint | string
    maxPriorityFeePerGas?: bigint | string
    nonce?: number
  }): Promise<{ hash: string; wait: () => Promise<any> }> {
    const network = await this.provider.getNetwork()
    const chainId = Number(tx.chainId ?? network.chainId)

    const result = await this.adapter.sendTransaction({
      to: tx.to ?? "",
      data: (tx.data as string) ?? "0x",
      value: tx.value ? String(BigInt(tx.value)) : "0",
      chainId,
      gas: tx.gasLimit ? String(BigInt(tx.gasLimit)) : undefined,
      nonce: tx.nonce,
      maxFeePerGas: tx.maxFeePerGas
        ? String(BigInt(tx.maxFeePerGas))
        : undefined,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas
        ? String(BigInt(tx.maxPriorityFeePerGas))
        : undefined,
    })

    return {
      hash: result.hash,
      wait: () => this.provider.waitForTransaction(result.hash),
    }
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    if (!this.adapter.signMessage) {
      throw new Error(
        `signMessage is not supported by the ${this.adapter.name} adapter`,
      )
    }
    return this.adapter.signMessage({ message })
  }

  async signTypedData(
    domain: Record<string, any>,
    types: Record<string, any>,
    value: Record<string, any>,
    primaryType?: string,
  ): Promise<string> {
    if (!this.adapter.signTypedData) {
      throw new Error(
        `signTypedData is not supported by the ${this.adapter.name} adapter`,
      )
    }
    // ethers.js uses "value" while our interface uses "message"
    return this.adapter.signTypedData({
      domain,
      types,
      message: value,
      primaryType: primaryType ?? inferPrimaryType(types),
    })
  }

  connect(provider: any): EthersAdapterSigner {
    return new EthersAdapterSigner(this.adapter, provider)
  }
}

/**
 * Kept in step with `inferPrimaryType` in @opensea/sdk (`src/utils/eip712.ts`),
 * which cannot import this one without taking a dependency on this package.
 * Change both together.
 *
 * Infer the EIP-712 primary type the way ethers.js does: the struct that is not
 * referenced as a field type by any other struct (the root of the type graph).
 * The previous heuristic took the first key in `types`, which signs the wrong
 * struct when the root is not declared first (e.g. dependencies listed above it).
 */
function inferPrimaryType(types: Record<string, unknown>): string {
  const named = Object.keys(types).filter(t => t !== "EIP712Domain")
  const referenced = new Set<string>()
  for (const name of named) {
    const fields = types[name]
    if (!Array.isArray(fields)) continue
    for (const field of fields) {
      // Strips trailing array suffixes, including repeated ones: Person[],
      // Person[2] and Mail[2][] all reduce to the struct name. EIP-712 field
      // types are an atomic type, an array of those, or a struct name, so
      // there is no nesting to unwrap beyond this. Solidity tuple syntax is
      // not part of the format and ethers rejects it as an unknown type.
      const base = String((field as { type?: unknown }).type).replace(
        /(\[\d*\])+$/,
        "",
      )
      if (base in types) referenced.add(base)
    }
  }
  if (named.length === 0) {
    return ""
  }
  const roots = named.filter(t => !referenced.has(t))
  // Falling back to the first declared type here would re-introduce exactly the
  // bug this function exists to fix, and silently sign the wrong struct. Both
  // shapes are invalid EIP-712 and ethers itself rejects them ("circular type
  // reference", "ambiguous primary types or unused types"), so refusing loses
  // nothing for an ethers-backed adapter and prevents a wrong signature from an
  // adapter that does not validate.
  if (roots.length === 0) {
    throw new Error(
      `Cannot infer EIP-712 primaryType: every type is referenced by another, so the type graph is circular (${named.join(", ")}). Pass primaryType explicitly.`,
    )
  }
  if (roots.length > 1) {
    throw new Error(
      `Cannot infer EIP-712 primaryType: ${roots.join(", ")} are all unreferenced, so the root is ambiguous. Pass primaryType explicitly.`,
    )
  }
  return roots[0]
}
