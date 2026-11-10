import { createRequire } from "node:module"
import { Contract, Interface } from "ethers"
import { describe, expect, it, vi } from "vitest"
import {
  EthersAdapterSigner,
  walletAdapterToEthersSigner,
} from "../bridges/ethers.js"
import { walletAdapterToViemClient } from "../bridges/viem.js"
import type {
  EvmWalletAdapter,
  SvmWalletAdapter,
  WalletAdapter,
} from "../types/index.js"
import { WrongChainTypeError } from "../types/index.js"

const RECIPIENT = "0x000000000000000000000000000000000000dead"

type CjsEthers = typeof import("ethers", { with: {
  "resolution-mode": "require",
}})

function createMockAdapter(
  overrides: Partial<EvmWalletAdapter> = {},
): EvmWalletAdapter {
  return {
    name: "mock",
    // The EVM member of the union, not the union itself. Narrowing here is what lets the fixture
    // keep signTypedData.
    chainType: "evm",
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

/**
 * Shaped like the real `PrivySvmAdapter`, including the base58 address, because that is what makes
 * the failure quiet: viem builds a client around a base58 key without complaint.
 */
function createSvmAdapter(): SvmWalletAdapter {
  return {
    name: "privy-svm",
    chainType: "svm",
    capabilities: {
      signMessage: true,
      signTypedData: false,
      managedGas: true,
      managedNonce: true,
    },
    getAddress: vi
      .fn()
      .mockResolvedValue("F9ekHYH6Q1K2WjRcF7wdsbMqFeDtUjThMjcu3m8XueqZ"),
    signTransaction: vi.fn().mockResolvedValue({ signedTransaction: "AQID" }),
  }
}

describe("bridges reject a Solana wallet at runtime", () => {
  /**
   * Both bridges take the `WalletAdapter` union that `createWalletFromEnv()` returns, and a
   * JavaScript consumer reaches them with no compile step either way. On 1.0.0 neither checked,
   * and the viem bridge returned a working-looking client whose `account.address` was a base58
   * Solana key:
   * `eth_accounts` reported it as an Ethereum address and the first transaction failed with
   * "An unknown RPC error occurred", naming neither the wallet nor the reason. Found by driving the
   * published package against a real Privy SVM wallet, not by a type error.
   *
   * The casts in the constructor tests stand in for the caller who never compiled. The union tests
   * stand in for the TypeScript caller passing `createWalletFromEnv()` straight through.
   */
  it("the viem bridge throws before building a client", async () => {
    const svm = createSvmAdapter()

    await expect(
      walletAdapterToViemClient(
        svm as unknown as EvmWalletAdapter,
        { id: 1 } as never,
      ),
    ).rejects.toThrow(WrongChainTypeError)
    await expect(
      walletAdapterToViemClient(
        svm as unknown as EvmWalletAdapter,
        { id: 1 } as never,
      ),
    ).rejects.toThrow(
      'wallet "privy-svm" signs for svm; a viem client requires an EVM wallet',
    )
    // Before getAddress(), so the message is about the chain rather than the address. A guard
    // placed after it is unreachable, since viem rejects a base58 key first.
    expect(svm.getAddress).not.toHaveBeenCalled()
  })

  it("the viem bridge takes the WalletAdapter union and rejects the Solana member", async () => {
    // Typed as `createWalletFromEnv()` returns it. Compiling without a cast is half the test.
    const wallet: WalletAdapter = createSvmAdapter()
    await expect(
      walletAdapterToViemClient(wallet, { id: 1 } as never),
    ).rejects.toThrow(WrongChainTypeError)
  })

  it("the ethers bridge takes the WalletAdapter union and rejects the Solana member", () => {
    // Typed as `createWalletFromEnv()` returns it. Compiling without a cast is half the test.
    const wallet: WalletAdapter = createSvmAdapter()
    expect(() => walletAdapterToEthersSigner(wallet, null)).toThrow(
      WrongChainTypeError,
    )
  })

  it("the ethers bridge throws from the constructor", () => {
    const svm = createSvmAdapter()

    expect(() =>
      walletAdapterToEthersSigner(svm as unknown as EvmWalletAdapter, null),
    ).toThrow(WrongChainTypeError)
    // Constructing the signer directly is guarded too, not only the factory.
    expect(
      () => new EthersAdapterSigner(svm as unknown as EvmWalletAdapter, null),
    ).toThrow(
      'wallet "privy-svm" signs for svm; an ethers signer requires an EVM wallet',
    )
    expect(svm.getAddress).not.toHaveBeenCalled()
  })
})

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
  it("getAddress returns the adapter address checksummed", async () => {
    // The mock adapter returns lowercase hex, as PrivateKeyAdapter does.
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    expect(await signer.getAddress()).toBe(
      "0x1234567890AbcdEF1234567890aBcdef12345678",
    )
  })

  it("works as the runner of an ethers Contract, sending through the adapter", async () => {
    // The SDK's end-to-end spec covers OpenSeaSDK. This covers the other consumer the README's
    // "standard ethers.js Signer" promises: a plain ethers Contract write.
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    const token = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC"
    const abi = ["function approve(address spender, uint256 amount)"]
    const response = await new Contract(token, abi, signer).approve(
      RECIPIENT,
      5n,
    )
    expect(response.hash).toBe("0xtxhash123")
    expect(adapter.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        to: token,
        data: new Interface(abi).encodeFunctionData("approve", [RECIPIENT, 5n]),
        chainId: 1,
      }),
    )
  })

  it("sendTransaction routes through adapter", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
      waitForTransaction: vi.fn().mockResolvedValue({ status: 1 }),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    const result = await signer.sendTransaction({
      to: RECIPIENT,
      data: "0x1234",
      value: 0n,
    })
    expect(result.hash).toBe("0xtxhash123")
    // Not indexed yet, so the minimal response waits through the provider.
    expect(await result.wait()).toEqual({ status: 1 })
    expect(mockProvider.waitForTransaction).toHaveBeenCalledWith(
      "0xtxhash123",
      undefined,
      undefined,
    )
    expect(adapter.sendTransaction).toHaveBeenCalledWith({
      to: RECIPIENT,
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
    const signer = walletAdapterToEthersSigner(adapter, null)
    const sig = await signer.signMessage("hello")
    expect(sig).toBe("0xsig123")
    expect(adapter.signMessage).toHaveBeenCalledWith({ message: "hello" })
  })

  it("signMessage throws when adapter does not support it", async () => {
    const adapter = createMockAdapter({ signMessage: undefined })
    const signer = walletAdapterToEthersSigner(adapter, null)
    await expect(signer.signMessage("hello")).rejects.toThrow(
      "signMessage is not supported",
    )
  })

  it("signTypedData routes through adapter", async () => {
    const adapter = createMockAdapter()
    const signer = walletAdapterToEthersSigner(adapter, null)
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

  it("accepts a provider from the CommonJS build of ethers", async () => {
    // A CommonJS project's `new JsonRpcProvider()` is the lib.commonjs class, which TypeScript
    // treats as unrelated to this module's lib.esm Provider. Compiling this call is half the test.
    const { JsonRpcProvider } = createRequire(import.meta.url)(
      "ethers",
    ) as CjsEthers
    const provider = new JsonRpcProvider("http://127.0.0.1:1", 8453, {
      staticNetwork: true,
    })
    vi.spyOn(provider, "getTransaction").mockResolvedValue(null)
    const adapter = createMockAdapter()
    const signer = walletAdapterToEthersSigner(adapter, provider)
    expect(signer.connect(provider).provider).toBe(provider)
    await signer.sendTransaction({ to: RECIPIENT })
    expect(adapter.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: RECIPIENT, chainId: 8453 }),
    )
  })

  it("connect returns new signer with different provider", () => {
    const adapter = createMockAdapter()
    const signer = walletAdapterToEthersSigner(adapter, { id: 1 } as never)
    const newSigner = signer.connect({ id: 2 } as never)
    expect(newSigner).toBeInstanceOf(EthersAdapterSigner)
    expect(newSigner.provider).toEqual({ id: 2 })
  })

  it("sendTransaction returns the provider's transaction once it is indexed", async () => {
    const indexed = { hash: "0xtxhash123", nonce: 7 }
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 8453n }),
      getTransaction: vi.fn().mockResolvedValue(indexed),
    }
    const signer = walletAdapterToEthersSigner(
      createMockAdapter(),
      mockProvider as never,
    )
    const result = await signer.sendTransaction({ to: RECIPIENT })
    expect(result).toBe(indexed)
    expect(mockProvider.getTransaction).toHaveBeenCalledWith("0xtxhash123")
  })

  it("sendTransaction still returns the hash when the lookup after broadcast fails", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockRejectedValue(new Error("rpc down")),
      waitForTransaction: vi.fn().mockResolvedValue({ status: 1 }),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    const result = await signer.sendTransaction({ to: RECIPIENT })
    expect(adapter.sendTransaction).toHaveBeenCalledTimes(1)
    expect(result.hash).toBe("0xtxhash123")
    expect(await result.wait()).toEqual({ status: 1 })
  })

  it("sendTransaction sends when tx.chainId matches the provider's network", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 8453n }),
      getTransaction: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    await signer.sendTransaction({ to: RECIPIENT, chainId: 8453 })
    expect(adapter.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 8453 }),
    )
  })

  it("sendTransaction rejects a tx.chainId that is not the provider's network, before sending", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 8453n }),
      getTransaction: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    await expect(
      signer.sendTransaction({ to: RECIPIENT, chainId: 1n }),
    ).rejects.toThrow(
      "Transaction chainId 1 does not match the provider's network (chainId 8453)",
    )
    expect(adapter.sendTransaction).not.toHaveBeenCalled()
  })

  it("the fallback response forwards wait's confirmations and timeout", async () => {
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
      waitForTransaction: vi.fn().mockResolvedValue({ status: 1 }),
    }
    const signer = walletAdapterToEthersSigner(
      createMockAdapter(),
      mockProvider as never,
    )
    const result = await signer.sendTransaction({ to: RECIPIENT })
    await result.wait(2, 30_000)
    expect(mockProvider.waitForTransaction).toHaveBeenCalledWith(
      "0xtxhash123",
      2,
      30_000,
    )
  })

  it("sendTransaction sends when tx.from is this wallet, in any case", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    await signer.sendTransaction({
      to: RECIPIENT,
      from: "0x1234567890AbcdEF1234567890aBcdef12345678",
    })
    expect(adapter.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it("sendTransaction rejects a tx.from that is not this wallet, before sending", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    await expect(
      signer.sendTransaction({
        to: RECIPIENT,
        from: "0x1234567890abcdef1234567890abcdef12345679",
      }),
    ).rejects.toThrow("does not match the mock adapter's wallet")
    expect(adapter.sendTransaction).not.toHaveBeenCalled()
  })

  it("sendTransaction hex-encodes bytes calldata from a JavaScript caller", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    await signer.sendTransaction({
      to: RECIPIENT,
      data: new Uint8Array([0xab, 0xcd]) as never,
    })
    expect(adapter.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ data: "0xabcd" }),
    )
  })

  it("sendTransaction rejects a field the adapter request cannot carry, before sending", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    await expect(
      signer.sendTransaction({ to: RECIPIENT, gasPrice: 1n }),
    ).rejects.toThrow("The ethers bridge cannot forward gasPrice")
    await expect(
      signer.sendTransaction({ to: RECIPIENT, accessList: [], blobs: [] }),
    ).rejects.toThrow("cannot forward accessList, blobs")
    await expect(
      signer.sendTransaction({ to: RECIPIENT, type: 2 }),
    ).rejects.toThrow("cannot forward type")
    expect(adapter.sendTransaction).not.toHaveBeenCalled()
  })

  it("sendTransaction resolves an ENS name in to through the provider", async () => {
    const adapter = createMockAdapter()
    const target = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC"
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
      resolveName: vi.fn().mockResolvedValue(target),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    await signer.sendTransaction({ to: "opensea.eth" })
    expect(mockProvider.resolveName).toHaveBeenCalledWith("opensea.eth")
    expect(adapter.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: target }),
    )
  })

  it("sendTransaction rejects an ENS name that does not resolve, before sending", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      resolveName: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    await expect(
      signer.sendTransaction({ to: "unregistered.eth" }),
    ).rejects.toThrow("unconfigured name")
    expect(adapter.sendTransaction).not.toHaveBeenCalled()
  })

  it("sendTransaction forwards an explicit zero fee or gas rather than dropping it", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    await signer.sendTransaction({
      to: RECIPIENT,
      gasLimit: 21000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 0n,
    })
    expect(adapter.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        gas: "21000",
        maxFeePerGas: "2",
        maxPriorityFeePerGas: "0",
      }),
    )
  })

  it("sendTransaction resolves an Addressable to", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    const target = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC"
    await signer.sendTransaction({ to: { getAddress: async () => target } })
    expect(adapter.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: target }),
    )
  })

  it("sendTransaction sends an empty to when the request has none", async () => {
    const adapter = createMockAdapter()
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      getTransaction: vi.fn().mockResolvedValue(null),
    }
    const signer = walletAdapterToEthersSigner(adapter, mockProvider as never)
    await signer.sendTransaction({ data: "0x60" })
    expect(adapter.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: "", data: "0x60", chainId: 1 }),
    )
  })

  it("sendTransaction throws without a provider, before the adapter sends", async () => {
    const adapter = createMockAdapter()
    const signer = walletAdapterToEthersSigner(adapter, null)
    await expect(signer.sendTransaction({ to: RECIPIENT })).rejects.toThrow(
      "The ethers bridge needs a provider to send a transaction",
    )
    expect(adapter.sendTransaction).not.toHaveBeenCalled()
  })

  it("signTransaction throws, since adapters sign and broadcast in one step", async () => {
    const signer = walletAdapterToEthersSigner(createMockAdapter(), null)
    await expect(signer.signTransaction()).rejects.toThrow(
      "signTransaction is not supported by the ethers bridge: the mock adapter",
    )
  })

  it("signTypedData hands the adapter JSON-safe values, not bigints", async () => {
    // seaport-js passes `chainId` from provider.getNetwork(), a bigint, and Privy posts the request
    // as JSON, which throws on a bigint.
    const adapter = createMockAdapter()
    const signer = walletAdapterToEthersSigner(adapter, null)
    await signer.signTypedData(
      { name: "Seaport", chainId: 8453n },
      {
        Order: [
          { name: "amounts", type: "uint256[]" },
          { name: "counter", type: "uint256" },
        ],
      },
      { amounts: [1n, 2n ** 64n], counter: 0n },
    )
    const request = vi.mocked(adapter.signTypedData!).mock.calls[0][0]
    expect(request.domain).toEqual({ name: "Seaport", chainId: 8453 })
    expect(request.message).toEqual({
      amounts: ["1", "18446744073709551616"],
      counter: "0",
    })
    expect(() => JSON.stringify(request)).not.toThrow()
  })

  it("signTypedData passes a Uint8Array bytes value through unchanged", async () => {
    const adapter = createMockAdapter()
    const signer = walletAdapterToEthersSigner(adapter, null)
    const payload = new Uint8Array([1, 2, 3])
    await signer.signTypedData(
      { name: "Test" },
      { Message: [{ name: "payload", type: "bytes" }] },
      { payload },
    )
    const request = vi.mocked(adapter.signTypedData!).mock.calls[0][0]
    expect(request.message.payload).toBe(payload)
  })

  it("signTypedData keeps a domain bigint beyond the safe-integer range as a string", async () => {
    const adapter = createMockAdapter()
    const signer = walletAdapterToEthersSigner(adapter, null)
    await signer.signTypedData(
      { chainId: 2n ** 53n },
      { Message: [{ name: "text", type: "string" }] },
      { text: "hi" },
    )
    const request = vi.mocked(adapter.signTypedData!).mock.calls[0][0]
    expect(request.domain).toEqual({ chainId: "9007199254740992" })
  })

  it("signs the root struct when a dependency is declared before it", async () => {
    // EIP-712 defines the primary type as the struct nothing else references.
    // Person is declared first here, so the old first-key heuristic signed
    // "Person" instead of "Mail".
    const captured: { primaryType?: string } = {}
    const adapter = {
      // `name` and `chainType` are not optional on any real adapter, and the constructor's
      // chain-type guard reads them, so a stub without them is not a smaller adapter but an
      // impossible one.
      name: "mock",
      chainType: "evm" as const,
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
      name: "mock",
      chainType: "evm" as const,
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
