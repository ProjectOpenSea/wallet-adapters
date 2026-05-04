# @opensea/wallet-adapters

## 0.2.0

### Minor Changes

- a81071b: Add Bankr wallet adapter (`BankrAdapter`). Bankr is a managed agent wallet service that signs and submits transactions via its Wallet API using an API key (`BANKR_API_KEY`). Supports `getAddress`, `sendTransaction`, `signMessage`, and `signTypedData`. Auto-detected by `createWalletFromEnv()` with highest priority when `BANKR_API_KEY` is set.
