import type { PrivyIntentsService } from "@privy-io/node"
import { describe, expect, it } from "vitest"
import {
  buildPersonalSignParams,
  buildSignTypedDataParams,
} from "../adapters/privy.js"
import type { SvmTransactionRequest } from "../types/index.js"

/**
 * Pins this adapter's Privy request bodies to the types `@privy-io/node` publishes.
 *
 * These are derived from Privy's own exported service interfaces rather than transcribed from
 * their docs, so a field they rename or retype fails `type-check` here instead of failing as a
 * 4xx in production. `import type` is erased at build time, so `@privy-io/node` stays an optional
 * peer dependency and nothing is added to the runtime graph.
 *
 * This exists because `eth_signTypedData_v4` shipped in 0.3.5 sending a `typedData` JSON string
 * with `primaryType`, where Privy takes a `typed_data` object with `primary_type`. The test that
 * was supposed to cover it did `JSON.parse(body.params.typedData)` and asserted
 * `typedData.primaryType`, reading back the same wrong shape the adapter had just written, so it
 * passed against a request the API rejects.
 */

/**
 * Privy's raw RPC body types, reached through the one exported service that takes the whole
 * discriminated union: `PrivyIntentsService.rpc`. The per-method param types are not exported
 * from the package root.
 *
 * The union is the right target rather than the per-chain service methods, because those take a
 * flattened convenience input (`{ message }`, `{ transaction }`) and encode on your behalf, while
 * this adapter posts the raw body to `/v1/wallets/{id}/rpc` itself. `Extract` by the same `method`
 * string the adapter sends, so the two cannot drift apart.
 */
type PrivyRpcInput = Parameters<PrivyIntentsService["rpc"]>[1]
type PrivyRpcFor<M extends PrivyRpcInput["method"]> = Extract<
  PrivyRpcInput,
  { method: M }
>

// Indexed with a concrete literal each time. A generic `M` leaves `Extract` unresolved, and some
// members of the union have no `params`, so `["params"]` is not indexable through a type parameter.
type PrivyPersonalSignParams = PrivyRpcFor<"personal_sign">["params"]
type PrivyTypedDataParams = PrivyRpcFor<"eth_signTypedData_v4">["params"]
type PrivySvmSignTxParams = PrivyRpcFor<"signTransaction">["params"]
type PrivySvmSendParams = PrivyRpcFor<"signAndSendTransaction">["params"]

describe("Privy RPC request shapes match the published SDK types", () => {
  it("personal_sign params satisfy Privy's type", () => {
    // The annotation is the assertion: a wrong key or a widened `encoding` fails to compile.
    const fromString: PrivyPersonalSignParams = buildPersonalSignParams({
      message: "hello",
    })
    const fromBytes: PrivyPersonalSignParams = buildPersonalSignParams({
      message: new Uint8Array([1, 2, 3]),
    })

    expect(fromString).toEqual({ message: "hello", encoding: "utf-8" })
    expect(fromBytes).toEqual({ message: "0x010203", encoding: "hex" })
  })

  it("eth_signTypedData_v4 params satisfy Privy's type", () => {
    const params: PrivyTypedDataParams = buildSignTypedDataParams({
      domain: { name: "OpenSea", version: "1", chainId: 1 },
      types: { Message: [{ name: "contents", type: "string" }] },
      primaryType: "Message",
      message: { contents: "hi" },
    })

    // Privy takes a nested object, not a JSON string, so this is a real property access.
    expect(params.typed_data.primary_type).toBe("Message")
    expect(typeof params.typed_data).toBe("object")
    expect(params.typed_data.message).toEqual({ contents: "hi" })
    // The shapes that shipped in 0.3.5 and were rejected by the API.
    expect(params).not.toHaveProperty("typedData")
    expect(params.typed_data).not.toHaveProperty("primaryType")
  })

  it("Privy's SVM signTransaction takes base64 and returns base64", () => {
    // Pins the two facts SvmWalletAdapter's contract rests on: Privy accepts only a base64
    // string, and hands back `signed_transaction`, also base64. That is why
    // `SvmSignedTransaction.signedTransaction` is always base64 whatever the request used.
    const params: PrivySvmSignTxParams = {
      transaction: Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"),
      encoding: "base64",
    }
    expect(params.transaction).toBe("AQID")

    // A caller may hand us either form; both must reach Privy as that one base64 string.
    const asBytes: SvmTransactionRequest = {
      transaction: new Uint8Array([1, 2, 3]),
    }
    const asBase64: SvmTransactionRequest = { transaction: "AQID" }
    const toParam = (tx: SvmTransactionRequest["transaction"]) =>
      typeof tx === "string" ? tx : Buffer.from(tx).toString("base64")
    expect(toParam(asBytes.transaction)).toBe(toParam(asBase64.transaction))
  })

  it("Privy's SVM signAndSendTransaction takes base64 too", () => {
    // `SvmTransactionRequest` carries an optional caip2 because this RPC requires one, unlike
    // sign-only. The adapter defaults it to Solana mainnet.
    const params: PrivySvmSendParams = {
      transaction: "AQID",
      encoding: "base64",
    }
    const caip2: PrivyRpcFor<"signAndSendTransaction">["caip2"] =
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

    expect(params.encoding).toBe("base64")
    expect(caip2).toContain("solana:")
  })
})
