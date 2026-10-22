# wallet-adapters — Agent Conventions

Provider-agnostic wallet adapters for signing and sending transactions across managed (Bankr, Privy, Turnkey, Fireblocks) and local private-key backends, plus a Solana `PrivySvmAdapter`. Used by `@opensea/cli` and `@opensea/tool-sdk`.

## Quick commands

```bash
cd packages/wallet-adapters
pnpm run build
pnpm run test
pnpm run lint
pnpm run type-check
```

## Responsibilities

- Define the `WalletAdapter` interface and capabilities.
- Implement adapters for each provider with `fromEnv()` constructors.
- Provide optional viem and ethers.js bridges.

## Rules

1. **Interface backward compatibility**. `WalletAdapter` is consumed by CLI and tool-sdk. New optional fields are fine; removing/changing required fields is breaking.
2. **Adapter parity**. Every adapter implements the full interface and truthfully declares `capabilities`: a flag is `true` only when the matching method is implemented. Parity applies to tests: behaviour added to the `WalletAdapter` contract is tested with `it.each(ALL_ADAPTERS)` from `src/__tests__/helpers/adapters.ts`, never a hand-listed subset, asserting adapter names rather than counts. Drive transactions through that module's `sendTransaction(factory, overrides)` helper so the EVM/SVM request split stays in the matrix instead of being re-derived in each suite.
3. **Key material security**. Never log or expose private keys, API secrets, or signing keys.
4. **Cryptographic correctness**. Turnkey uses P-256 ECDSA DER signatures; Fireblocks uses RS256 JWT signing; private-key uses `@noble/curves/secp256k1`.
5. **Bridge isolation**. Core adapters must not import viem or ethers. Bridges live in separate entry points (`./viem`, `./ethers`).
6. **Contract inputs**. Check optional inputs with `!== undefined`, never truthiness or `||`, so an explicitly supplied value (including `""`) is kept or rejected explicitly (`BlankIdempotencyKeyError` pattern), never silently dropped. Idempotency keys are per logical operation and reused across retries, so say so in every error message and JSDoc that mentions them.
7. **Injected functions and paths**. Call a configured `fetchImpl` through `fetchWith` (`src/util/fetchTransport.ts`), never as `this.config.fetchImpl(...)`, which makes the config object the receiver. Convert file URLs (`import.meta.url`) with `fileURLToPath` before passing them to `node:path` or `node:fs`.

## Conventions

- ESM-only, `.js` import extensions.
- viem and ethers are optional peer dependencies.
- `createWalletFromEnv()` priority: Privy > Fireblocks > Turnkey > Bankr > PrivateKey (EVM); pass `{ chainType: "svm" }` to select the Solana Privy wallet.
- Env var pattern: `PROVIDER_FIELD` (e.g. `PRIVY_APP_ID`).
