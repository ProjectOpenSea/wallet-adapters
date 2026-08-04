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
 * Infer the EIP-712 primary type the way ethers.js does: the struct that is not
 * referenced as a field type by any other struct (the root of the type graph).
 * The previous heuristic took the first key in `types`, which signs the wrong
 * struct when the root is not declared first (e.g. dependencies listed above it).
 */
function inferPrimaryType(types: Record<string, any>): string {
  const named = Object.keys(types).filter(t => t !== "EIP712Domain")
  const referenced = new Set<string>()
  for (const name of named) {
    for (const field of types[name] ?? []) {
      const base = String(field.type).replace(/(\[\d*\])+$/, "")
      if (base in types) referenced.add(base)
    }
  }
  const roots = named.filter(t => !referenced.has(t))
  return roots[0] ?? named[0] ?? ""
}
