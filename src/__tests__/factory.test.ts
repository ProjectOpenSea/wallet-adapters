import { afterEach, describe, expect, it } from "vitest"
import {
  createWalletForProvider,
  createWalletFromEnv,
  detectProvider,
} from "../factory.js"

describe("detectProvider", () => {
  afterEach(() => {
    delete process.env.BANKR_API_KEY
    delete process.env.PRIVY_APP_ID
    delete process.env.PRIVY_APP_SECRET
    delete process.env.PRIVY_WALLET_ID
    delete process.env.PRIVY_SVM_WALLET_ID
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

  it("detects bankr", () => {
    process.env.BANKR_API_KEY = "test"
    expect(detectProvider()).toBe("bankr")
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

  it("privy takes priority over bankr and private-key", () => {
    process.env.PRIVY_APP_ID = "test"
    process.env.PRIVY_WALLET_ID = "test"
    process.env.BANKR_API_KEY = "test"
    process.env.PRIVATE_KEY = "0xabc"
    expect(detectProvider()).toBe("privy")
  })

  it("bankr takes priority over private-key", () => {
    process.env.BANKR_API_KEY = "test"
    process.env.PRIVATE_KEY = "0xabc"
    expect(detectProvider()).toBe("bankr")
  })
})

describe("createWalletFromEnv", () => {
  afterEach(() => {
    delete process.env.BANKR_API_KEY
    delete process.env.PRIVY_APP_ID
    delete process.env.PRIVY_APP_SECRET
    delete process.env.PRIVY_WALLET_ID
    delete process.env.PRIVY_SVM_WALLET_ID
    delete process.env.PRIVATE_KEY
    delete process.env.RPC_URL
  })

  it("throws descriptive error when no provider configured", () => {
    // Names the chain family, since a Solana wallet can be configured while no EVM one is.
    expect(() => createWalletFromEnv()).toThrow(
      "No EVM wallet provider configured",
    )
    expect(() => createWalletFromEnv()).toThrow("PRIVY_WALLET_ID")
  })

  it("creates BankrAdapter when BANKR_API_KEY set", () => {
    process.env.BANKR_API_KEY = "test-key"
    const adapter = createWalletFromEnv()
    expect(adapter.name).toBe("bankr")
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
    delete process.env.BANKR_API_KEY
    delete process.env.PRIVATE_KEY
    delete process.env.RPC_URL
  })

  it("creates BankrAdapter for bankr provider", () => {
    process.env.BANKR_API_KEY = "test-key"
    const adapter = createWalletForProvider("bankr")
    expect(adapter.name).toBe("bankr")
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

describe("chain-family selection", () => {
  afterEach(() => {
    delete process.env.PRIVY_APP_ID
    delete process.env.PRIVY_APP_SECRET
    delete process.env.PRIVY_WALLET_ID
    delete process.env.PRIVY_SVM_WALLET_ID
  })

  function configurePrivy({ evm, svm }: { evm?: boolean; svm?: boolean }) {
    process.env.PRIVY_APP_ID = "app"
    process.env.PRIVY_APP_SECRET = "secret"
    if (evm) process.env.PRIVY_WALLET_ID = "evm-wallet"
    if (svm) process.env.PRIVY_SVM_WALLET_ID = "svm-wallet"
  }

  it("detects an SVM provider only from the SVM wallet id", () => {
    configurePrivy({ evm: true })

    expect(detectProvider()).toBe("privy")
    expect(detectProvider({ chainType: "svm" })).toBeNull()
  })

  it("serves both chains when both wallets are configured", () => {
    // The reason for a second variable rather than a chain argument over one id: a Privy wallet
    // is bound to one chain_type, so these are two different wallets.
    configurePrivy({ evm: true, svm: true })

    expect(createWalletFromEnv().chainType).toBe("evm")
    expect(createWalletFromEnv({ chainType: "svm" }).chainType).toBe("svm")
    expect(detectProvider({ chainType: "svm" })).toBe("privy")
  })

  it("defaults to EVM when no selector is passed", () => {
    configurePrivy({ evm: true, svm: true })

    const adapter = createWalletFromEnv()

    expect(adapter.chainType).toBe("evm")
    expect(adapter.name).toBe("privy")
  })

  it("points at the selector when only a Solana wallet is configured", () => {
    configurePrivy({ svm: true })

    expect(() => createWalletFromEnv()).toThrow(
      "No EVM wallet provider configured",
    )
    expect(() => createWalletFromEnv()).toThrow(
      'createWalletFromEnv({ chainType: "svm" })',
    )
  })

  it("explains the separate wallet when only an EVM wallet is configured", () => {
    configurePrivy({ evm: true })

    expect(() => createWalletFromEnv({ chainType: "svm" })).toThrow(
      "No Solana wallet provider configured",
    )
    expect(() => createWalletFromEnv({ chainType: "svm" })).toThrow(
      "PRIVY_SVM_WALLET_ID",
    )
  })

  it("refuses a Solana wallet from a provider that has no SVM adapter", () => {
    process.env.BANKR_API_KEY = "key"

    expect(() =>
      createWalletForProvider("bankr", { chainType: "svm" }),
    ).toThrow('Wallet provider "bankr" has no Solana adapter')

    delete process.env.BANKR_API_KEY
  })
})
