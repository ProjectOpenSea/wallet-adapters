import { generateKeyPairSync } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
import { PrivySvmAdapter } from "../adapters/privy-svm.js"
import { TurnkeyAdapter } from "../adapters/turnkey.js"
import type { FetchImpl } from "../types/index.js"

/**
 * Every adapter config takes an optional `fetchImpl`. These assert the parts
 * that make it worth having: the injected transport receives the
 * request, the global `fetch` is never reached, so a suite that uses it needs
 * neither a network nor a reassigned global, and the transport is invoked with
 * the receiver unbound native fetch requires.
 */

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

/** PEM PKCS8 RSA key, the shape Fireblocks signs its request JWT with. */
function rsaPem(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey
}

/** Hex-encoded raw P-256 scalar, the shape Turnkey stamps requests with. */
function p256Hex(): string {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  })
  const d = privateKey.export({ format: "jwk" }).d as string
  return Buffer.from(d, "base64url").toString("hex")
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

/** A `fetchImpl` that records its calls and replies with queued responses. */
function recordingFetch(...responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let next = 0
  const impl: FetchImpl = (input, init) => {
    calls.push({ url: String(input), init: init as RequestInit })
    return Promise.resolve(responses[next++] ?? json({}))
  }
  return { impl, calls }
}

describe("fetchImpl seam", () => {
  let globalFetch: MockInstance<typeof global.fetch>

  beforeEach(() => {
    // Not a stub with a canned reply: this asserts the global is never
    // consulted, so reaching it must fail the test rather than answer it.
    globalFetch = vi.spyOn(global, "fetch").mockImplementation(() => {
      throw new Error("global fetch was called; fetchImpl was not used")
    })
  })

  afterEach(() => {
    globalFetch.mockRestore()
  })

  it("PrivyAdapter routes wallet reads through the injected fetch", async () => {
    const { impl, calls } = recordingFetch(
      json({ id: "w1", address: "0xabc", chain_type: "ethereum" }),
    )
    const adapter = new PrivyAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      walletId: "wallet-123",
      fetchImpl: impl,
    })

    expect(await adapter.getAddress()).toBe("0xabc")
    expect(calls[0].url).toBe("https://api.privy.io/v1/wallets/wallet-123")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("PrivyAdapter routes RPC through the injected fetch", async () => {
    const { impl, calls } = recordingFetch(
      json({ data: { signature: `0x${"ab".repeat(65)}` } }),
    )
    const adapter = new PrivyAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      walletId: "wallet-123",
      fetchImpl: impl,
    })

    await adapter.signMessage({ message: "hello" })

    expect(calls[0].url).toBe("https://api.privy.io/v1/wallets/wallet-123/rpc")
    const body = JSON.parse(calls[0].init?.body as string)
    expect(body.method).toBe("personal_sign")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("PrivySvmAdapter shares the transport, so it inherits the seam", async () => {
    const { impl, calls } = recordingFetch(
      json({
        id: "w1",
        address: "So11111111111111111111111111111111111111112",
        chain_type: "solana",
      }),
    )
    const adapter = new PrivySvmAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      walletId: "svm-wallet-1",
      fetchImpl: impl,
    })

    expect(await adapter.getAddress()).toBe(
      "So11111111111111111111111111111111111111112",
    )
    expect(calls).toHaveLength(1)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("BankrAdapter routes wallet reads through the injected fetch", async () => {
    const { impl, calls } = recordingFetch(
      json({ data: { evmAddress: "0xdef" } }),
    )
    const adapter = new BankrAdapter({ apiKey: "key-1", fetchImpl: impl })

    await adapter.getAddress().catch(() => undefined)

    expect(calls[0].url).toBe("https://api.bankr.bot/wallet/me")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("FireblocksAdapter routes vault reads through the injected fetch", async () => {
    const { impl, calls } = recordingFetch(
      json([{ address: "0xfeed", assetId: "ETH" }]),
    )
    const adapter = new FireblocksAdapter({
      apiKey: "key-1",
      apiSecret: rsaPem(),
      vaultId: "0",
      fetchImpl: impl,
    })

    await adapter.getAddress().catch(() => undefined)

    expect(calls[0].url).toBe(
      "https://api.fireblocks.io/v1/vault/accounts/0/ETH/addresses",
    )
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("TurnkeyAdapter routes signed requests through the injected fetch", async () => {
    const { impl, calls } = recordingFetch(
      json({ organizationId: "org-1", userId: "user-1", username: "signer" }),
    )
    const adapter = new TurnkeyAdapter({
      apiPublicKey: "02".padEnd(66, "0"),
      apiPrivateKey: p256Hex(),
      organizationId: "org-1",
      walletAddress: `0x${"33".repeat(20)}`,
      rpcUrl: "https://rpc.example.com",
      fetchImpl: impl,
    })

    await adapter.getWalletInfo().catch(() => undefined)

    expect(calls[0].url).toBe("https://api.turnkey.com/public/v1/query/whoami")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("PrivateKeyAdapter routes JSON-RPC through the injected fetch", async () => {
    const { impl, calls } = recordingFetch(
      json({ jsonrpc: "2.0", id: 1, result: "0x1" }),
      json({ jsonrpc: "2.0", id: 1, result: "0x5208" }),
      json({
        jsonrpc: "2.0",
        id: 1,
        result: { baseFeePerGas: ["0x1"], reward: [["0x1"]] },
      }),
      json({ jsonrpc: "2.0", id: 1, result: `0x${"11".repeat(32)}` }),
    )
    const adapter = new PrivateKeyAdapter({
      privateKey: TEST_PRIVATE_KEY,
      rpcUrl: "https://rpc.example.com",
      fetchImpl: impl,
    })

    await adapter
      .sendTransaction({
        to: `0x${"22".repeat(20)}`,
        data: "0x",
        value: "0x0",
        chainId: 1,
      })
      .catch(() => undefined)

    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0].url).toBe("https://rpc.example.com")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("calls the transport with globalThis as its receiver", async () => {
    // The contract `fetchWith` implements, and the same one
    // `@opensea/sdk` asserts. A non-arrow records whatever receiver it is
    // given; a plain `impl(input, init)` would record `undefined` instead.
    let receiver: unknown = "unset"
    const impl = function (this: unknown) {
      receiver = this
      return Promise.resolve(json({ id: "w1", address: "0xabc" }))
    } as unknown as FetchImpl

    const adapter = new PrivyAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      walletId: "wallet-123",
      fetchImpl: impl,
    })
    await adapter.getAddress()

    expect(receiver).toBe(globalThis)
  })

  it("satisfies a transport that fails the way browsers do", async () => {
    // Chrome 152 rejects `fetch.call({}, url)` with "Failed to execute 'fetch'
    // on 'Window': Illegal invocation" while accepting the global and nullish
    // receivers. This stand-in fails the same way, so the contract is pinned
    // rather than assumed. Mirrors `receiverStrict` in the SDK's specs.
    const receiverStrict = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation")
      }
      return Promise.resolve(json({ id: "w1", address: "0xabc" }))
    } as unknown as FetchImpl

    const adapter = new PrivyAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      walletId: "wallet-123",
      fetchImpl: receiverStrict,
    })

    await expect(adapter.getAddress()).resolves.toBe("0xabc")
  })

  it("never hands the transport a foreign receiver, per a native brand check", async () => {
    // The hazard a hand-written comparison cannot demonstrate: reading the
    // transport off `this.config` and calling it as a method would make the
    // config object the receiver, which is the shape real browsers reject.
    // Node's `crypto` global accessor is an actual engine-enforced brand
    // check with the same rule as native fetch, so no assertion in this test
    // is written by hand: it accepts the global and nullish, and throws
    // TypeError for any other object.
    const cryptoGetter = Object.getOwnPropertyDescriptor(
      globalThis,
      "crypto",
    )?.get
    expect(cryptoGetter).toBeTypeOf("function")

    const brandChecked = function (this: unknown) {
      cryptoGetter?.call(this)
      return Promise.resolve(json({ id: "w1", address: "0xabc" }))
    } as unknown as FetchImpl

    const adapter = new PrivyAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      walletId: "wallet-123",
      fetchImpl: brandChecked,
    })

    await expect(adapter.getAddress()).resolves.toBe("0xabc")
  })

  it("does not clobber the receiver of a deliberately bound transport", async () => {
    // `.call(globalThis, ...)` is ignored by an already-bound function, so a
    // caller who bound a transport on purpose keeps their own receiver.
    const owner = { marker: "owner" as const }
    const bound = function (this: typeof owner) {
      expect(this.marker).toBe("owner")
      return Promise.resolve(json({ id: "w1", address: "0xabc" }))
    }.bind(owner) as unknown as FetchImpl

    const adapter = new PrivyAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      walletId: "wallet-123",
      fetchImpl: bound,
    })

    await expect(adapter.getAddress()).resolves.toBe("0xabc")
  })
})

/**
 * The behavioral cases cover each adapter's own request path. This reads the
 * sources as well, so a call site added later cannot quietly go back to the
 * global, and so a file with no reachable runtime case is still covered.
 */
describe("no adapter calls the global fetch directly", () => {
  const adaptersDir = join(import.meta.dirname, "..", "adapters")

  /**
   * `fetchWith` owns the fallback, so an adapter invoking `fetch` under any
   * spelling is reaching past the seam. Deliberately no `(?<!\.)` lookbehind:
   * that excluded exactly the qualified forms worth catching, and nothing in
   * an adapter should call `fetch` as a property either. `fetchWith(` does not
   * match, because the character after `fetch` is not `(`.
   *
   * A string index or a computed member (`globalThis["fetch"](...)`) still
   * slips past, as does any textual guard. The runtime cases above are what
   * cover the reachable paths; this catches the careless edit.
   */
  const CALLS_FETCH = /\bfetch\s*\(/

  it("the guard pattern catches qualified spellings, not fetchWith", () => {
    // Without this, weakening the pattern would silently pass every file.
    expect("fetch(url)").toMatch(CALLS_FETCH)
    expect("globalThis.fetch(url)").toMatch(CALLS_FETCH)
    expect("window.fetch(url)").toMatch(CALLS_FETCH)
    expect("self.fetch(url)").toMatch(CALLS_FETCH)
    expect("await fetchWith(this.config.fetchImpl, url)").not.toMatch(
      CALLS_FETCH,
    )
    expect("fetchImpl?: FetchImpl").not.toMatch(CALLS_FETCH)
  })

  for (const file of readdirSync(adaptersDir).filter(f => f.endsWith(".ts"))) {
    it(`${file} routes every call through fetchWith`, () => {
      const source = readFileSync(join(adaptersDir, file), "utf8")

      expect(source).not.toMatch(CALLS_FETCH)
    })

    it(`${file} does not reintroduce a per-adapter transport helper`, () => {
      // Five byte-identical copies of this helper is what the shared
      // `fetchWith` replaced. A sixth would drift from the other five, and a
      // method named `fetchImpl` collides with the config field it reads,
      // which is what made the bare call easy to write in the first place.
      const source = readFileSync(join(adaptersDir, file), "utf8")

      expect(source).not.toMatch(/private\s+fetchImpl\s*\(/)
    })
  }
})
