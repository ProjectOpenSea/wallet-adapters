/**
 * Bridge between WalletAdapter and viem's WalletClient.
 *
 * Creates a viem WalletClient from any WalletAdapter, routing
 * eth_sendTransaction through the adapter's signing backend.
 *
 * @example
 * ```ts
 * import { createWalletFromEnv } from "@opensea/wallet-adapters"
 * import { walletAdapterToViemClient } from "@opensea/wallet-adapters/viem"
 * import { base } from "viem/chains"
 *
 * const adapter = createWalletFromEnv()
 * const client = await walletAdapterToViemClient(adapter, base)
 * ```
 *
 * viem is a peer dependency — consumers must install it separately.
 */

import type { WalletAdapter } from "../types/index.js"

export async function walletAdapterToViemClient(
  adapter: WalletAdapter,
  chain: import("viem").Chain,
  rpcUrl?: string,
): Promise<import("viem").WalletClient> {
  const { createWalletClient, createPublicClient, custom, http } = await import(
    "viem"
  )

  const address = (await adapter.getAddress()) as `0x${string}`

  // Use json-rpc type so viem routes sendTransaction through the transport
  const account = { address, type: "json-rpc", source: "custom" } as any

  const fallbackClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const fallbackRequest = (fallbackClient as any).transport.request

  return createWalletClient({
    account,
    chain,
    transport: custom({
      async request({ method, params }: { method: string; params: any }) {
        if (method === "eth_sendTransaction") {
          const [txParams] = params as [
            {
              to: string
              data: string
              value: string
              gas?: string
              nonce?: string
              maxFeePerGas?: string
              maxPriorityFeePerGas?: string
            },
          ]
          const result = await adapter.sendTransaction({
            to: txParams.to,
            data: txParams.data ?? "0x",
            value: txParams.value ? String(BigInt(txParams.value)) : "0",
            chainId: chain.id,
            gas: txParams.gas,
            nonce: txParams.nonce
              ? Number.parseInt(txParams.nonce, 16)
              : undefined,
            maxFeePerGas: txParams.maxFeePerGas,
            maxPriorityFeePerGas: txParams.maxPriorityFeePerGas,
          })
          return result.hash
        }
        if (method === "eth_accounts") {
          return [address]
        }
        if (method === "eth_chainId") {
          return `0x${chain.id.toString(16)}`
        }
        return fallbackRequest({ method, params })
      },
    }),
  }) as any
}
