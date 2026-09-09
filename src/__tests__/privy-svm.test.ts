import type { PrivyIntentsService } from "@privy-io/node"
import type { MockInstance } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildSvmSignMessageParams,
  buildSvmTransactionParams,
  PrivySvmAdapter,
  SOLANA_MAINNET_CAIP2,
  toBase64Transaction,
} from "../adapters/privy-svm.js"
import { isSvmAdapter, requireEvmAdapter } from "../types/index.js"

type FetchMock = MockInstance<typeof global.fetch>

// Privy's raw RPC bodies, derived from their published union rather than their docs. See
// privy-rpc-shapes.test.ts for why this is the right target.
type PrivyRpcInput = Parameters<PrivyIntentsService["rpc"]>[1]
type PrivyRpcFor<M extends PrivyRpcInput["method"]> = Extract<
  PrivyRpcInput,
  { method: M }
>

const CONFIG = {
  appId: "app-1",
  appSecret: "secret-1",
  walletId: "svm-wallet-1",
}
const ADDRESS = "So11111111111111111111111111111111111111112"

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

function lastBody(fetchSpy: FetchMock) {
  const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit
  return JSON.parse(init.body as string)
}

describe("PrivySvmAdapter request shapes", () => {
  let fetchSpy: FetchMock
  let adapter: PrivySvmAdapter

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
    adapter = new PrivySvmAdapter(CONFIG)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("declares svm and no typed-data capability", () => {
    expect(adapter.chainType).toBe("svm")
    expect(isSvmAdapter(adapter)).toBe(true)
    expect(adapter.capabilities.signTypedData).toBe(false)
  })

  it("is rejected by the EVM-only flows with a message naming the reason", () => {
    expect(() => requireEvmAdapter(adapter, "swap execution")).toThrow(
      'wallet "privy-svm" signs for svm; swap execution requires an EVM wallet',
    )
  })

  it("signs a transaction as base64 and returns Privy's base64 result", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: { signed_transaction: "c2lnbmVk", encoding: "base64" },
      }),
    )

    const result = await adapter.signTransaction({
      transaction: new Uint8Array([1, 2, 3]),
    })

    expect(result.signedTransaction).toBe("c2lnbmVk")

    const body = lastBody(fetchSpy)
    expect(body.method).toBe("signTransaction")
    expect(body.params).toEqual({ transaction: "AQID", encoding: "base64" })
    // Sign-only takes no cluster, so sending one would be wrong rather than merely redundant.
    expect(body.caip2).toBeUndefined()
    expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe(
      "https://api.privy.io/v1/wallets/svm-wallet-1/rpc",
    )
  })

  it("sends the same base64 whether given bytes or base64", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ data: { signed_transaction: "x" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { signed_transaction: "x" } }),
      )

    await adapter.signTransaction({ transaction: new Uint8Array([1, 2, 3]) })
    const fromBytes = lastBody(fetchSpy).params.transaction
    await adapter.signTransaction({ transaction: "AQID" })
    const fromBase64 = lastBody(fetchSpy).params.transaction

    expect(fromBytes).toBe("AQID")
    expect(fromBase64).toBe("AQID")
  })

  it("requires caip2 on send and defaults it to Solana mainnet", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ data: { hash: "sig-1", caip2: SOLANA_MAINNET_CAIP2 } }),
    )

    const result = await adapter.sendTransaction({ transaction: "AQID" })

    expect(result.hash).toBe("sig-1")
    const body = lastBody(fetchSpy)
    expect(body.method).toBe("signAndSendTransaction")
    expect(body.caip2).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
  })

  it("passes a caller's cluster through instead of the default", async () => {
    const devnet = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
    fetchSpy.mockResolvedValueOnce(jsonResponse({ data: { hash: "sig-2" } }))

    await adapter.sendTransaction({ transaction: "AQID", caip2: devnet })

    expect(lastBody(fetchSpy).caip2).toBe(devnet)
  })

  it("signs a message as base64, not the EVM hex-or-utf-8 pair", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ data: { signature: "c2ln", encoding: "base64" } }),
    )

    const sig = await adapter.signMessage({ message: "hello" })

    expect(sig).toBe("c2ln")
    const body = lastBody(fetchSpy)
    expect(body.method).toBe("signMessage")
    expect(body.params.encoding).toBe("base64")
    expect(body.params.message).toBe(
      Buffer.from("hello", "utf8").toString("base64"),
    )
  })

  it("returns a base58 address that nothing may checksum", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        id: "svm-wallet-1",
        address: ADDRESS,
        chain_type: "solana",
      }),
    )

    const address = await adapter.getAddress()

    expect(address).toBe(ADDRESS)
    expect(address).not.toMatch(/^0x/)
  })

  it("caches the address across calls", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        id: "svm-wallet-1",
        address: ADDRESS,
        chain_type: "solana",
      }),
    )

    expect(await adapter.getAddress()).toBe(ADDRESS)
    expect(await adapter.getAddress()).toBe(ADDRESS)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("surfaces the status and body when Privy rejects a request", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("wallet is not a solana wallet", { status: 400 }),
    )

    await expect(
      adapter.signTransaction({ transaction: "AQID" }),
    ).rejects.toThrow(
      "Privy signTransaction failed (400): wallet is not a solana wallet",
    )
  })
})

describe("PrivySvmAdapter params satisfy Privy's published types", () => {
  it("signTransaction params", () => {
    // The annotation is the assertion: a renamed field or a widened encoding fails to compile.
    const params: PrivyRpcFor<"signTransaction">["params"] =
      buildSvmTransactionParams({ transaction: new Uint8Array([1, 2, 3]) })
    expect(params).toEqual({ transaction: "AQID", encoding: "base64" })
  })

  it("signAndSendTransaction params and caip2", () => {
    const params: PrivyRpcFor<"signAndSendTransaction">["params"] =
      buildSvmTransactionParams({ transaction: "AQID" })
    const caip2: PrivyRpcFor<"signAndSendTransaction">["caip2"] =
      SOLANA_MAINNET_CAIP2
    expect(params.encoding).toBe("base64")
    expect(caip2).toBe(SOLANA_MAINNET_CAIP2)
  })

  it("signMessage params", () => {
    const params: PrivyRpcFor<"signMessage">["params"] =
      buildSvmSignMessageParams({ message: "hi" })
    expect(params.encoding).toBe("base64")
  })

  it("normalizes both transaction representations identically", () => {
    expect(toBase64Transaction(new Uint8Array([1, 2, 3]))).toBe("AQID")
    expect(toBase64Transaction("AQID")).toBe("AQID")
  })
})

describe("PrivySvmAdapter.fromEnv", () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it("reads PRIVY_SVM_WALLET_ID, not PRIVY_WALLET_ID", () => {
    process.env.PRIVY_APP_ID = "app"
    process.env.PRIVY_APP_SECRET = "secret"
    process.env.PRIVY_WALLET_ID = "the-evm-one"
    delete process.env.PRIVY_SVM_WALLET_ID

    expect(() => PrivySvmAdapter.fromEnv()).toThrow(
      "PRIVY_SVM_WALLET_ID environment variable is required",
    )
  })

  it("builds an adapter when the SVM wallet id is set", () => {
    process.env.PRIVY_APP_ID = "app"
    process.env.PRIVY_APP_SECRET = "secret"
    process.env.PRIVY_SVM_WALLET_ID = "the-svm-one"

    expect(PrivySvmAdapter.fromEnv().name).toBe("privy-svm")
  })
})
