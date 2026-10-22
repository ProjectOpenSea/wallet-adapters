import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { BlankIdempotencyKeyError } from "../../types/index.js"
import { ALL_ADAPTERS, sendTransaction } from "./adapters.js"

const adaptersDirectory = fileURLToPath(
  new URL("../../adapters/", import.meta.url),
)
const REQUIRED_CAPABILITIES = [
  "signMessage",
  "signTypedData",
  "managedGas",
  "managedNonce",
] as const

/**
 * Every `.ts` under `src/adapters/`, recursing into subdirectories so an adapter filed under one
 * is caught rather than skipped. Excludes barrels, type modules and tests, which declare no
 * adapter class of their own.
 */
function adapterSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return adapterSourceFiles(entryPath)
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      return []
    }
    if (
      entry.name === "index.ts" ||
      entry.name.endsWith(".test.ts") ||
      entry.name.startsWith("types")
    ) {
      return []
    }
    return [entryPath]
  })
}

function adapterImplementationClasses() {
  return adapterSourceFiles(adaptersDirectory).flatMap(file => {
    const source = fs.readFileSync(file, "utf8")
    return [...source.matchAll(/^export class (\w+Adapter)\b/gm)].map(
      match => match[1],
    )
  })
}

describe("adapter parity", () => {
  it("keeps the all-adapters test matrix in sync with implementations", () => {
    const implementationClasses = adapterImplementationClasses().sort()
    const registeredClasses = ALL_ADAPTERS.map(
      adapter => adapter.create().constructor.name,
    ).sort()
    expect(registeredClasses).toEqual(implementationClasses)
    expect(new Set(ALL_ADAPTERS.map(adapter => adapter.name)).size).toBe(
      ALL_ADAPTERS.length,
    )

    for (const adapterFactory of ALL_ADAPTERS) {
      const adapter = adapterFactory.create()
      expect(adapter.name).toBe(adapterFactory.name)
      for (const key of REQUIRED_CAPABILITIES) {
        expect(
          typeof adapter.capabilities[key],
          `${adapterFactory.name}.capabilities.${key}`,
        ).toBe("boolean")
      }
      expect(adapter.chainType).toBe(adapterFactory.chainType)
    }
  })

  // The worked example rule 2 points at: transaction-level contract behaviour over every adapter,
  // with no chain branching and no `@ts-expect-error` at the call site.
  it.each(
    ALL_ADAPTERS,
  )("$name rejects a blank idempotency key via the matrix request", async adapterFactory => {
    await expect(
      sendTransaction(adapterFactory, { idempotencyKey: "   " }),
    ).rejects.toThrow(BlankIdempotencyKeyError)
  })
})
