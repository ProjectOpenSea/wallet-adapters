# wallet-adapters — Agent Conventions

Provider-agnostic wallet adapters for signing and sending transactions across managed (Bankr, Privy, Turnkey, Fireblocks) and local private-key backends. Used by `@opensea/cli` and `@opensea/tool-sdk`.

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
2. **Adapter parity**. Every adapter must implement the full interface and truthfully declare `capabilities`.
3. **Key material security**. Never log or expose private keys, API secrets, or signing keys.
4. **Cryptographic correctness**. Turnkey uses P-256 ECDSA DER signatures; Fireblocks uses RS256 JWT signing; private-key uses `@noble/curves/secp256k1`.
5. **Bridge isolation**. Core adapters must not import viem or ethers. Bridges live in separate entry points (`./viem`, `./ethers`).

## Conventions

- ESM-only, `.js` import extensions.
- viem and ethers are optional peer dependencies.
- `createWalletFromEnv()` priority: Privy > Fireblocks > Turnkey > Bankr > PrivateKey.
- Env var pattern: `PROVIDER_FIELD` (e.g. `PRIVY_APP_ID`).
