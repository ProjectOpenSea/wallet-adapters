# @opensea/wallet-adapters

## 0.2.1

### Patch Changes

- d73daa7: fix: add `repository`, `homepage`, and top-level `license` fields to package.json

  Sigstore provenance verification on `npm publish` requires the published package's `repository.url` to match the GitHub Actions workflow that signed the attestation. Without this field, the public-repo publish workflow for v0.2.0 failed with `422 Unprocessable Entity – Failed to validate repository information`. Aligns wallet-adapters with the format used by `@opensea/sdk` and `@opensea/api-types`.

## 0.2.0

### Minor Changes

- a81071b: Add Bankr wallet adapter (`BankrAdapter`). Bankr is a managed agent wallet service that signs and submits transactions via its Wallet API using an API key (`BANKR_API_KEY`). Supports `getAddress`, `sendTransaction`, `signMessage`, and `signTypedData`. Auto-detected by `createWalletFromEnv()` with highest priority when `BANKR_API_KEY` is set.
