/**
 * Auto-detection factory that creates a WalletAdapter based on
 * which environment variables are present.
 *
 * Priority: Privy > Fireblocks > Turnkey > Bankr > PrivateKey
 *
 * Selection is per chain family. A Privy wallet is bound to one `chain_type`, so an EVM wallet and
 * a Solana wallet are two wallets with two ids, and both can be configured at once. Pass
 * `{ chainType: "svm" }` to ask for the Solana one; the default stays EVM so existing callers are
 * unaffected.
 */

import { BankrAdapter } from "./adapters/bankr.js"
import { FireblocksAdapter } from "./adapters/fireblocks.js"
import { PrivateKeyAdapter } from "./adapters/private-key.js"
import { PrivyAdapter } from "./adapters/privy.js"
import { PrivySvmAdapter } from "./adapters/privy-svm.js"
import { TurnkeyAdapter } from "./adapters/turnkey.js"
import type {
  ChainType,
  EvmWalletAdapter,
  SvmWalletAdapter,
  WalletAdapter,
  WalletProvider,
} from "./types/index.js"

/** Which chain family to select a wallet for. Omitted means `"evm"`. */
export interface WalletSelector {
  chainType?: ChainType
}

const EVM_PROVIDER_HELP =
  "  • Privy: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID\n" +
  "  • Fireblocks: FIREBLOCKS_API_KEY, FIREBLOCKS_API_SECRET, FIREBLOCKS_VAULT_ID\n" +
  "  • Turnkey: TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID, TURNKEY_WALLET_ADDRESS, TURNKEY_RPC_URL\n" +
  "  • Bankr: BANKR_API_KEY\n" +
  "  • PrivateKey: PRIVATE_KEY (optionally RPC_URL for sending transactions)"

const SVM_PROVIDER_HELP =
  "  • Privy: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_SVM_WALLET_ID"

function detectEvmProvider(): WalletProvider | null {
  if (process.env.PRIVY_APP_ID && process.env.PRIVY_WALLET_ID) return "privy"
  if (process.env.FIREBLOCKS_API_KEY && process.env.FIREBLOCKS_VAULT_ID)
    return "fireblocks"
  if (process.env.TURNKEY_API_PUBLIC_KEY && process.env.TURNKEY_WALLET_ADDRESS)
    return "turnkey"
  if (process.env.BANKR_API_KEY) return "bankr"
  if (process.env.PRIVATE_KEY) return "private-key"
  return null
}

function detectSvmProvider(): WalletProvider | null {
  // Privy is the only provider with an SVM adapter today.
  if (process.env.PRIVY_APP_ID && process.env.PRIVY_SVM_WALLET_ID)
    return "privy"
  return null
}

export function detectProvider(
  selector: WalletSelector = {},
): WalletProvider | null {
  return selector.chainType === "svm"
    ? detectSvmProvider()
    : detectEvmProvider()
}

function createEvmWalletFromEnv(): EvmWalletAdapter {
  switch (detectEvmProvider()) {
    case "privy":
      return PrivyAdapter.fromEnv()
    case "fireblocks":
      return FireblocksAdapter.fromEnv()
    case "turnkey":
      return TurnkeyAdapter.fromEnv()
    case "bankr":
      return BankrAdapter.fromEnv()
    case "private-key":
      return PrivateKeyAdapter.fromEnv()
    default:
      break
  }

  // Say so when the only wallet configured is for the other chain, rather than listing EVM
  // variables at someone who has already set the Solana ones.
  const svmHint = detectSvmProvider()
    ? "\n\nA Solana wallet is configured. Ask for it with " +
      'createWalletFromEnv({ chainType: "svm" }).'
    : ""

  throw new Error(
    `No EVM wallet provider configured. Set environment variables for one of:\n${EVM_PROVIDER_HELP}${svmHint}`,
  )
}

function createSvmWalletFromEnv(): SvmWalletAdapter {
  if (detectSvmProvider() === "privy") return PrivySvmAdapter.fromEnv()

  const evmHint = detectEvmProvider()
    ? "\n\nAn EVM wallet is configured. A Privy wallet is bound to one chain, so a Solana " +
      "wallet is a separate wallet: create one and set PRIVY_SVM_WALLET_ID to its id."
    : ""

  throw new Error(
    `No Solana wallet provider configured. Set environment variables for one of:\n${SVM_PROVIDER_HELP}${evmHint}`,
  )
}

export function createWalletFromEnv(
  selector: WalletSelector = {},
): WalletAdapter {
  return selector.chainType === "svm"
    ? createSvmWalletFromEnv()
    : createEvmWalletFromEnv()
}

export function createWalletForProvider(
  provider: WalletProvider,
  selector: WalletSelector = {},
): WalletAdapter {
  if (selector.chainType === "svm") {
    if (provider !== "privy") {
      throw new Error(
        `Wallet provider "${provider}" has no Solana adapter; only privy does`,
      )
    }
    return PrivySvmAdapter.fromEnv()
  }

  switch (provider) {
    case "bankr":
      return BankrAdapter.fromEnv()
    case "privy":
      return PrivyAdapter.fromEnv()
    case "fireblocks":
      return FireblocksAdapter.fromEnv()
    case "turnkey":
      return TurnkeyAdapter.fromEnv()
    case "private-key":
      return PrivateKeyAdapter.fromEnv()
    default:
      throw new Error(`Unknown wallet provider: ${provider}`)
  }
}
