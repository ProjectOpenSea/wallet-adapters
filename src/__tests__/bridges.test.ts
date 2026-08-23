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

  it("connect returns new signer with different provider", () => {
    const adapter = createMockAdapter()
    const signer = walletAdapterToEthersSigner(adapter, { id: 1 })
    const newSigner = signer.connect({ id: 2 })
    expect(newSigner).toBeInstanceOf(EthersAdapterSigner)
    expect(newSigner.provider).toEqual({ id: 2 })
  })

  it("signs the root struct when a dependency is declared before it", async () => {
    // EIP-712 defines the primary type as the struct nothing else references.
    // Person is declared first here, so the old first-key heuristic signed
    // "Person" instead of "Mail".
    const captured: { primaryType?: string } = {}
    const adapter = {
      getAddress: async () => "0x1111111111111111111111111111111111111111",
      signTypedData: async (args: { primaryType?: string }) => {
        captured.primaryType = args.primaryType
        return "0xsig"
      },
    }

    const signer = new EthersAdapterSigner(adapter as never, undefined)
    await signer.signTypedData(
      { name: "Test", version: "1", chainId: 1 },
      {
        Person: [
          { name: "name", type: "string" },
          { name: "wallet", type: "address" },
        ],
        Mail: [
          { name: "from", type: "Person" },
          { name: "to", type: "Person" },
          { name: "contents", type: "string" },
        ],
      },
      {
        from: {
          name: "A",
          wallet: "0x1111111111111111111111111111111111111111",
        },
        to: { name: "B", wallet: "0x2222222222222222222222222222222222222222" },
        contents: "hi",
      },
    )

    expect(captured.primaryType).toBe("Mail")
  })

  function signerCapturing(captured: { primaryType?: string }) {
    const adapter = {
      getAddress: async () => "0x1111111111111111111111111111111111111111",
      signTypedData: async (args: { primaryType?: string }) => {
        captured.primaryType = args.primaryType
        return "0xsig"
      },
    }
    return new EthersAdapterSigner(adapter as never, undefined)
  }

  it("respects an explicitly passed primaryType over inference", async () => {
    const captured: { primaryType?: string } = {}
    await signerCapturing(captured).signTypedData(
      { name: "Test", version: "1", chainId: 1 },
      {
        Person: [{ name: "name", type: "string" }],
        Mail: [{ name: "from", type: "Person" }],
      },
      { from: { name: "A" } },
      "Person",
    )
    expect(captured.primaryType).toBe("Person")
  })

  it("returns an empty primaryType when only EIP712Domain is declared", async () => {
    const captured: { primaryType?: string } = {}
    await signerCapturing(captured).signTypedData(
      { name: "Test", version: "1", chainId: 1 },
      { EIP712Domain: [{ name: "name", type: "string" }] },
      {},
    )
    expect(captured.primaryType).toBe("")
  })

  it("refuses to guess when two unreferenced structs both qualify as root", async () => {
    // ethers rejects this input too ("ambiguous primary types or unused
    // types"), so guessing here would only mislead an adapter that does not
    // validate.
    const captured: { primaryType?: string } = {}
    await expect(
      signerCapturing(captured).signTypedData(
        { name: "Test", version: "1", chainId: 1 },
        {
          Alpha: [{ name: "n", type: "string" }],
          Beta: [{ name: "n", type: "string" }],
        },
        { n: "x" },
      ),
    ).rejects.toThrow(/ambiguous/)
    expect(captured.primaryType).toBeUndefined()
  })

  it("refuses to guess when the type graph is circular", async () => {
    const captured: { primaryType?: string } = {}
    await expect(
      signerCapturing(captured).signTypedData(
        { name: "Test", version: "1", chainId: 1 },
        { Person: [{ name: "friend", type: "Person" }] },
        {},
      ),
    ).rejects.toThrow(/circular/)
    expect(captured.primaryType).toBeUndefined()
  })
})
