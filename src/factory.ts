/**
 * Auto-detection factory that creates a WalletAdapter based on
 * which environment variables are present.
 *
 * Priority: Privy > Fireblocks > Turnkey > Bankr > PrivateKey
 */

import { BankrAdapter } from "./adapters/bankr.js"
import { FireblocksAdapter } from "./adapters/fireblocks.js"
import { PrivateKeyAdapter } from "./adapters/private-key.js"
import { PrivyAdapter } from "./adapters/privy.js"
import { TurnkeyAdapter } from "./adapters/turnkey.js"
import type { WalletAdapter, WalletProvider } from "./types/index.js"

export function createWalletFromEnv(): WalletAdapter {
  if (process.env.PRIVY_APP_ID && process.env.PRIVY_WALLET_ID) {
    return PrivyAdapter.fromEnv()
  }

  if (process.env.FIREBLOCKS_API_KEY && process.env.FIREBLOCKS_VAULT_ID) {
    return FireblocksAdapter.fromEnv()
  }

  if (
    process.env.TURNKEY_API_PUBLIC_KEY &&
    process.env.TURNKEY_WALLET_ADDRESS
  ) {
    return TurnkeyAdapter.fromEnv()
  }

  if (process.env.BANKR_API_KEY) {
    return BankrAdapter.fromEnv()
  }

  if (process.env.PRIVATE_KEY) {
    return PrivateKeyAdapter.fromEnv()
  }

  throw new Error(
    "No wallet provider configured. Set environment variables for one of:\n" +
      "  • Privy: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID\n" +
      "  • Fireblocks: FIREBLOCKS_API_KEY, FIREBLOCKS_API_SECRET, FIREBLOCKS_VAULT_ID\n" +
      "  • Turnkey: TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID, TURNKEY_WALLET_ADDRESS, TURNKEY_RPC_URL\n" +
      "  • Bankr: BANKR_API_KEY\n" +
      "  • PrivateKey: PRIVATE_KEY (optionally RPC_URL for sending transactions)",
  )
}

export function createWalletForProvider(
  provider: WalletProvider,
): WalletAdapter {
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

export function detectProvider(): WalletProvider | null {
  if (process.env.PRIVY_APP_ID && process.env.PRIVY_WALLET_ID) return "privy"
  if (process.env.FIREBLOCKS_API_KEY && process.env.FIREBLOCKS_VAULT_ID)
    return "fireblocks"
  if (process.env.TURNKEY_API_PUBLIC_KEY && process.env.TURNKEY_WALLET_ADDRESS)
    return "turnkey"
  if (process.env.BANKR_API_KEY) return "bankr"
  if (process.env.PRIVATE_KEY) return "private-key"
  return null
}
