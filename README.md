# @opensea/wallet-adapters

Provider-agnostic wallet adapters for signing and sending transactions across managed and local backends.

## Features

- **Provider-agnostic interface** — unified `WalletAdapter` abstraction with capabilities declaration
- **Managed providers** — Privy, Turnkey, Fireblocks (handle gas/nonce server-side)
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
// Priority: Privy > Fireblocks > Turnkey > PrivateKey
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

| Capability | Privy | Fireblocks | Turnkey | PrivateKey |
|------------|-------|------------|---------|------------|
| `signMessage` | true | true | true | true |
| `signTypedData` | true | true | true | true |
| `managedGas` | true | true | false | false |
| `managedNonce` | true | true | false | false |

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

## License

MIT
