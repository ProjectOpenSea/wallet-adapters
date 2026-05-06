import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest"
import { BankrAdapter } from "../adapters/bankr.js"
import { FireblocksAdapter } from "../adapters/fireblocks.js"
import { PrivateKeyAdapter } from "../adapters/private-key.js"
import { PrivyAdapter } from "../adapters/privy.js"
import { TurnkeyAdapter } from "../adapters/turnkey.js"

type FetchMock = MockInstance<typeof global.fetch>

describe("PrivyAdapter", () => {
  it("constructs with valid config", () => {
    const adapter = new PrivyAdapter({
      appId: "test-app-id",
      appSecret: "test-app-secret",
      walletId: "test-wallet-id",
    })
    expect(adapter.name).toBe("privy")
    expect(adapter.capabilities.managedGas).toBe(true)
    expect(adapter.capabilities.managedNonce).toBe(true)
    expect(adapter.capabilities.signMessage).toBe(true)
    expect(adapter.capabilities.signTypedData).toBe(true)
  })

  it("fromEnv throws when PRIVY_APP_ID is missing", () => {
    expect(() => PrivyAdapter.fromEnv()).toThrow(
      "PRIVY_APP_ID environment variable is required",
    )
  })

  it("fromEnv creates adapter when env vars are set", () => {
    process.env.PRIVY_APP_ID = "test-app-id"
    process.env.PRIVY_APP_SECRET = "test-app-secret"
    process.env.PRIVY_WALLET_ID = "test-wallet-id"
    const adapter = PrivyAdapter.fromEnv()
    expect(adapter.name).toBe("privy")
    delete process.env.PRIVY_APP_ID
    delete process.env.PRIVY_APP_SECRET
    delete process.env.PRIVY_WALLET_ID
  })
})

describe("FireblocksAdapter", () => {
  it("constructs with valid config", () => {
    const adapter = new FireblocksAdapter({
      apiKey: "test-api-key",
      apiSecret:
        "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
      vaultId: "0",
    })
    expect(adapter.name).toBe("fireblocks")
    expect(adapter.capabilities.managedGas).toBe(true)
    expect(adapter.capabilities.managedNonce).toBe(true)
  })

  it("fromEnv throws when FIREBLOCKS_API_KEY is missing", () => {
    expect(() => FireblocksAdapter.fromEnv()).toThrow(
      "FIREBLOCKS_API_KEY environment variable is required",
    )
  })
})

describe("TurnkeyAdapter", () => {
  it("constructs with valid config", () => {
    const adapter = new TurnkeyAdapter({
      apiPublicKey: "test-public-key",
      apiPrivateKey: "test-private-key",
      organizationId: "test-org-id",
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://rpc.example.com",
    })
    expect(adapter.name).toBe("turnkey")
    expect(adapter.capabilities.managedGas).toBe(false)
    expect(adapter.capabilities.managedNonce).toBe(false)
  })

  it("getAddress returns configured address", async () => {
    const address = "0x1234567890abcdef1234567890abcdef12345678"
    const adapter = new TurnkeyAdapter({
      apiPublicKey: "test-public-key",
      apiPrivateKey: "test-private-key",
      organizationId: "test-org-id",
      walletAddress: address,
      rpcUrl: "https://rpc.example.com",
    })
    expect(await adapter.getAddress()).toBe(address)
  })

  it("fromEnv throws when TURNKEY_API_PUBLIC_KEY is missing", () => {
    expect(() => TurnkeyAdapter.fromEnv()).toThrow(
      "TURNKEY_API_PUBLIC_KEY environment variable is required",
    )
  })
})

describe("PrivateKeyAdapter", () => {
  // Well-known test private key (DO NOT use in production)
  const TEST_PRIVATE_KEY =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  const EXPECTED_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"

  it("constructs with valid config", () => {
    const adapter = new PrivateKeyAdapter({
      privateKey: TEST_PRIVATE_KEY,
      rpcUrl: "https://rpc.example.com",
    })
    expect(adapter.name).toBe("private-key")
    expect(adapter.capabilities.signMessage).toBe(true)
    expect(adapter.capabilities.signTypedData).toBe(true)
    expect(adapter.capabilities.managedGas).toBe(false)
    expect(adapter.capabilities.managedNonce).toBe(false)
  })

  it("derives correct address from private key", async () => {
    const adapter = new PrivateKeyAdapter({
      privateKey: TEST_PRIVATE_KEY,
      rpcUrl: "https://rpc.example.com",
    })
    const address = await adapter.getAddress()
    expect(address.toLowerCase()).toBe(EXPECTED_ADDRESS)
  })

  it("uses pre-computed address when provided", async () => {
    const adapter = new PrivateKeyAdapter({
      privateKey: TEST_PRIVATE_KEY,
      rpcUrl: "https://rpc.example.com",
      address: "0xcustom",
    })
    expect(await adapter.getAddress()).toBe("0xcustom")
  })

  it("getRpcUrl returns configured URL", () => {
    const adapter = new PrivateKeyAdapter({
      privateKey: TEST_PRIVATE_KEY,
      rpcUrl: "https://rpc.example.com",
    })
    expect(adapter.getRpcUrl()).toBe("https://rpc.example.com")
  })

  it("fromEnv throws when PRIVATE_KEY is missing", () => {
    expect(() => PrivateKeyAdapter.fromEnv()).toThrow(
      "PRIVATE_KEY environment variable is required",
    )
  })

  it("fromEnv throws when RPC_URL is missing", () => {
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY
    expect(() => PrivateKeyAdapter.fromEnv()).toThrow(
      "RPC_URL environment variable is required",
    )
    delete process.env.PRIVATE_KEY
  })

  it("signMessage produces a valid 65-byte signature", async () => {
    const adapter = new PrivateKeyAdapter({
      privateKey: TEST_PRIVATE_KEY,
      rpcUrl: "https://rpc.example.com",
    })
    const sig = await adapter.signMessage({ message: "hello" })
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
  })

  it("signTypedData produces a valid 65-byte signature", async () => {
    const adapter = new PrivateKeyAdapter({
      privateKey: TEST_PRIVATE_KEY,
      rpcUrl: "https://rpc.example.com",
    })
    const sig = await adapter.signTypedData({
      domain: { name: "Test", version: "1", chainId: 1 },
      types: { Message: [{ name: "content", type: "string" }] },
      primaryType: "Message",
      message: { content: "hello" },
    })
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
  })

  it("fromEnv rejects invalid private key format", () => {
    process.env.PRIVATE_KEY = "not-a-valid-hex"
    process.env.RPC_URL = "https://rpc.example.com"
    expect(() => PrivateKeyAdapter.fromEnv()).toThrow(
      "PRIVATE_KEY must be a 64-character hex string",
    )
    delete process.env.PRIVATE_KEY
    delete process.env.RPC_URL
  })
})

describe("PrivyAdapter signMessage/signTypedData", () => {
  let fetchSpy: FetchMock

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("signMessage calls personal_sign via RPC endpoint", async () => {
    const adapter = new PrivyAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      walletId: "wallet-123",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { signature: `0x${"ab".repeat(65)}` } }),
        {
          status: 200,
        },
      ),
    )

    const sig = await adapter.signMessage({ message: "hello" })
    expect(sig).toBe(`0x${"ab".repeat(65)}`)

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.privy.io/v1/wallets/wallet-123/rpc",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"method":"personal_sign"'),
      }),
    )

    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(reqInit.body as string)
    expect(body.method).toBe("personal_sign")
    expect(body.params.message).toBe("hello")
    // Privy's RPC schema requires params.encoding ("utf-8" or "hex").
    // Omitting it produces a misleading 400 that looks like a schema bug
    // but is actually our missing field.
    expect(body.params.encoding).toBe("utf-8")
  })

  it("signMessage with Uint8Array passes encoding: 'hex'", async () => {
    const adapter = new PrivyAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      walletId: "wallet-123",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { signature: `0x${"ef".repeat(65)}` } }),
        { status: 200 },
      ),
    )

    await adapter.signMessage({ message: new Uint8Array([1, 2, 3]) })
    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(reqInit.body as string)
    expect(body.params.message).toBe("0x010203")
    expect(body.params.encoding).toBe("hex")
  })

  it("signTypedData calls eth_signTypedData_v4 via RPC endpoint", async () => {
    const adapter = new PrivyAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      walletId: "wallet-123",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { signature: `0x${"cd".repeat(65)}` } }),
        {
          status: 200,
        },
      ),
    )

    const sig = await adapter.signTypedData({
      domain: { name: "Test", version: "1", chainId: 1 },
      types: { Message: [{ name: "content", type: "string" }] },
      primaryType: "Message",
      message: { content: "hello" },
    })
    expect(sig).toBe(`0x${"cd".repeat(65)}`)

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.privy.io/v1/wallets/wallet-123/rpc",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"method":"eth_signTypedData_v4"'),
      }),
    )

    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(reqInit.body as string)
    expect(body.method).toBe("eth_signTypedData_v4")
    const typedData = JSON.parse(body.params.typedData)
    expect(typedData.primaryType).toBe("Message")
    expect(typedData.domain.name).toBe("Test")
  })
})

describe("TurnkeyAdapter signMessage/signTypedData", () => {
  let fetchSpy: FetchMock

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("signMessage calls SIGN_RAW_PAYLOAD with HASH_FUNCTION_NO_OP", async () => {
    const adapter = new TurnkeyAdapter({
      apiPublicKey: `04${"aa".repeat(64)}`,
      apiPrivateKey: "bb".repeat(32),
      organizationId: "org-123",
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://rpc.example.com",
    })

    const rHex = "a".repeat(64)
    const sHex = "b".repeat(64)
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          activity: {
            result: {
              signRawPayloadResult: { r: rHex, s: sHex, v: "00" },
            },
          },
        }),
        { status: 200 },
      ),
    )

    const sig = await adapter.signMessage({ message: "hello" })
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)

    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(reqInit.body as string)
    expect(body.type).toBe("ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2")
    expect(body.parameters.encoding).toBe("PAYLOAD_ENCODING_HEXADECIMAL")
    expect(body.parameters.hashFunction).toBe("HASH_FUNCTION_NO_OP")
    expect(body.parameters.signWith).toBe(
      "0x1234567890abcdef1234567890abcdef12345678",
    )
  })

  it("signTypedData calls SIGN_RAW_PAYLOAD with EIP-712 hash", async () => {
    const adapter = new TurnkeyAdapter({
      apiPublicKey: `04${"aa".repeat(64)}`,
      apiPrivateKey: "bb".repeat(32),
      organizationId: "org-123",
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://rpc.example.com",
    })

    const rHex = "c".repeat(64)
    const sHex = "d".repeat(64)
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          activity: {
            result: {
              signRawPayloadResult: { r: rHex, s: sHex, v: "01" },
            },
          },
        }),
        { status: 200 },
      ),
    )

    const sig = await adapter.signTypedData({
      domain: { name: "Test", version: "1", chainId: 1 },
      types: { Message: [{ name: "content", type: "string" }] },
      primaryType: "Message",
      message: { content: "hello" },
    })
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)

    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(reqInit.body as string)
    expect(body.type).toBe("ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2")
    expect(body.parameters.hashFunction).toBe("HASH_FUNCTION_NO_OP")
  })
})

describe("FireblocksAdapter signMessage/signTypedData", () => {
  let fetchSpy: FetchMock
  let importKeySpy: MockInstance
  let signSpy: MockInstance

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
    // Mock crypto.subtle for JWT creation (avoids needing a real RSA key)
    importKeySpy = vi
      .spyOn(crypto.subtle, "importKey")
      .mockResolvedValue({} as CryptoKey)
    signSpy = vi
      .spyOn(crypto.subtle, "sign")
      .mockResolvedValue(new ArrayBuffer(256))
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    importKeySpy.mockRestore()
    signSpy.mockRestore()
  })

  it("signMessage creates RAW transaction and polls for signature", async () => {
    const adapter = new FireblocksAdapter({
      apiKey: "test-api-key",
      apiSecret:
        "-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA0\n-----END PRIVATE KEY-----",
      vaultId: "0",
    })

    // First call: create RAW transaction
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "tx-123" }), { status: 200 }),
    )
    // Second call: poll — returns completed with signature
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "COMPLETED",
          signedMessages: [
            { signature: { r: "a".repeat(64), s: "b".repeat(64), v: 0 } },
          ],
        }),
        { status: 200 },
      ),
    )

    const sig = await adapter.signMessage({ message: "hello" })
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    // v=0 + 27 = 27 = 0x1b
    expect(sig.endsWith("1b")).toBe(true)

    // Verify first call was to create RAW transaction
    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const createBody = JSON.parse(reqInit.body as string)
    expect(createBody.operation).toBe("RAW")
    expect(createBody.source.type).toBe("VAULT_ACCOUNT")
    expect(createBody.extraParameters.rawMessageData.messages).toHaveLength(1)
  })

  it("signTypedData creates RAW transaction with EIP-712 hash", async () => {
    const adapter = new FireblocksAdapter({
      apiKey: "test-api-key",
      apiSecret:
        "-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA0\n-----END PRIVATE KEY-----",
      vaultId: "0",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "tx-456" }), { status: 200 }),
    )
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "COMPLETED",
          signedMessages: [
            { signature: { r: "c".repeat(64), s: "d".repeat(64), v: 1 } },
          ],
        }),
        { status: 200 },
      ),
    )

    const sig = await adapter.signTypedData({
      domain: { name: "Test", version: "1", chainId: 1 },
      types: { Message: [{ name: "content", type: "string" }] },
      primaryType: "Message",
      message: { content: "hello" },
    })
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    // v=1 + 27 = 28 = 0x1c
    expect(sig.endsWith("1c")).toBe(true)

    const reqInit2 = fetchSpy.mock.calls[0][1] as RequestInit
    const createBody = JSON.parse(reqInit2.body as string)
    expect(createBody.operation).toBe("RAW")
    expect(
      createBody.extraParameters.rawMessageData.messages[0].content,
    ).toBeTruthy()
  })
})

describe("BankrAdapter", () => {
  it("constructs with valid config", () => {
    const adapter = new BankrAdapter({ apiKey: "test-api-key" })
    expect(adapter.name).toBe("bankr")
    expect(adapter.capabilities.signMessage).toBe(true)
    expect(adapter.capabilities.signTypedData).toBe(true)
    expect(adapter.capabilities.managedGas).toBe(true)
    expect(adapter.capabilities.managedNonce).toBe(true)
  })

  it("fromEnv throws when BANKR_API_KEY is missing", () => {
    expect(() => BankrAdapter.fromEnv()).toThrow(
      "BANKR_API_KEY environment variable is required",
    )
  })

  it("fromEnv creates adapter when env vars are set", () => {
    process.env.BANKR_API_KEY = "test-api-key"
    const adapter = BankrAdapter.fromEnv()
    expect(adapter.name).toBe("bankr")
    delete process.env.BANKR_API_KEY
  })
})

describe("BankrAdapter getAddress", () => {
  let fetchSpy: FetchMock

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("fetches EVM address from /wallet/me", async () => {
    const adapter = new BankrAdapter({ apiKey: "test-key" })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          wallets: [
            {
              chain: "evm",
              address: "0x1234567890abcdef1234567890abcdef12345678",
            },
            { chain: "solana", address: "5DcK...NdR" },
          ],
        }),
        { status: 200 },
      ),
    )

    const address = await adapter.getAddress()
    expect(address).toBe("0x1234567890abcdef1234567890abcdef12345678")

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.bankr.bot/wallet/me",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-Key": "test-key" }),
      }),
    )
  })

  it("caches address after first fetch", async () => {
    const adapter = new BankrAdapter({ apiKey: "test-key" })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          wallets: [{ chain: "evm", address: "0xaabbccdd" }],
        }),
        { status: 200 },
      ),
    )

    await adapter.getAddress()
    const address = await adapter.getAddress()
    expect(address).toBe("0xaabbccdd")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("throws when no EVM wallet is found", async () => {
    const adapter = new BankrAdapter({ apiKey: "test-key" })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          wallets: [{ chain: "solana", address: "5DcK...NdR" }],
        }),
        { status: 200 },
      ),
    )

    await expect(adapter.getAddress()).rejects.toThrow(
      "Bankr wallet has no EVM address",
    )
  })

  it("throws on API error", async () => {
    const adapter = new BankrAdapter({ apiKey: "bad-key" })

    fetchSpy.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    )

    await expect(adapter.getAddress()).rejects.toThrow(
      "Bankr getAddress failed (401)",
    )
  })
})

describe("BankrAdapter sendTransaction", () => {
  let fetchSpy: FetchMock

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("submits transaction via /wallet/submit", async () => {
    const adapter = new BankrAdapter({ apiKey: "test-key" })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          transactionHash: "0xdeadbeef",
          status: "success",
        }),
        { status: 200 },
      ),
    )

    const result = await adapter.sendTransaction({
      to: "0x1111111111111111111111111111111111111111",
      data: "0x",
      value: "1000000000000000000",
      chainId: 8453,
    })
    expect(result.hash).toBe("0xdeadbeef")

    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(reqInit.body as string)
    expect(body.transaction.to).toBe(
      "0x1111111111111111111111111111111111111111",
    )
    expect(body.transaction.chainId).toBe(8453)
    expect(body.transaction.data).toBe("0x")
    expect(body.transaction.value).toBe("1000000000000000000")
    expect(body.waitForConfirmation).toBe(true)
  })

  it("includes data and value even when zero", async () => {
    const adapter = new BankrAdapter({ apiKey: "test-key" })

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ transactionHash: "0xabc" }), {
        status: 200,
      }),
    )

    await adapter.sendTransaction({
      to: "0x1111111111111111111111111111111111111111",
      data: "0x",
      value: "0",
      chainId: 1,
    })

    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(reqInit.body as string)
    expect(body.transaction.data).toBe("0x")
    expect(body.transaction.value).toBe("0")
  })

  it("throws on API error", async () => {
    const adapter = new BankrAdapter({ apiKey: "test-key" })

    fetchSpy.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }))

    await expect(
      adapter.sendTransaction({
        to: "0x1111111111111111111111111111111111111111",
        data: "0x",
        value: "0",
        chainId: 1,
      }),
    ).rejects.toThrow("Bankr sendTransaction failed (403)")
  })
})

describe("BankrAdapter signMessage/signTypedData", () => {
  let fetchSpy: FetchMock

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("signMessage calls personal_sign via /wallet/sign", async () => {
    const adapter = new BankrAdapter({ apiKey: "test-key" })

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ signature: `0x${"ab".repeat(65)}` }), {
        status: 200,
      }),
    )

    const sig = await adapter.signMessage({ message: "hello" })
    expect(sig).toBe(`0x${"ab".repeat(65)}`)

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.bankr.bot/wallet/sign",
      expect.objectContaining({
        method: "POST",
      }),
    )

    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(reqInit.body as string)
    expect(body.signatureType).toBe("personal_sign")
    expect(body.message).toBe("hello")
  })

  it("signTypedData calls eth_signTypedData_v4 via /wallet/sign", async () => {
    const adapter = new BankrAdapter({ apiKey: "test-key" })

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ signature: `0x${"cd".repeat(65)}` }), {
        status: 200,
      }),
    )

    const sig = await adapter.signTypedData({
      domain: { name: "Test", version: "1", chainId: 1 },
      types: { Message: [{ name: "content", type: "string" }] },
      primaryType: "Message",
      message: { content: "hello" },
    })
    expect(sig).toBe(`0x${"cd".repeat(65)}`)

    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(reqInit.body as string)
    expect(body.signatureType).toBe("eth_signTypedData_v4")
    expect(body.typedData.primaryType).toBe("Message")
    expect(body.typedData.domain.name).toBe("Test")
  })

  it("signMessage throws on API error", async () => {
    const adapter = new BankrAdapter({ apiKey: "test-key" })

    fetchSpy.mockResolvedValueOnce(
      new Response("Rate limited", { status: 429 }),
    )

    await expect(adapter.signMessage({ message: "hello" })).rejects.toThrow(
      "Bankr signMessage failed (429)",
    )
  })

  it("signTypedData throws on API error", async () => {
    const adapter = new BankrAdapter({ apiKey: "test-key" })

    fetchSpy.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }))

    await expect(
      adapter.signTypedData({
        domain: { name: "Test" },
        types: { Message: [{ name: "content", type: "string" }] },
        primaryType: "Message",
        message: { content: "hello" },
      }),
    ).rejects.toThrow("Bankr signTypedData failed (403)")
  })
})

describe("PrivyAdapter getWalletInfo and 401 hardening hint", () => {
  let fetchSpy: FetchMock

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("getWalletInfo flags ownerEnforcesAuthKey: false on unhardened wallet", async () => {
    const adapter = new PrivyAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      walletId: "wallet-123",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "wallet-123",
          address: "0xabc",
          chain_type: "ethereum",
          policy_ids: [],
          additional_signers: [],
          owner_id: null,
        }),
        { status: 200 },
      ),
    )

    const info = await adapter.getWalletInfo()
    expect(info).toEqual({
      provider: "privy",
      address: "0xabc",
      chainType: "ethereum",
      policyIds: [],
      ownerKeyId: null,
      additionalSignerCount: 0,
      ownerEnforcesAuthKey: false,
    })
  })

  it("getWalletInfo flags ownerEnforcesAuthKey: true when owner_id is set", async () => {
    const adapter = new PrivyAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      walletId: "wallet-123",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "wallet-123",
          address: "0xabc",
          chain_type: "ethereum",
          policy_ids: ["policy-1"],
          additional_signers: [{ signer_id: "signer-1" }],
          owner_id: "kq-123",
        }),
        { status: 200 },
      ),
    )

    const info = await adapter.getWalletInfo()
    expect(info).toMatchObject({
      provider: "privy",
      ownerKeyId: "kq-123",
      additionalSignerCount: 1,
      ownerEnforcesAuthKey: true,
      policyIds: ["policy-1"],
    })
  })

  it("getAddress 401 with 'Invalid app ID or app secret' includes printf hint", async () => {
    const adapter = new PrivyAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      walletId: "wallet-123",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response("Invalid app ID or app secret", { status: 401 }),
    )

    await expect(adapter.getAddress()).rejects.toThrow(/printf %s/)
  })

  it("getAddress 401 without the trigger body does not include the hint", async () => {
    const adapter = new PrivyAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      walletId: "wallet-123",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response("some other 401 reason", { status: 401 }),
    )

    let caught: Error | undefined
    try {
      await adapter.getAddress()
    } catch (e) {
      caught = e as Error
    }
    expect(caught?.message).toContain("Privy getAddress failed (401)")
    expect(caught?.message).not.toContain("printf %s")
  })

  it("does not attach privy-authorization-signature when authSigningKey is unset", async () => {
    const adapter = new PrivyAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      walletId: "wallet-123",
    })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { signature: `0x${"00".repeat(65)}` } }),
        { status: 200 },
      ),
    )

    await adapter.signMessage({ message: "hello" })
    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = reqInit.headers as Record<string, string>
    expect(headers["privy-authorization-signature"]).toBeUndefined()
  })
})

describe("TurnkeyAdapter getWalletInfo root-user detection", () => {
  let fetchSpy: FetchMock

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("flags isRootUser: true when whoami userId is in rootQuorum.userIds", async () => {
    const adapter = new TurnkeyAdapter({
      apiPublicKey: `04${"aa".repeat(64)}`,
      apiPrivateKey: "bb".repeat(32),
      organizationId: "org-123",
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://rpc.example.com",
    })

    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            organizationId: "org-123",
            organizationName: "Test Org",
            userId: "user-abc",
            username: "agent",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            organizationData: {
              rootQuorum: { userIds: ["user-abc", "user-other"] },
            },
          }),
          { status: 200 },
        ),
      )

    const info = await adapter.getWalletInfo()
    expect(info).toMatchObject({
      provider: "turnkey",
      userId: "user-abc",
      isRootUser: true,
    })
  })

  it("flags isRootUser: false when whoami userId is NOT in rootQuorum", async () => {
    const adapter = new TurnkeyAdapter({
      apiPublicKey: `04${"aa".repeat(64)}`,
      apiPrivateKey: "bb".repeat(32),
      organizationId: "org-123",
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      rpcUrl: "https://rpc.example.com",
    })

    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            organizationId: "org-123",
            userId: "user-non-root",
            username: "agent",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            organizationData: {
              rootQuorum: { userIds: ["user-other"] },
            },
          }),
          { status: 200 },
        ),
      )

    const info = await adapter.getWalletInfo()
    expect(info).toMatchObject({ isRootUser: false })
  })
})

describe("FireblocksAdapter / BankrAdapter getWalletInfo introspection flags", () => {
  let fetchSpy: FetchMock

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("Fireblocks getWalletInfo signals roleIntrospectable: false", async () => {
    const adapter = new FireblocksAdapter({
      apiKey: "k",
      apiSecret:
        "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
      vaultId: "v-1",
    })

    vi.spyOn(adapter, "getAddress").mockResolvedValueOnce("0xfb")

    const info = await adapter.getWalletInfo()
    expect(info).toEqual({
      provider: "fireblocks",
      address: "0xfb",
      vaultId: "v-1",
      roleIntrospectable: false,
    })
  })

  it("Bankr getWalletInfo signals scopeIntrospectable: false", async () => {
    const adapter = new BankrAdapter({ apiKey: "k" })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          wallets: [{ chain: "evm", address: "0xbankr" }],
        }),
        { status: 200 },
      ),
    )

    const info = await adapter.getWalletInfo()
    expect(info).toEqual({
      provider: "bankr",
      address: "0xbankr",
      scopeIntrospectable: false,
    })
  })
})
