import type { MockInstance } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BankrAdapter } from "../adapters/bankr.js"
import { FireblocksAdapter } from "../adapters/fireblocks.js"
import { PrivateKeyAdapter } from "../adapters/private-key.js"
import { PrivyAdapter } from "../adapters/privy.js"
import { PrivySvmAdapter } from "../adapters/privy-svm.js"
import { TurnkeyAdapter } from "../adapters/turnkey.js"
import {
  BlankIdempotencyKeyError,
  IdempotencyUnsupportedError,
} from "../types/index.js"

type FetchMock = MockInstance<typeof global.fetch>

const CONFIG = { appId: "app", appSecret: "secret", walletId: "w1" }
const KEY = "b3f1c0de-0000-4000-8000-000000000001"

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 })

/** The header, from the actual request the adapter made. */
function headerFrom(fetchSpy: FetchMock, name: string) {
  const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit
  return (init.headers as Record<string, string>)[name]
}

describe("Privy adapters forward an idempotency key", () => {
  let fetchSpy: FetchMock

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch")
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("declares the capability, so a caller can tell before sending", () => {
    expect(new PrivyAdapter(CONFIG).capabilities.idempotentSend).toBe(true)
    expect(new PrivySvmAdapter(CONFIG).capabilities.idempotentSend).toBe(true)
    // Absent rather than false on an adapter that cannot honour one.
    expect(
      new BankrAdapter({ apiKey: "k" }).capabilities.idempotentSend,
    ).not.toBe(true)
  })

  it("EVM sendTransaction sends privy-idempotency-key", async () => {
    fetchSpy.mockResolvedValueOnce(json({ data: { hash: "0xabc" } }))

    await new PrivyAdapter(CONFIG).sendTransaction({
      to: "0x0000000000000000000000000000000000000000",
      data: "0x",
      value: "0",
      chainId: 1,
      idempotencyKey: KEY,
    })

    // The header itself, not a field in the body: Privy reads it from the header.
    expect(headerFrom(fetchSpy, "privy-idempotency-key")).toBe(KEY)
  })

  it("SVM signAndSendTransaction sends it", async () => {
    fetchSpy.mockResolvedValueOnce(json({ data: { hash: "sig" } }))

    await new PrivySvmAdapter(CONFIG).sendTransaction({
      transaction: "AQID",
      idempotencyKey: KEY,
    })

    expect(headerFrom(fetchSpy, "privy-idempotency-key")).toBe(KEY)
  })

  it("SVM signTransaction sends it too", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({ data: { signed_transaction: "AQID", encoding: "base64" } }),
    )

    await new PrivySvmAdapter(CONFIG).signTransaction({
      transaction: "AQID",
      idempotencyKey: KEY,
    })

    expect(headerFrom(fetchSpy, "privy-idempotency-key")).toBe(KEY)
  })

  it("omits the header entirely when no key is given", async () => {
    fetchSpy.mockResolvedValueOnce(json({ data: { hash: "0xabc" } }))

    await new PrivyAdapter(CONFIG).sendTransaction({
      to: "0x0000000000000000000000000000000000000000",
      data: "0x",
      value: "0",
      chainId: 1,
    })

    expect(headerFrom(fetchSpy, "privy-idempotency-key")).toBeUndefined()
  })
})

describe("adapters that cannot honour a key throw rather than drop it", () => {
  const key = { idempotencyKey: KEY }
  const tx = {
    to: "0x0000000000000000000000000000000000000000",
    data: "0x",
    value: "0",
    chainId: 1,
  }

  it("PrivateKeyAdapter throws, naming the wallet and the risk", async () => {
    const adapter = new PrivateKeyAdapter({
      privateKey:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
    })

    await expect(adapter.sendTransaction({ ...tx, ...key })).rejects.toThrow(
      IdempotencyUnsupportedError,
    )
    await expect(adapter.sendTransaction({ ...tx, ...key })).rejects.toThrow(
      /could send twice/,
    )
  })

  it("BankrAdapter throws", async () => {
    await expect(
      new BankrAdapter({ apiKey: "k" }).sendTransaction({ ...tx, ...key }),
    ).rejects.toThrow(IdempotencyUnsupportedError)
  })

  it("throws before doing any network work", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")
    await expect(
      new BankrAdapter({ apiKey: "k" }).sendTransaction({ ...tx, ...key }),
    ).rejects.toThrow(IdempotencyUnsupportedError)
    // A key that arrives too late to help is worse than an error: the send would already be away.
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it("FireblocksAdapter and TurnkeyAdapter throw as well", async () => {
    // All four adapters call the guard, so cover all four rather than the two that were convenient
    // to construct.
    const fireblocks = new FireblocksAdapter({
      apiKey: "k",
      apiSecret: "s",
      vaultId: "0",
    })
    const turnkey = new TurnkeyAdapter({
      apiPublicKey: "pub",
      apiPrivateKey: "priv",
      organizationId: "org",
      walletAddress: "0x0000000000000000000000000000000000000000",
      rpcUrl: "https://example.invalid",
    })

    await expect(fireblocks.sendTransaction({ ...tx, ...key })).rejects.toThrow(
      IdempotencyUnsupportedError,
    )
    await expect(turnkey.sendTransaction({ ...tx, ...key })).rejects.toThrow(
      IdempotencyUnsupportedError,
    )
  })

  it("still sends normally when no key is supplied", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(json({ txHash: "0xdead" }))

    await new BankrAdapter({ apiKey: "k" }).sendTransaction(tx).catch(() => {})

    expect(fetchSpy).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe("a blank key is rejected rather than dropped or forwarded", () => {
  const tx = {
    to: "0x0000000000000000000000000000000000000000",
    data: "0x",
    value: "0",
    chainId: 1,
  }

  /**
   * Privy answers 200 to both an empty and a whitespace-only `privy-idempotency-key`, verified
   * against the live API. So forwarding one protects nothing, and dropping one leaves the caller
   * believing a retry is safe. An empty string almost always comes from an unset variable, which
   * makes it a caller mistake worth naming rather than absorbing.
   */
  it.each([
    "",
    "   ",
  ])("rejects %j even on an adapter that supports keys", async blank => {
    await expect(
      new PrivyAdapter(CONFIG).sendTransaction({
        ...tx,
        idempotencyKey: blank,
      }),
    ).rejects.toThrow(BlankIdempotencyKeyError)
  })

  it("rejects a blank key on the SVM sign path too", async () => {
    await expect(
      new PrivySvmAdapter(CONFIG).signTransaction({
        transaction: "AQID",
        idempotencyKey: "",
      }),
    ).rejects.toThrow(BlankIdempotencyKeyError)
  })

  it("tells the caller to reuse the key, not to regenerate it", async () => {
    // The wording is load-bearing. "Pass a unique value per attempt" was the first version, and
    // read naturally it means per network retry, which defeats idempotency entirely: a fresh key
    // on a retry is a second transaction. Pinning the corrected guidance so it cannot drift back.
    const err = await new PrivyAdapter(CONFIG)
      .sendTransaction({ ...tx, idempotencyKey: "" })
      .catch((e: Error) => e)

    expect(err).toBeInstanceOf(BlankIdempotencyKeyError)
    expect((err as Error).message).toMatch(/per transaction/)
    expect((err as Error).message).toMatch(/reuse it on every retry/)
    expect((err as Error).message).not.toMatch(/per attempt/)
  })

  it("reports blank rather than unsupported when both apply", async () => {
    // Order matters for the message: blank is the actionable fault, and reporting "unsupported"
    // would send the caller to change providers over a typo.
    await expect(
      new BankrAdapter({ apiKey: "k" }).sendTransaction({
        ...tx,
        idempotencyKey: "  ",
      }),
    ).rejects.toThrow(BlankIdempotencyKeyError)
  })
})
