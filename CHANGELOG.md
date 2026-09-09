# @opensea/wallet-adapters

## 1.1.0

### Minor Changes

- 621a0a9: Let a caller pass an idempotency key, so a retried send cannot broadcast twice.

  `EvmTransactionRequest` and `SvmTransactionRequest` accept an optional `idempotencyKey`. The Privy
  adapters forward it as the `privy-idempotency-key` header, which Privy documents as the mechanism
  for preventing double-spends: it stores the request and response for 24 hours and returns the stored
  response rather than re-executing. Previously there was no way to supply one, so a retry after a
  timeout was a second transaction.

  This is not `reference_id`, which Privy also accepts on a send and which is for reconciliation only:
  "Optional developer-provided reference ID for transaction reconciliation." It does not deduplicate.

  Generate one key per transaction you want to happen once, and reuse it on every retry of that
  transaction. The reuse is the mechanism: a retry with the same key returns the stored response,
  while a retry with a fresh key is a second transaction, so the key belongs outside the retry loop.
  Reusing a key with a changed body is rejected with a 400, which ties it to the request you built
  rather than to the caller or the session.

  A blank key throws `BlankIdempotencyKeyError` rather than being dropped or forwarded. Privy answers
  200 to both an empty and a whitespace-only `privy-idempotency-key`, verified against the live API,
  so forwarding one protects nothing while dropping one leaves the caller believing a retry is safe.
  An empty string almost always arrives from an unset variable.

  Four adapters cannot honour a key, so they **throw** `IdempotencyUnsupportedError` when handed one
  rather than dropping it: bankr, fireblocks, turnkey and private-key. A silently ignored key turns a
  retry into exactly the second transaction the caller was trying to avoid, and the throw happens
  before any network call. `capabilities.idempotentSend` tells a caller which it has, and is optional
  so an adapter written against 1.0.x still satisfies `WalletCapabilities`.

## 1.0.1

### Patch Changes

- 2d694a8: Reject a Solana wallet at the viem and ethers bridges rather than building a broken client.

  Both bridges are typed `EvmWalletAdapter`, and in 1.0.0 neither checked at runtime. This package
  publishes `main` and `types`, so a JavaScript consumer reaches them with no compile step, and the
  viem bridge returned a client that looked fine: `client.account.address` held a base58 Solana key,
  `eth_accounts` reported it as an Ethereum address, and the first transaction failed with
  "An unknown RPC error occurred", naming neither the wallet nor the reason.

  Found by driving the published 1.0.0 against a real Privy SVM wallet, not by a type error. The
  release notes claimed the viem bridge rejected a Solana wallet, and that was true of `tool-sdk`'s
  `walletAdapterToClient` wrapper, which does call `requireEvmAdapter`, but not of this package's own
  bridge.

  Both now call `requireEvmAdapter` before `getAddress()`. The order matters: viem rejects a base58
  key, so a guard placed after the address lookup is unreachable and the caller sees an address error
  instead of a chain-type one. The ethers guard sits in the `EthersAdapterSigner` constructor rather
  than only in `walletAdapterToEthersSigner`, so constructing the signer directly is covered too.

## 1.0.0

### Major Changes

- 6af806a: Make `WalletAdapter` chain-generic so non-EVM wallets can implement it.

  `WalletAdapter` is now a union discriminated on `chainType`, with `EvmWalletAdapter` and `SvmWalletAdapter` members over a shared `BaseWalletAdapter`. EVM and SVM share no transaction shape, address format or signing scheme, so a single interface covering both would be a pile of optional methods where half are always absent. Narrow with the exported `isEvmAdapter` / `isSvmAdapter` guards.

  `TransactionRequest` is renamed `EvmTransactionRequest`, with the old name kept as an alias. New `SvmTransactionRequest` and `SvmSignedTransaction` carry a serialized transaction rather than `to`/`data`/`value`, since a Solana transaction is instructions over accounts with no single recipient. `SvmWalletAdapter` requires `signTransaction` and leaves `sendTransaction` optional, the reverse of EVM: sign-only providers are ordinary on Solana, where a fee payer co-signs or the caller broadcasts with its own commitment policy.

  The ethers and viem bridges now take `EvmWalletAdapter`, since both are EVM clients. Flows that are EVM-only in substance say so at the type level rather than failing later on a missing method: x402 settlement (EIP-3009), `swaps.execute`, and the `auth`/`smoke` commands that sign EIP-712. Each rejects a Solana wallet with a message naming the reason.

  `requireEvmAdapter(adapter, purpose)` and `WrongChainTypeError` are exported for the four EVM-only flows, so they share one check and one message instead of four hand-written copies that drift.

  `SvmWalletAdapter.capabilities` is typed as the new exported `SvmWalletCapabilities`, which pins `signTypedData` to the literal `false`. EIP-712 is an Ethereum scheme and `SvmWalletAdapter` declares no `signTypedData` method, so an SVM adapter claiming that capability would advertise an operation no consumer could call.

  No adapter behavior changes. The five existing providers declare `chainType: "evm"` and are otherwise untouched.

### Minor Changes

- c33ddc3: Add `PrivySvmAdapter`, a Solana implementation of `SvmWalletAdapter`.

  Signs through Privy's `/v1/wallets/{id}/rpc`: `signTransaction` to sign without broadcasting,
  `signAndSendTransaction` to sign and submit, and `signMessage`. Privy's SVM RPCs accept only
  `encoding: "base64"`, so a `Uint8Array` request is converted here rather than passed through, and
  the signed result comes back base64 already, which is what `SvmSignedTransaction` promises.
  `sendTransaction` defaults `caip2` to Solana mainnet, since that RPC requires a cluster while
  sign-only ignores one.

  Request bodies are pinned to the types `@privy-io/node` publishes, derived from Privy's own RPC
  input union and discriminated by the same `method` string the adapter sends, so a field they rename
  fails `type-check` rather than failing as a 4xx.

  `createWalletFromEnv`, `createWalletForProvider` and `detectProvider` take an optional
  `{ chainType }` selector, defaulting to `"evm"` so existing callers are unchanged. A Privy wallet is
  bound to one `chain_type`, so the Solana wallet is a separate wallet with its own id, read from
  `PRIVY_SVM_WALLET_ID`. Both chains can be configured at once, and asking for one while only the
  other is configured says so and names the variable to set.

  `PrivyAdapter` and `PrivySvmAdapter` now share `PrivyTransport` for credentials, the
  authorization-signature header and the RPC envelope, rather than keeping two copies that drift.
  No EVM behavior changes.

  Not yet exercised against a live Privy wallet. Every shape here is checked against their published
  types, and the adapter is unit tested against a stubbed transport, but no real Solana transaction
  has been signed or landed.

### Patch Changes

- 6af806a: Fix `PrivyAdapter.signTypedData`, which sent a request Privy rejects.

  It posted `params.typedData` as a JSON string containing `primaryType`. Privy takes
  `params.typed_data` as an object containing `primary_type`, so EIP-712 signing through Privy could
  not have worked. This affects the `auth` and `smoke` commands and x402 settlement, all of which
  sign typed data.

  The test that covered it did `JSON.parse(body.params.typedData)` and asserted
  `typedData.primaryType`, reading back the same shape the adapter had just written, so it passed
  against a body the API rejects. Request bodies are now pinned to the types `@privy-io/node`
  publishes, in `privy-rpc-shapes.test.ts`: they are derived from Privy's own RPC input union rather
  than transcribed from their docs, so a field they rename fails `type-check` here instead of
  failing as a 4xx in production. The import is `import type`, so `@privy-io/node` stays an optional
  peer dependency and nothing joins the runtime graph.

## 0.3.5

### Patch Changes

- f1882a8: Bridges: infer the EIP-712 primary type as the root of the type graph rather than the first key in `types`. Signing without an explicit `primaryType` picked the first declared struct, so listing a dependency before the root (`Person` above `Mail`) signed the dependency. Now mirrors ethers.js. Thanks to @Nexory (ProjectOpenSea/wallet-adapters#2).
- 93f028c: `type-check` now covers this package's `test/` directory, through a `tsconfig.check.json` matching
  the one sdk and api-types already use. It previously compiled `src/` only, so nothing typechecked
  its test files.

  Split out of the cli changeset for the same change: wallet-adapters is held out of that release.

## 0.3.4

### Patch Changes

- 7d2dbef: Sync OpenAPI spec: add `stablechain` to `ChainIdentifier`, add `Chain.StableChain` (chain id 988) to the SDK and generated chain maps

## 0.3.3

### Patch Changes

- 569fd4f: Harden EIP-712 encoding of non-integer types so malformed input throws instead of being silently misencoded. The `address` encoder now validates a 0x-prefixed hex string of at most 20 bytes (previously `.replace("0x", "")` stripped only the first `0x` anywhere in the string and non-hex characters were silently encoded as zero); `bytes`/`bytesN` values with odd-length or non-hex input, or wider than 32 bytes, are rejected; and the shared hex parser rejects odd-length and non-hex strings rather than truncating or storing `NaN`. This complements the integer range checks by ensuring every EIP-712 field either encodes exactly what the caller intended or throws.
- a541527: Validate integer values before EIP-712 encoding instead of silently wrapping out-of-domain values. A negative value for an unsigned `uint*` type now throws (previously it wrapped into a huge positive integer via two's complement, e.g. turning a negative token amount into a near-max transfer authorization). Values that exceed the declared width — `uint`/`int` beyond their range, including sub-256 widths like `uint8`/`int8` — are also rejected with a clear error. Two's-complement encoding is retained for in-range signed `int*` values, as required by EIP-712.

## 0.3.2

### Patch Changes

- 158f38f: Fix `BankrAdapter.signTypedData` throwing on EIP-712 payloads containing BigInt fields (e.g. EIP-3009 `value`/`validAfter`/`validBefore`, `chainId`). BigInts are now serialized to strings before sending to the Bankr `/wallet/sign` API.

## 0.3.1

### Patch Changes

- c982513: Make `RPC_URL` optional for signing-only workflows. The factory and the private-key adapter no longer require `RPC_URL` when an adapter is only used to sign (not broadcast) transactions, so a key configured purely for signing no longer fails to initialize. A read provider is created lazily and only when a chain operation actually needs one.

## 0.3.0

### Minor Changes

- 9ecf704: Provider-aware wallet hardening across Privy, Turnkey, Fireblocks, and Bankr.

  **`@opensea/wallet-adapters`**

  - New `WalletInfo` discriminated union exported.
  - New optional `getWalletInfo()` method on `WalletAdapter` (implemented by all four managed providers).
  - Privy adapter: optional `PRIVY_AUTH_SIGNING_KEY` env var enables `privy-authorization-signature` header on `/rpc` requests via `@privy-io/node` (added as optional peer dependency), supporting the `owner_id` + `additional_signer` hardening pattern.
  - Privy adapter: `personal_sign` now sends `params.encoding` ("utf-8" / "hex") to satisfy Privy's RPC schema (was previously omitting this and getting 400s on owner-gated wallets).
  - Privy adapter: 401 errors with `Invalid app ID or app secret` body now include a `printf %s` hint for the `echo` vs `echo -n` debugging dead-end.
  - Top-of-file security-model docstrings on all four adapters declaring signing-only intent and forbidding mutation surfaces.

  **`@opensea/cli`**

  - New `opensea wallet` command group with three subcommands:
    - `wallet info` — provider-aware posture readout, hardening warnings to stderr, structured info to stdout.
    - `wallet create` — Privy-only, `POST /v1/wallets`. Optional `--owner-public-key` registers an `owner_id` at create time. Narrow mutation surface: creates new resources only.
    - `wallet generate-auth-key` — pure-local P-256 keypair generation, no API calls.

## 0.2.1

### Patch Changes

- d73daa7: fix: add `repository`, `homepage`, and top-level `license` fields to package.json

  Sigstore provenance verification on `npm publish` requires the published package's `repository.url` to match the GitHub Actions workflow that signed the attestation. Without this field, the public-repo publish workflow for v0.2.0 failed with `422 Unprocessable Entity – Failed to validate repository information`. Aligns wallet-adapters with the format used by `@opensea/sdk` and `@opensea/api-types`.

## 0.2.0

### Minor Changes

- a81071b: Add Bankr wallet adapter (`BankrAdapter`). Bankr is a managed agent wallet service that signs and submits transactions via its Wallet API using an API key (`BANKR_API_KEY`). Supports `getAddress`, `sendTransaction`, `signMessage`, and `signTypedData`. Auto-detected by `createWalletFromEnv()` with highest priority when `BANKR_API_KEY` is set.
