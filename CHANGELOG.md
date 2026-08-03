# @opensea/wallet-adapters

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
