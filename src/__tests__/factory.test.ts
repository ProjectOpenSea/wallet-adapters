import { afterEach, describe, expect, it } from "vitest"
import {
  createWalletForProvider,
  createWalletFromEnv,
  detectProvider,
} from "../factory.js"

describe("detectProvider", () => {
  afterEach(() => {
    delete process.env.PRIVY_APP_ID
    delete process.env.PRIVY_APP_SECRET
    delete process.env.PRIVY_WALLET_ID
    delete process.env.FIREBLOCKS_API_KEY
    delete process.env.FIREBLOCKS_API_SECRET
    delete process.env.FIREBLOCKS_VAULT_ID
    delete process.env.TURNKEY_API_PUBLIC_KEY
    delete process.env.TURNKEY_API_PRIVATE_KEY
    delete process.env.TURNKEY_ORGANIZATION_ID
    delete process.env.TURNKEY_WALLET_ADDRESS
    delete process.env.TURNKEY_RPC_URL
    delete process.env.PRIVATE_KEY
    delete process.env.RPC_URL
  })

  it("returns null when no env vars set", () => {
    expect(detectProvider()).toBeNull()
  })

  it("detects privy", () => {
    process.env.PRIVY_APP_ID = "test"
    process.env.PRIVY_WALLET_ID = "test"
    expect(detectProvider()).toBe("privy")
  })

  it("detects fireblocks", () => {
    process.env.FIREBLOCKS_API_KEY = "test"
    process.env.FIREBLOCKS_VAULT_ID = "0"
    expect(detectProvider()).toBe("fireblocks")
  })

  it("detects turnkey", () => {
    process.env.TURNKEY_API_PUBLIC_KEY = "test"
    process.env.TURNKEY_WALLET_ADDRESS = "0x123"
    expect(detectProvider()).toBe("turnkey")
  })

  it("detects private-key", () => {
    process.env.PRIVATE_KEY = "0xabc"
    expect(detectProvider()).toBe("private-key")
  })

  it("privy takes priority over others", () => {
    process.env.PRIVY_APP_ID = "test"
    process.env.PRIVY_WALLET_ID = "test"
    process.env.PRIVATE_KEY = "0xabc"
    expect(detectProvider()).toBe("privy")
  })
})

describe("createWalletFromEnv", () => {
  afterEach(() => {
    delete process.env.PRIVY_APP_ID
    delete process.env.PRIVY_APP_SECRET
    delete process.env.PRIVY_WALLET_ID
    delete process.env.PRIVATE_KEY
    delete process.env.RPC_URL
  })

  it("throws descriptive error when no provider configured", () => {
    expect(() => createWalletFromEnv()).toThrow("No wallet provider configured")
  })

  it("creates PrivateKeyAdapter when PRIVATE_KEY set", () => {
    process.env.PRIVATE_KEY =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    process.env.RPC_URL = "https://rpc.example.com"
    const adapter = createWalletFromEnv()
    expect(adapter.name).toBe("private-key")
  })

  it("creates PrivyAdapter when PRIVY env vars set", () => {
    process.env.PRIVY_APP_ID = "test-app"
    process.env.PRIVY_APP_SECRET = "test-secret"
    process.env.PRIVY_WALLET_ID = "test-wallet"
    const adapter = createWalletFromEnv()
    expect(adapter.name).toBe("privy")
  })
})

describe("createWalletForProvider", () => {
  afterEach(() => {
    delete process.env.PRIVATE_KEY
    delete process.env.RPC_URL
  })

  it("creates adapter for specified provider", () => {
    process.env.PRIVATE_KEY =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    process.env.RPC_URL = "https://rpc.example.com"
    const adapter = createWalletForProvider("private-key")
    expect(adapter.name).toBe("private-key")
  })

  it("throws for unknown provider", () => {
    expect(() => createWalletForProvider("unknown" as any)).toThrow(
      "Unknown wallet provider",
    )
  })
})
