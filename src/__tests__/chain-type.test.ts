import { describe, expect, it } from "vitest"
import { PrivateKeyAdapter } from "../adapters/private-key.js"
import {
  isEvmAdapter,
  isSvmAdapter,
  requireEvmAdapter,
  type SvmWalletAdapter,
  type WalletAdapter,
  WrongChainTypeError,
} from "../types/index.js"

/**
 * `WalletAdapter` is a union discriminated on `chainType`. These pin the runtime half of that;
 * the compile-time half is enforced by `type-check`, which rejects a chain-specific method
 * accessed on the union without narrowing first.
 */
describe("chain type discrimination", () => {
  const key =
    "0x1111111111111111111111111111111111111111111111111111111111111111"

  const svmStub: SvmWalletAdapter = {
    name: "svm-stub",
    chainType: "svm",
    capabilities: {
      signMessage: true,
      // No typed-data scheme exists on Solana, so this is always false for SVM.
      signTypedData: false,
      managedGas: false,
      managedNonce: false,
    },
    getAddress: async () => "So11111111111111111111111111111111111111112",
    // Mirrors what a real adapter must do: accept either representation, hand back base64.
    signTransaction: async ({ transaction }) => ({
      signedTransaction:
        typeof transaction === "string"
          ? transaction
          : Buffer.from(transaction).toString("base64"),
    }),
  }

  it("narrows a real EVM adapter", () => {
    const adapter: WalletAdapter = new PrivateKeyAdapter({ privateKey: key })

    expect(adapter.chainType).toBe("evm")
    expect(isEvmAdapter(adapter)).toBe(true)
    expect(isSvmAdapter(adapter)).toBe(false)

    if (!isEvmAdapter(adapter)) throw new Error("expected an EVM adapter")
    // Reachable only after narrowing; on the bare union this does not compile.
    expect(typeof adapter.sendTransaction).toBe("function")
  })

  it("narrows an SVM adapter", () => {
    const adapter: WalletAdapter = svmStub

    expect(isSvmAdapter(adapter)).toBe(true)
    expect(isEvmAdapter(adapter)).toBe(false)

    if (!isSvmAdapter(adapter)) throw new Error("expected an SVM adapter")
    expect(typeof adapter.signTransaction).toBe("function")
    // Sign-only providers are valid on SVM, so broadcasting is optional here.
    expect(adapter.sendTransaction).toBeUndefined()
  })

  it("returns base64 for either request representation", async () => {
    // The request accepts Uint8Array or base64; the signed result is always base64, because that
    // is what Solana RPC sendTransaction takes. Pinning it so the doc claim stays true.
    const fromBytes = await svmStub.signTransaction({
      transaction: new Uint8Array([1, 2, 3]),
    })
    const fromBase64 = await svmStub.signTransaction({
      transaction: "AQID",
    })

    // Both representations of the same three bytes must land on the same base64 string. An
    // assertion on `typeof` alone passes for "", which is what a constant stub returns.
    expect(fromBytes.signedTransaction).toBe("AQID")
    expect(fromBase64.signedTransaction).toBe("AQID")
  })

  it("declares no typed-data capability on SVM", () => {
    expect(svmStub.capabilities.signTypedData).toBe(false)
  })

  it("rejects an SVM adapter that claims typed-data support", () => {
    // The runtime assertion above only pins this one stub. `SvmWalletCapabilities` pins the type
    // for every SVM adapter, and the directive below is what proves it: if the literal `false`
    // constraint were relaxed back to `boolean`, `signTypedData: true` would compile and
    // `type-check` would fail with "Unused '@ts-expect-error' directive". CI runs `type-check`
    // for this package, so the guard is live there and not only locally.
    const claimsTypedData: SvmWalletAdapter = {
      ...svmStub,
      capabilities: {
        ...svmStub.capabilities,
        // @ts-expect-error SVM adapters have no signTypedData method, so true is not assignable.
        signTypedData: true,
      },
    }

    expect(claimsTypedData.chainType).toBe("svm")
  })

  it("returns a base58 address on SVM and a hex one on EVM", async () => {
    const evm = new PrivateKeyAdapter({ privateKey: key })

    expect(await evm.getAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(await svmStub.getAddress()).not.toMatch(/^0x/)
  })
})

describe("requireEvmAdapter", () => {
  const key =
    "0x2222222222222222222222222222222222222222222222222222222222222222"

  const svm: SvmWalletAdapter = {
    name: "svm-mock",
    chainType: "svm",
    capabilities: {
      signMessage: true,
      signTypedData: false,
      managedGas: false,
      managedNonce: false,
    },
    getAddress: async () => "So11111111111111111111111111111111111111112",
    signTransaction: async () => ({ signedTransaction: "" }),
  }

  it("returns the adapter unchanged when it is EVM", () => {
    const evm = new PrivateKeyAdapter({ privateKey: key })

    expect(requireEvmAdapter(evm, "swap execution")).toBe(evm)
  })

  it("throws WrongChainTypeError for an SVM adapter", () => {
    expect(() => requireEvmAdapter(svm, "swap execution")).toThrow(
      WrongChainTypeError,
    )
  })

  it("names the wallet, its chain, and what needed EVM", () => {
    // One message for all four EVM-only flows, so they cannot drift apart.
    try {
      requireEvmAdapter(svm, "swap execution")
      throw new Error("expected a throw")
    } catch (err) {
      expect(err).toBeInstanceOf(WrongChainTypeError)
      const wrong = err as WrongChainTypeError
      expect(wrong.message).toBe(
        'wallet "svm-mock" signs for svm; swap execution requires an EVM wallet',
      )
      expect(wrong.adapter).toBe(svm)
      expect(wrong.required).toBe("evm")
      expect(wrong.purpose).toBe("swap execution")
    }
  })

  it("carries structured fields so a library caller can branch, not parse", () => {
    const wrong = new WrongChainTypeError(svm, "evm", "x402 payment")

    expect(wrong.name).toBe("WrongChainTypeError")
    expect(wrong.adapter.chainType).toBe("svm")
  })
})
