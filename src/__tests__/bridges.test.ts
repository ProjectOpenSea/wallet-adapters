import { describe, expect, it, vi } from "vitest"
import {
  EthersAdapterSigner,
  walletAdapterToEthersSigner,
} from "../bridges/ethers.js"
import { walletAdapterToViemClient } from "../bridges/viem.js"
import type { WalletAdapter } from "../types/index.js"

function createMockAdapter(
  overrides: Partial<WalletAdapter> = {},
): WalletAdapter {
  return {
    name: "mock",
    capabilities: {
      signMessage: true,
      signTypedData: true,
      managedGas: true,
      managedNonce: true,
    },
    getAddress: vi
      .fn()
      .mockResolvedValue("0x1234567890abcdef1234567890abcdef12345678"),
    sendTransaction: vi.fn().mockResolvedValue({ hash: "0xtxhash123" }),
    signMessage: vi.fn().mockResolvedValue("0xsig123"),
    signTypedData: vi.fn().mockResolvedValue("0xtyped123"),
    ...overrides,
  }
}

describe("walletAdapterToViemClient", () => {
  it("creates a viem client from adapter", async () => {
    const adapter = createMockAdapter()
    const chain = {
      id: 1,
      name: "Ethereum",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://rpc.example.com"] } },
    } as any
    const client = await walletAdapterToViemClient(
      adapter,
      chain,
      "https://rpc.example.com",
    )
    expect(client).toBeDefined()
    expect(client.account?.address).toBe(
      "0x1234567890abcdef1234567890abcdef12345678",
    )
  })
})

describe("EthersAdapterSigner", () => {
  it("getAddress returns adapter address", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider)
    expect(await signer.getAddress()).toBe(
      "0x1234567890abcdef1234567890abcdef12345678",
    )
  })

  it("sendTransaction routes through adapter", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      waitForTransaction: vi.fn().mockResolvedValue({ status: 1 }),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider)
    const result = await signer.sendTransaction({
      to: "0xrecipient",
      data: "0x1234",
      value: 0n,
    })
    expect(result.hash).toBe("0xtxhash123")
    expect(adapter.sendTransaction).toHaveBeenCalledWith({
      to: "0xrecipient",
      data: "0x1234",
      value: "0",
      chainId: 1,
      gas: undefined,
      nonce: undefined,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    })
  })

  it("signMessage routes through adapter", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {}
    const signer = walletAdapterToEthersSigner(adapter, mockProvider)
    const sig = await signer.signMessage("hello")
    expect(sig).toBe("0xsig123")
    expect(adapter.signMessage).toHaveBeenCalledWith({ message: "hello" })
  })

  it("signMessage throws when adapter does not support it", async () => {
    const adapter = createMockAdapter({ signMessage: undefined })
    const signer = walletAdapterToEthersSigner(adapter, {})
    await expect(signer.signMessage("hello")).rejects.toThrow(
      "signMessage is not supported",
    )
  })

  it("signTypedData routes through adapter", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {}
    const signer = walletAdapterToEthersSigner(adapter, mockProvider)
    const domain = { name: "Test" }
    const types = { Message: [{ name: "text", type: "string" }] }
    const value = { text: "hello" }
    const sig = await signer.signTypedData(domain, types, value)
    expect(sig).toBe("0xtyped123")
    expect(adapter.signTypedData).toHaveBeenCalledWith({
      domain,
      types,
      message: value,
      primaryType: "Message",
    })
  })

  it("infers the root primaryType when omitted, not the first types key", async () => {
    const adapter = createMockAdapter()
    const signer = walletAdapterToEthersSigner(adapter, {})
    // `Person` (a dependency) is declared before `Mail` (the root). The primary
    // type is the struct not referenced by any other, i.e. `Mail` - not the
    // first key.
    const types = {
      Person: [{ name: "wallet", type: "address" }],
      Mail: [
        { name: "from", type: "Person" },
        { name: "contents", type: "string" },
      ],
    }
    await signer.signTypedData({ name: "Test" }, types, {
      from: { wallet: "0x1234567890abcdef1234567890abcdef12345678" },
      contents: "hi",
    })
    expect(adapter.signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({ primaryType: "Mail" }),
    )
  })

  it("connect returns new signer with different provider", () => {
    const adapter = createMockAdapter()
    const signer = walletAdapterToEthersSigner(adapter, { id: 1 })
    const newSigner = signer.connect({ id: 2 })
    expect(newSigner).toBeInstanceOf(EthersAdapterSigner)
    expect(newSigner.provider).toEqual({ id: 2 })
  })
})
