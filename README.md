# @opensea/wallet-adapters

> **Read-only mirror.** This package is developed in a private monorepo and mirrored to [ProjectOpenSea/wallet-adapters](https://github.com/ProjectOpenSea/wallet-adapters) when a version is released, so the public code can trail the internal main branch by weeks.
>
> Pull requests opened on the mirror cannot be merged there. They are read, and a fix worth taking is recreated in the monorepo. Because a fix that has landed internally is not public until the next release, filing an issue before writing a patch is the quickest way to find out whether a bug is already fixed.

Provider-agnostic wallet adapters for signing and sending transactions across managed and local backends.

## Why wallet-adapters?

`@opensea/wallet-adapters` is the shared wallet layer used across the OpenSea developer toolchain. Every package that needs to sign transactions depends on the same `WalletAdapter` interface:

- [`@opensea/sdk`](https://github.com/ProjectOpenSea/opensea-sdk) — TypeScript SDK for buying, selling, and managing NFTs
- [`@opensea/cli`](https://github.com/ProjectOpenSea/opensea-cli) — command-line interface for the OpenSea API
- [`@opensea/tool-sdk`](https://github.com/ProjectOpenSea/tool-sdk) — SDK for building ERC-8257 AI agent tools
- [`opensea-skill`](https://github.com/ProjectOpenSea/opensea-skill) — modular AI agent skills for Claude, Devin, and other assistants

By implementing the `WalletAdapter` interface once, a new wallet provider automatically works everywhere — the CLI, the SDK, AI agent tool execution, and any future package that depends on this library.

## Features

- **Provider-agnostic interface** — unified `WalletAdapter` abstraction with capabilities declaration
- **Managed providers** — Privy, Turnkey, Fireblocks, Bankr (handle gas/nonce server-side)
- **Local providers** — PrivateKey (handle gas/nonce client-side via RPC)
- **Framework bridges** — optional adapters for viem and ethers.js
- **Zero heavy dependencies** — core uses Web Crypto + `@noble/hashes` / `@noble/curves`
- **Auto-detection** — `createWalletFromEnv()` picks the right provider from environment variables

## Installation

```bash
npm install @opensea/wallet-adapters
# or
pnpm add @opensea/wallet-adapters
```

## Quick Start

```ts
import { createWalletFromEnv } from "@opensea/wallet-adapters"

// Auto-detects provider from environment variables
// Priority: Privy > Fireblocks > Turnkey > Bankr > PrivateKey
const wallet = createWalletFromEnv()

const address = await wallet.getAddress()
const result = await wallet.sendTransaction({
  to: "0x...",
  data: "0x...",
  value: "0",
  chainId: 8453,
})
console.log(`TX hash: ${result.hash}`)
```

## Adapters

### Privy

Server-side wallet via Privy's API. Handles gas estimation and nonce management.

```ts
import { PrivyAdapter } from "@opensea/wallet-adapters"

const wallet = PrivyAdapter.fromEnv()
// Requires: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID
```

### Fireblocks

Enterprise MPC custody via Fireblocks API.

```ts
import { FireblocksAdapter } from "@opensea/wallet-adapters"

const wallet = FireblocksAdapter.fromEnv()
// Requires: FIREBLOCKS_API_KEY, FIREBLOCKS_API_SECRET, FIREBLOCKS_VAULT_ID
```

### Turnkey

HSM-backed signing with P-256 stamp authentication.

```ts
import { TurnkeyAdapter } from "@opensea/wallet-adapters"

const wallet = TurnkeyAdapter.fromEnv()
// Requires: TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY,
//           TURNKEY_ORGANIZATION_ID, TURNKEY_WALLET_ADDRESS, TURNKEY_RPC_URL
```

### Bankr

Managed agent wallet via Bankr's Wallet API. Auth is a single API key; the provider handles gas, nonce, and broadcast.

```ts
import { BankrAdapter } from "@opensea/wallet-adapters"

const wallet = BankrAdapter.fromEnv()
// Requires: BANKR_API_KEY
```

### PrivateKey

Local signing for development and testing.

```ts
import { PrivateKeyAdapter } from "@opensea/wallet-adapters"

const wallet = PrivateKeyAdapter.fromEnv()
// Requires: PRIVATE_KEY, RPC_URL
```

## Framework Bridges

### viem

```ts
import { walletAdapterToViemClient } from "@opensea/wallet-adapters/viem"
import { base } from "viem/chains"

const client = walletAdapterToViemClient(wallet, base, "https://mainnet.base.org")
// Use as a standard viem WalletClient
```

### ethers.js

```ts
import { walletAdapterToEthersSigner } from "@opensea/wallet-adapters/ethers"

const signer = walletAdapterToEthersSigner(wallet, provider)
// Use as a standard ethers.js Signer
```

## Capabilities

Each adapter declares its capabilities so consumers can check before calling:

```ts
if (wallet.capabilities.signMessage) {
  const sig = await wallet.signMessage({ message: "hello" })
}

if (wallet.capabilities.managedGas) {
  // No need to estimate gas — the provider handles it
}
```

| Capability | Privy | Fireblocks | Turnkey | Bankr | PrivateKey |
|------------|-------|------------|---------|-------|------------|
| `signMessage` | true | true | true | true | true |
| `signTypedData` | true | true | true | true | true |
| `managedGas` | true | true | false | true | false |
| `managedNonce` | true | true | false | true | false |

## Observability

Attach hooks for tracing and monitoring:

```ts
wallet.onRequest = (method, params) => {
  console.log(`→ ${method}`, params)
}
wallet.onResponse = (method, result, durationMs) => {
  console.log(`← ${method} (${durationMs}ms)`, result)
}
```

## Adding a New Provider

To add a wallet provider, implement the `WalletAdapter` interface:

```ts
import type { WalletAdapter, WalletCapabilities } from "@opensea/wallet-adapters"

export class MyProviderAdapter implements WalletAdapter {
  readonly name = "my-provider"
  readonly capabilities: WalletCapabilities = {
    signMessage: true,
    signTypedData: true,
    managedGas: true,
    managedNonce: true,
  }

  async getAddress(): Promise<string> { /* ... */ }
  async sendTransaction(tx) { /* ... */ }
  async signMessage(request) { /* ... */ }
  async signTypedData(request) { /* ... */ }

  static fromEnv(): MyProviderAdapter { /* ... */ }
}
```

Then register it in the `createWalletFromEnv()` factory in `src/factory.ts` so the CLI and tool-sdk auto-detect it from environment variables.

## License

MIT
