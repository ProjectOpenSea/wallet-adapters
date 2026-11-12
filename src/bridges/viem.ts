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
 * viem is a peer dependency, so consumers must install it separately.
 */

import type { WalletAdapter } from "../types/index.js"
import { requireEvmAdapter } from "../types/index.js"

/**
 * Takes the `WalletAdapter` union, which is what `createWalletFromEnv()` returns, and throws
 * `WrongChainTypeError` for a Solana wallet, so `walletAdapterToViemClient(createWalletFromEnv(),
 * chain)` compiles without the caller narrowing first. Matches the ethers bridge.
 */
export async function walletAdapterToViemClient(
  adapter: WalletAdapter,
  chain: import("viem").Chain,
  rpcUrl?: string,
): Promise<import("viem").WalletClient> {
  // A Solana wallet reaches here from a TypeScript caller passing the union, or from a JavaScript
  // consumer with no compile step. Without the check the client is built
  // happily around a base58 Solana key: `client.account.address` and `eth_accounts` both report it
  // as an Ethereum address, and the first transaction fails with "An unknown RPC error occurred",
  // which names neither the wallet nor the reason. Verified against a real Privy SVM wallet on
  // wallet-adapters 1.0.0.
  //
  // Before `getAddress()`, not after: viem rejects a base58 key, so a later guard is unreachable
  // and the caller sees an address error instead of a chain-type one.
  const evm = requireEvmAdapter(adapter, "a viem client")

  const { createWalletClient, createPublicClient, custom, http } = await import(
    "viem"
  )

  const address = (await evm.getAddress()) as `0x${string}`

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
          const result = await evm.sendTransaction({
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
