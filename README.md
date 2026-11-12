# @opensea/wallet-adapters

One `WalletAdapter` interface for signing and sending transactions through managed providers (Privy, Fireblocks, Turnkey, Bankr) or a local private key.

[`@opensea/sdk`](https://github.com/ProjectOpenSea/opensea-sdk), [`@opensea/cli`](https://github.com/ProjectOpenSea/opensea-cli), [`@opensea/tool-sdk`](https://github.com/ProjectOpenSea/tool-sdk), and [`opensea-skill`](https://github.com/ProjectOpenSea/opensea-skill) all sign through this interface, so a provider implemented here works in each of them.

- Managed providers (Privy, Fireblocks, Bankr) handle gas and nonces server-side. Turnkey and PrivateKey fetch them from an RPC endpoint.
- `createWalletFromEnv()` picks a provider from environment variables.
- Optional bridges turn an adapter into a viem `WalletClient` or an ethers `Signer`.
- The core depends only on Web Crypto and `@noble/hashes` / `@noble/curves`. `viem`, `ethers`, and `@privy-io/node` are optional peer dependencies.

## Installation

```bash
npm install @opensea/wallet-adapters
# or
pnpm add @opensea/wallet-adapters
```

## Quick start

```ts
import { createWalletFromEnv, requireEvmAdapter } from "@opensea/wallet-adapters"

// Auto-detects provider from environment variables
// Priority: Privy > Fireblocks > Turnkey > Bankr > PrivateKey
const wallet = requireEvmAdapter(createWalletFromEnv(), "quick start")

const address = await wallet.getAddress()
const result = await wallet.sendTransaction({
  to: "0x...",
  data: "0x...",
  value: "0",
  chainId: 8453,
})
console.log(`TX hash: ${result.hash}`)
```

`createWalletFromEnv()` returns an EVM wallet by default. Pass `{ chainType: "svm" }` for a Solana wallet, which only Privy supports (it reads `PRIVY_SVM_WALLET_ID` instead of `PRIVY_WALLET_ID`). The return type covers both chain families, so narrow it with `requireEvmAdapter` or `isEvmAdapter` before calling EVM-only methods.

## Adapters

### Privy

Server-side wallet through Privy's API. Privy estimates gas and manages nonces.

```ts
import { PrivyAdapter } from "@opensea/wallet-adapters"

const wallet = PrivyAdapter.fromEnv()
// Requires: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID
```

### Fireblocks

MPC custody through the Fireblocks API.

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

Agent wallet through Bankr's Wallet API. One API key authenticates, and Bankr handles gas, nonces, and broadcast.

```ts
import { BankrAdapter } from "@opensea/wallet-adapters"

const wallet = BankrAdapter.fromEnv()
// Requires: BANKR_API_KEY
```

### PrivateKey

Local signing for development and testing. The adapter signs EIP-1559 transactions itself and broadcasts them with `eth_sendRawTransaction`, so any RPC for the target chain works and the node never sees the key.

```ts
import { PrivateKeyAdapter } from "@opensea/wallet-adapters"

const wallet = PrivateKeyAdapter.fromEnv()
// Requires: PRIVATE_KEY
// Optional: RPC_URL (needed to send transactions; nonce, gas and fees come from it)
//           WALLET_ADDRESS (skips address derivation; not checked against the key)
```

## Framework bridges

### viem

```ts
import { walletAdapterToViemClient } from "@opensea/wallet-adapters/viem"
import { base } from "viem/chains"

const client = await walletAdapterToViemClient(wallet, base, "https://mainnet.base.org")
// Use as a standard viem WalletClient
```

### ethers.js

```ts
import { walletAdapterToEthersSigner } from "@opensea/wallet-adapters/ethers"

const signer = walletAdapterToEthersSigner(wallet, provider)
// Use as a standard ethers.js Signer
```

Both bridges throw `WrongChainTypeError` when given a Solana wallet.

`provider` can come from either ethers build, and `new OpenSeaSDK(signer, ...)` from `@opensea/sdk` accepts the signer in ESM and CommonJS projects. The bridge is typed against ethers' ESM declarations, which TypeScript treats as unrelated to the CommonJS ones. An API typed with the CommonJS declarations (`Contract` in a CommonJS project, or `@opensea/seaport-js` in any project) rejects the signer at compile time even though it works at runtime. Cast it to that API's parameter type:

```ts
import { Contract, type ContractRunner } from "ethers"

const token = new Contract(address, abi, signer as unknown as ContractRunner)
```

## Capabilities

Each adapter declares what it supports, so callers can check before calling an optional method:

```ts
if (wallet.capabilities.signMessage) {
  const sig = await wallet.signMessage?.({ message: "hello" })
}

if (wallet.capabilities.managedGas) {
  // No need to estimate gas: the provider handles it
}
```

| Capability | Privy | Fireblocks | Turnkey | Bankr | PrivateKey |
|------------|-------|------------|---------|-------|------------|
| `signMessage` | true | true | true | true | true |
| `signTypedData` | true | true | true | true | true |
| `managedGas` | true | true | false | true | false |
| `managedNonce` | true | true | false | true | false |

## Observability

Set `onRequest` and `onResponse` to trace adapter calls:

```ts
wallet.onRequest = (method, params) => {
  console.log(`→ ${method}`, params)
}
wallet.onResponse = (method, result, durationMs) => {
  console.log(`← ${method} (${durationMs}ms)`, result)
}
```

## Adding a provider

Implement `EvmWalletAdapter` (or `SvmWalletAdapter` for Solana):

```ts
import type {
  EvmTransactionRequest,
  EvmWalletAdapter,
  SignMessageRequest,
  SignTypedDataRequest,
  TransactionResult,
  WalletCapabilities,
} from "@opensea/wallet-adapters"

export class MyProviderAdapter implements EvmWalletAdapter {
  readonly name = "my-provider"
  readonly chainType = "evm" as const
  readonly capabilities: WalletCapabilities = {
    signMessage: true,
    signTypedData: true,
    managedGas: true,
    managedNonce: true,
  }

  async getAddress(): Promise<string> { /* ... */ }
  async sendTransaction(tx: EvmTransactionRequest): Promise<TransactionResult> { /* ... */ }
  async signMessage(request: SignMessageRequest): Promise<string> { /* ... */ }
  async signTypedData(request: SignTypedDataRequest): Promise<string> { /* ... */ }

  static fromEnv(): MyProviderAdapter { /* ... */ }
}
```

Then register it in `createWalletFromEnv()` in `src/factory.ts` so the CLI and tool-sdk detect it from environment variables.

## Contributing

Read-only mirror of a private monorepo, updated on each release. Pull requests are welcome, and we bring accepted changes into the monorepo.

## Security

Found a vulnerability? Report it through OpenSea's Bugcrowd program at https://bugcrowd.com/engagements/opensea rather than opening a public issue. See [SECURITY.md](SECURITY.md).

## License

MIT
