# wallet-adapters — Agent Conventions

Provider-agnostic wallet adapter library for signing and sending transactions across managed (Bankr, Privy, Turnkey, Fireblocks) and local (private key) backends. Supports both viem and ethers.js via optional bridge utilities.

## Quick Reference

```bash
cd packages/wallet-adapters
pnpm install
pnpm run build       # Build with tsup
pnpm run test        # Run tests with Vitest
pnpm run lint        # Lint with Biome
pnpm run format      # Format with Biome
pnpm run type-check  # TypeScript type checking
```

## Architecture

| Path | Role |
|------|------|
| `src/index.ts` | Library entry point — public exports |
| `src/types/index.ts` | Core interfaces: `WalletAdapter`, `TransactionRequest`, `WalletCapabilities` |
| `src/adapters/bankr.ts` | Bankr agent wallet API adapter |
| `src/adapters/privy.ts` | Privy server-side wallet API adapter |
| `src/adapters/turnkey.ts` | Turnkey HSM-backed signing with P-256 stamp auth |
| `src/adapters/fireblocks.ts` | Fireblocks enterprise MPC custody adapter |
| `src/adapters/private-key.ts` | Raw private key adapter (dev/testing) |
| `src/factory.ts` | `createWalletFromEnv()` — auto-detection from env vars |
| `src/util/eip712.ts` | EIP-712 typed data hashing utilities used by adapters for `signTypedData` |
| `src/bridges/viem.ts` | Bridge: WalletAdapter → viem WalletClient |
| `src/bridges/ethers.ts` | Bridge: WalletAdapter → ethers.js Signer |
| `src/__tests__/` | Vitest test suite |

## Design Principles

1. **Minimal runtime dependencies.** Only `@noble/hashes` and `@noble/curves` for private key operations. Managed adapters (Privy, Turnkey, Fireblocks) use Web Crypto APIs for their auth cryptography.

2. **Framework-agnostic core.** Adapters know nothing about viem or ethers.js. Bridge utilities (`./viem`, `./ethers`) are separate entry points with viem/ethers as optional peer dependencies.

3. **Capabilities-based interface.** Each adapter declares its `WalletCapabilities` (signMessage, signTypedData, managedGas, managedNonce). Consumers check capabilities before calling optional methods.

4. **Observability hooks.** All adapters support optional `onRequest` / `onResponse` callbacks for metrics, logging, and tracing.

5. **TransactionRequest is extensible.** Optional fields (`gas`, `nonce`, `maxFeePerGas`, `maxPriorityFeePerGas`) let callers pass pre-estimated values to avoid redundant RPC calls.

6. **Environment-based construction.** Each adapter has a `fromEnv()` static factory. `createWalletFromEnv()` auto-detects with priority: Privy > Fireblocks > Turnkey > Bankr > PrivateKey.

## Review Checklist

When reviewing changes to this package, verify:

1. **Interface backward compatibility.** The `WalletAdapter` interface is consumed by `@opensea/cli` and `@opensea/tool-sdk`. New optional fields are fine; removing or changing required fields is a breaking change.

2. **Adapter parity.** All adapters must implement the full `WalletAdapter` interface and correctly declare their `capabilities`. Test coverage must verify both the happy path and error cases.

3. **Security of key material.** Private keys, API secrets, and signing keys must never be logged, included in error messages, or exposed in stack traces.

4. **Cryptographic correctness.** The Turnkey adapter uses P-256 ECDSA with DER-encoded signatures. The Fireblocks adapter uses RS256 (RSASSA-PKCS1-v1_5 with SHA-256) for JWT signing. The private-key adapter uses `@noble/curves/secp256k1` for ECDSA signing. The Bankr adapter delegates signing to the Bankr Wallet API.

5. **Bridge isolation.** viem and ethers bridges must remain in separate entry points (`./viem`, `./ethers`). They must not be imported by the core adapters.

## Conventions

- ESM-only (`"type": "module"`). Use `.js` extensions in import paths.
- Biome for linting and formatting: double quotes, 2-space indent, trailing commas.
- viem and ethers.js are optional peer dependencies — never import them from core adapter code.
- Each adapter has a `fromEnv()` static factory and a constructor accepting a typed config object.
- Environment variable names follow the pattern: `PROVIDER_FIELD` (e.g., `PRIVY_APP_ID`, `TURNKEY_API_PUBLIC_KEY`).
