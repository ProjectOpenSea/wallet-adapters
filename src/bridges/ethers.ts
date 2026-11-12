/**
 * Bridge between WalletAdapter and ethers.js Signer.
 *
 * Creates an ethers.js AbstractSigner from any WalletAdapter, routing
 * transaction signing through the adapter's signing backend.
 *
 * @example
 * ```ts
 * import { createWalletFromEnv } from "@opensea/wallet-adapters"
 * import { walletAdapterToEthersSigner } from "@opensea/wallet-adapters/ethers"
 * import { JsonRpcProvider } from "ethers"
 *
 * const adapter = createWalletFromEnv()
 * const provider = new JsonRpcProvider("https://...")
 * const signer = walletAdapterToEthersSigner(adapter, provider)
 * ```
 *
 * ethers v6 is a peer dependency, so consumers must install it separately.
 */

import {
  AbstractSigner,
  getAddress as checksumAddress,
  hexlify,
  isAddress,
  type Provider,
  resolveAddress,
  type TransactionRequest,
  type TransactionResponse,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers"
import type { EvmWalletAdapter, WalletAdapter } from "../types/index.js"
import { requireEvmAdapter } from "../types/index.js"

/**
 * An ethers v6 `Provider` from either the ESM or the CommonJS build.
 *
 * ethers ships separate declarations for the two builds, and their classes carry private fields,
 * so TypeScript treats a provider from one as unrelated to the same type from the other. This
 * module is ESM and its `Provider` is the ESM copy, which a CommonJS project's `new JsonRpcProvider()`
 * does not satisfy. This interface picks the members whose declarations agree across both builds and
 * writes the ones the signer calls without naming a build-specific class. At runtime the signer only calls
 * provider methods, so a provider from either build works.
 */
export interface EthersProviderLike
  extends Pick<
    Provider,
    | "getBlockNumber"
    | "getFeeData"
    | "getBalance"
    | "getTransactionCount"
    | "getCode"
    | "estimateGas"
    | "call"
    | "resolveName"
    | "lookupAddress"
  > {
  getNetwork(): Promise<{ readonly chainId: bigint }>
  getTransaction(hash: string): Promise<unknown>
  waitForTransaction(
    hash: string,
    confirms?: number,
    timeout?: number,
  ): Promise<unknown>
}

/**
 * Create an ethers.js Signer from a WalletAdapter.
 *
 * The result is an ethers `AbstractSigner`, so it can be passed anywhere an ethers `Signer` is
 * accepted (`new OpenSeaSDK(signer, ...)`, `new Contract(address, abi, signer)`, seaport-js).
 * `signMessage` and `signTypedData` throw when the adapter does not support them.
 *
 * Takes the `WalletAdapter` union, which is what `createWalletFromEnv()` returns, and throws
 * `WrongChainTypeError` for a Solana wallet, so `walletAdapterToEthersSigner(createWalletFromEnv(),
 * provider)` compiles without the caller narrowing first. The CLI's `swaps.execute` takes the
 * union for the same reason.
 */
export function walletAdapterToEthersSigner(
  adapter: WalletAdapter,
  provider?: Provider | EthersProviderLike | null,
): EthersAdapterSigner {
  return new EthersAdapterSigner(adapter, provider)
}

const UNSUPPORTED_TX_FIELDS = [
  "type",
  "gasPrice",
  "accessList",
  "authorizationList",
  "blobs",
  "blobVersionedHashes",
  "maxFeePerBlobGas",
] as const satisfies ReadonlyArray<keyof TransactionRequest>

export class EthersAdapterSigner extends AbstractSigner {
  readonly adapter: EvmWalletAdapter

  constructor(
    adapter: WalletAdapter,
    provider?: Provider | EthersProviderLike | null,
  ) {
    super(provider as Provider | null | undefined)
    // In the constructor rather than the factory, so a caller that builds the signer directly is
    // covered too. Without it a Solana wallet, whether from a TypeScript caller passing the union or
    // a JavaScript consumer with no compile step, would get a signer whose `getAddress()` returns a
    // base58 Solana key, failing later somewhere that names neither the wallet nor the reason.
    // Matches the viem bridge.
    this.adapter = requireEvmAdapter(adapter, "an ethers signer")
  }

  /**
   * Checksummed, as every ethers signer returns it. Some adapters return lowercase hex, and
   * consumers such as @opensea/sdk compare the checksummed form exactly.
   */
  async getAddress(): Promise<string> {
    return checksumAddress(await this.adapter.getAddress())
  }

  connect(provider: Provider | EthersProviderLike | null): EthersAdapterSigner {
    return new EthersAdapterSigner(this.adapter, provider)
  }

  async signTransaction(): Promise<string> {
    throw new Error(
      `signTransaction is not supported by the ethers bridge: the ${this.adapter.name} adapter signs and broadcasts in one step. Use sendTransaction.`,
    )
  }

  /**
   * Overrides AbstractSigner's populate, sign and broadcast flow, because adapters sign and
   * broadcast in one call. Returns the provider's view of the transaction when it is already
   * indexed, else (including when that lookup fails) a minimal response whose `wait()` polls the
   * provider for the receipt. Throws before sending when `tx.chainId` is not the provider's chain
   * or `tx.from` is not this wallet, as ethers' own signers do, and when the request sets a field
   * the adapter request has no slot for, rather than sending without it.
   */
  async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    const provider = this.provider
    if (!provider) {
      throw new Error(
        "The ethers bridge needs a provider to send a transaction. Pass one to walletAdapterToEthersSigner or connect().",
      )
    }
    const chainId = Number((await provider.getNetwork()).chainId)
    if (tx.chainId != null && BigInt(tx.chainId) !== BigInt(chainId)) {
      throw new Error(
        `Transaction chainId ${tx.chainId} does not match the provider's network (chainId ${chainId}). Connect the signer to a provider for that chain.`,
      )
    }
    const unsupported = UNSUPPORTED_TX_FIELDS.filter(field => tx[field] != null)
    if (unsupported.length > 0) {
      throw new Error(
        `The ethers bridge cannot forward ${unsupported.join(", ")}: the adapter transaction request has no field for ${unsupported.length === 1 ? "it" : "them"}, and the adapter chooses the transaction type itself. Use maxFeePerGas and maxPriorityFeePerGas for fees.`,
      )
    }
    if (tx.from != null) {
      const [address, from] = await Promise.all([
        this.getAddress(),
        resolveAddress(tx.from, provider),
      ])
      if (address.toLowerCase() !== from.toLowerCase()) {
        throw new Error(
          `Transaction from ${from} does not match the ${this.adapter.name} adapter's wallet ${address}.`,
        )
      }
    }
    // A hex address passes through as given; an ENS name or Addressable is resolved the way
    // ethers' own signers resolve it, and an unresolvable name throws before anything is sent.
    const to =
      tx.to == null
        ? ""
        : typeof tx.to === "string" && isAddress(tx.to)
          ? tx.to
          : await resolveAddress(tx.to, provider)

    const result = await this.adapter.sendTransaction({
      to,
      // Typed `string`, but a JavaScript caller can pass bytes, which ethers itself accepts.
      data: tx.data != null ? hexlify(tx.data) : "0x",
      value: tx.value != null ? String(BigInt(tx.value)) : "0",
      chainId,
      gas: decimalOrUndefined(tx.gasLimit),
      nonce: tx.nonce ?? undefined,
      maxFeePerGas: decimalOrUndefined(tx.maxFeePerGas),
      maxPriorityFeePerGas: decimalOrUndefined(tx.maxPriorityFeePerGas),
    })

    // The adapter has already broadcast, so a failed lookup must not turn into a rejection: a
    // caller would read that as unsent and could send the same transaction again.
    const indexed = await provider.getTransaction(result.hash).catch(() => null)
    if (indexed) {
      return indexed
    }
    return {
      hash: result.hash,
      wait: (confirms?: number, timeout?: number) =>
        provider.waitForTransaction(result.hash, confirms, timeout),
    } as unknown as TransactionResponse
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    if (!this.adapter.signMessage) {
      throw new Error(
        `signMessage is not supported by the ${this.adapter.name} adapter`,
      )
    }
    return this.adapter.signMessage({ message })
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, any>,
    primaryType?: string,
  ): Promise<string> {
    if (!this.adapter.signTypedData) {
      throw new Error(
        `signTypedData is not supported by the ${this.adapter.name} adapter`,
      )
    }
    // ethers.js uses "value" while our interface uses "message"
    return this.adapter.signTypedData({
      domain: toJsonSafe(domain, true) as Record<string, unknown>,
      types,
      message: toJsonSafe(value, false) as Record<string, unknown>,
      primaryType: primaryType ?? inferPrimaryType(types),
    })
  }
}

/**
 * ethers hands typed data over with bigint fields (seaport-js takes `domain.chainId` straight from
 * `provider.getNetwork()`), and adapters that post the request as JSON, such as Privy, throw on a
 * bigint. Converts them the way ethers' own `TypedDataEncoder.getPayload` does before a JSON-RPC
 * signer sees them: a domain bigint becomes a number when it is a safe integer, and every other
 * bigint becomes a decimal string. Only arrays and plain objects are walked, so a `bytes` value
 * passed as a `Uint8Array` reaches the adapter unchanged.
 */
function toJsonSafe(input: unknown, inDomain: boolean): unknown {
  if (typeof input === "bigint") {
    return inDomain && Number.isSafeInteger(Number(input))
      ? Number(input)
      : input.toString()
  }
  if (Array.isArray(input)) {
    return input.map(item => toJsonSafe(item, inDomain))
  }
  if (isPlainObject(input)) {
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, toJsonSafe(v, inDomain)]),
    )
  }
  return input
}

/** Keeps an explicit zero, which a truthiness check would drop and leave to the adapter's default. */
function decimalOrUndefined(
  value: TransactionRequest["gasLimit"],
): string | undefined {
  return value != null ? String(BigInt(value)) : undefined
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object") {
    return false
  }
  const proto = Object.getPrototypeOf(input)
  return proto === Object.prototype || proto === null
}

/**
 * Kept in step with `inferPrimaryType` in @opensea/sdk (`src/utils/eip712.ts`),
 * which cannot import this one without taking a dependency on this package.
 * Change both together.
 *
 * Infer the EIP-712 primary type the way ethers.js does: the struct that is not
 * referenced as a field type by any other struct (the root of the type graph).
 * The previous heuristic took the first key in `types`, which signs the wrong
 * struct when the root is not declared first (e.g. dependencies listed above it).
 */
function inferPrimaryType(types: Record<string, unknown>): string {
  const named = Object.keys(types).filter(t => t !== "EIP712Domain")
  const referenced = new Set<string>()
  for (const name of named) {
    const fields = types[name]
    if (!Array.isArray(fields)) continue
    for (const field of fields) {
      // Strips trailing array suffixes, including repeated ones: Person[],
      // Person[2] and Mail[2][] all reduce to the struct name. EIP-712 field
      // types are an atomic type, an array of those, or a struct name, so
      // there is no nesting to unwrap beyond this. Solidity tuple syntax is
      // not part of the format and ethers rejects it as an unknown type.
      const base = String((field as { type?: unknown }).type).replace(
        /(\[\d*\])+$/,
        "",
      )
      if (base in types) referenced.add(base)
    }
  }
  if (named.length === 0) {
    return ""
  }
  const roots = named.filter(t => !referenced.has(t))
  // Falling back to the first declared type here would re-introduce exactly the
  // bug this function exists to fix, and silently sign the wrong struct. Both
  // shapes are invalid EIP-712 and ethers itself rejects them ("circular type
  // reference", "ambiguous primary types or unused types"), so refusing loses
  // nothing for an ethers-backed adapter and prevents a wrong signature from an
  // adapter that does not validate.
  if (roots.length === 0) {
    throw new Error(
      `Cannot infer EIP-712 primaryType: every type is referenced by another, so the type graph is circular (${named.join(", ")}). Pass primaryType explicitly.`,
    )
  }
  if (roots.length > 1) {
    throw new Error(
      `Cannot infer EIP-712 primaryType: ${roots.join(", ")} are all unreferenced, so the root is ambiguous. Pass primaryType explicitly.`,
    )
  }
  return roots[0]
}
