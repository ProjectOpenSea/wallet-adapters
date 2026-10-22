import { BankrAdapter } from "../../adapters/bankr.js"
import { FireblocksAdapter } from "../../adapters/fireblocks.js"
import { PrivateKeyAdapter } from "../../adapters/private-key.js"
import { PrivyAdapter } from "../../adapters/privy.js"
import { PrivySvmAdapter } from "../../adapters/privy-svm.js"
import { TurnkeyAdapter } from "../../adapters/turnkey.js"
import type {
  EvmTransactionRequest,
  EvmWalletAdapter,
  SvmTransactionRequest,
  SvmWalletAdapter,
  TransactionResult,
} from "../../types/index.js"

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

export type AdapterFactory =
  | {
      name: string
      chainType: "evm"
      create: () => EvmWalletAdapter
      request: EvmTransactionRequest
    }
  | {
      name: string
      chainType: "svm"
      create: () => SvmWalletAdapter
      request: SvmTransactionRequest
    }

const EVM_REQUEST: EvmTransactionRequest = {
  to: "0x0000000000000000000000000000000000000000",
  data: "0x",
  value: "0",
  chainId: 1,
}
const SVM_REQUEST: SvmTransactionRequest = { transaction: "AQID" }

export const ALL_ADAPTERS: AdapterFactory[] = [
  {
    name: "bankr",
    chainType: "evm",
    create: () => new BankrAdapter({ apiKey: "test-api-key" }),
    request: EVM_REQUEST,
  },
  {
    name: "fireblocks",
    chainType: "evm",
    create: () =>
      new FireblocksAdapter({
        apiKey: "test-api-key",
        apiSecret:
          "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
        vaultId: "0",
      }),
    request: EVM_REQUEST,
  },
  {
    name: "private-key",
    chainType: "evm",
    create: () =>
      new PrivateKeyAdapter({
        privateKey: TEST_PRIVATE_KEY,
        rpcUrl: "https://rpc.example.com",
      }),
    request: EVM_REQUEST,
  },
  {
    name: "privy-svm",
    chainType: "svm",
    create: () =>
      new PrivySvmAdapter({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        walletId: "test-wallet-id",
      }),
    request: SVM_REQUEST,
  },
  {
    name: "privy",
    chainType: "evm",
    create: () =>
      new PrivyAdapter({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        walletId: "test-wallet-id",
      }),
    request: EVM_REQUEST,
  },
  {
    name: "turnkey",
    chainType: "evm",
    create: () =>
      new TurnkeyAdapter({
        apiPublicKey: "test-public-key",
        apiPrivateKey: "test-private-key",
        organizationId: "test-org-id",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        rpcUrl: "https://rpc.example.com",
      }),
    request: EVM_REQUEST,
  },
]

/**
 * Request fields both chain families accept, so a contract test can vary one without knowing
 * which family the adapter belongs to.
 */
export interface SharedRequestOverrides {
  idempotencyKey?: string
}

/**
 * Sends the matrix entry's request through its adapter, with `overrides` merged in.
 *
 * The chain split lives here rather than at the call site. `EvmTransactionRequest` and
 * `SvmTransactionRequest` have no common supertype and `sendTransaction` is required on
 * `EvmWalletAdapter` but optional on `SvmWalletAdapter`, so a `describe.each(ALL_ADAPTERS)` block
 * that branched itself would re-derive both facts for every new contract behaviour. Keeping it in
 * one place is what makes rule 2 in AGENTS.md a single line to follow.
 */
export function sendTransaction(
  factory: AdapterFactory,
  overrides: SharedRequestOverrides = {},
): Promise<TransactionResult> {
  if (factory.chainType === "evm") {
    return factory
      .create()
      .sendTransaction({ ...factory.request, ...overrides })
  }
  const adapter = factory.create()
  if (!adapter.sendTransaction) {
    throw new Error(
      `${factory.name} declares no sendTransaction, so it cannot carry transaction-level contract behaviour`,
    )
  }
  return adapter.sendTransaction({ ...factory.request, ...overrides })
}
