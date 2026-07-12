/**
 * EIP-712 typed data hashing utilities.
 *
 * Implements the EIP-712 encoding spec for computing domain separators
 * and struct hashes used by signTypedData across all adapters.
 */

import { keccak_256 } from "@noble/hashes/sha3.js"

export function hashTypedData(
  domain: Record<string, unknown>,
  primaryType: string,
  message: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  const domainSeparator = hashStruct("EIP712Domain", domain, {
    ...types,
    EIP712Domain: buildDomainType(domain),
  })
  const messageHash = hashStruct(primaryType, message, types)

  const packed = new Uint8Array(66)
  packed[0] = 0x19
  packed[1] = 0x01
  packed.set(domainSeparator, 2)
  packed.set(messageHash, 34)
  return keccak_256(packed)
}

export function hashPersonalMessage(message: string | Uint8Array): Uint8Array {
  const msgBytes =
    typeof message === "string" ? new TextEncoder().encode(message) : message

  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${msgBytes.length}`,
  )
  const payload = new Uint8Array(prefix.length + msgBytes.length)
  payload.set(prefix, 0)
  payload.set(msgBytes, prefix.length)
  return keccak_256(payload)
}

function buildDomainType(
  domain: Record<string, unknown>,
): Array<{ name: string; type: string }> {
  const fields: Array<{ name: string; type: string }> = []
  if ("name" in domain) fields.push({ name: "name", type: "string" })
  if ("version" in domain) fields.push({ name: "version", type: "string" })
  if ("chainId" in domain) fields.push({ name: "chainId", type: "uint256" })
  if ("verifyingContract" in domain)
    fields.push({ name: "verifyingContract", type: "address" })
  if ("salt" in domain) fields.push({ name: "salt", type: "bytes32" })
  return fields
}

function hashStruct(
  primaryType: string,
  data: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  const typeHash = hashType(primaryType, types)
  const encodedValues = encodeData(primaryType, data, types)
  const combined = new Uint8Array(32 + encodedValues.length)
  combined.set(typeHash, 0)
  combined.set(encodedValues, 32)
  return keccak_256(combined)
}

function hashType(
  primaryType: string,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  return keccak_256(new TextEncoder().encode(encodeType(primaryType, types)))
}

function encodeType(
  primaryType: string,
  types: Record<string, Array<{ name: string; type: string }>>,
): string {
  const fields = types[primaryType]
  if (!fields) throw new Error(`Unknown type: ${primaryType}`)

  const deps = new Set<string>()
  findTypeDeps(primaryType, types, deps)
  deps.delete(primaryType)
  const sorted = [...deps].sort()

  let result = `${primaryType}(${fields.map(f => `${f.type} ${f.name}`).join(",")})`
  for (const dep of sorted) {
    const depFields = types[dep]
    if (depFields) {
      result += `${dep}(${depFields.map(f => `${f.type} ${f.name}`).join(",")})`
    }
  }
  return result
}

function findTypeDeps(
  type: string,
  types: Record<string, Array<{ name: string; type: string }>>,
  deps: Set<string>,
): void {
  if (deps.has(type)) return
  const fields = types[type]
  if (!fields) return
  deps.add(type)
  for (const field of fields) {
    const baseType = field.type.replace(/\[\d*\]$/, "")
    if (types[baseType]) {
      findTypeDeps(baseType, types, deps)
    }
  }
}

function encodeData(
  primaryType: string,
  data: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  const fields = types[primaryType]
  if (!fields) throw new Error(`Unknown type: ${primaryType}`)

  const chunks: Uint8Array[] = []
  for (const field of fields) {
    const value = data[field.name]
    chunks.push(encodeValue(field.type, value, types))
  }

  const result = new Uint8Array(chunks.length * 32)
  for (let i = 0; i < chunks.length; i++) {
    result.set(chunks[i], i * 32)
  }
  return result
}

function encodeValue(
  type: string,
  value: unknown,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  if (type === "string") {
    return keccak_256(new TextEncoder().encode(value as string))
  }
  if (type === "bytes") {
    const v = value as string
    const bytes = hexToBytes(v.startsWith("0x") ? v.slice(2) : v)
    return keccak_256(bytes)
  }
  if (type.endsWith("]")) {
    const baseType = type.replace(/\[\d*\]$/, "")
    const arr = value as unknown[]
    const encoded = arr.map(item => encodeValue(baseType, item, types))
    const flat = new Uint8Array(encoded.length * 32)
    for (let i = 0; i < encoded.length; i++) flat.set(encoded[i], i * 32)
    return keccak_256(flat)
  }
  if (types[type]) {
    return hashStruct(type, value as Record<string, unknown>, types)
  }
  if (type === "address") {
    const raw = value as string
    const hex =
      raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw
    if (!/^[0-9a-fA-F]{1,40}$/.test(hex)) {
      throw new Error(`EIP-712: invalid address value ${raw}`)
    }
    const padded = new Uint8Array(32)
    padded.set(hexToBytes(hex.toLowerCase().padStart(40, "0")), 12)
    return padded
  }
  if (type === "bool") {
    const padded = new Uint8Array(32)
    padded[31] = value ? 1 : 0
    return padded
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    const signed = type.startsWith("int")
    const widthStr = type.slice(signed ? 3 : 4)
    const bits = widthStr === "" ? 256 : Number(widthStr)
    if (!Number.isInteger(bits) || bits < 8 || bits > 256 || bits % 8 !== 0) {
      throw new Error(`EIP-712: unsupported integer type ${type}`)
    }
    const n = BigInt(value as string | number | bigint)
    // Reject values outside the type's domain instead of silently wrapping.
    // A negative value for an unsigned type, or any value beyond the declared
    // width, would otherwise be misencoded — e.g. a negative token amount would
    // wrap into a near-max positive transfer via two's complement.
    if (signed) {
      const max = (1n << BigInt(bits - 1)) - 1n
      const min = -(1n << BigInt(bits - 1))
      if (n < min || n > max) {
        throw new Error(`EIP-712: value ${n} is out of range for ${type}`)
      }
    } else if (n < 0n) {
      throw new Error(`EIP-712: cannot encode negative value ${n} as ${type}`)
    } else if (n > (1n << BigInt(bits)) - 1n) {
      throw new Error(`EIP-712: value ${n} is out of range for ${type}`)
    }
    // EIP-712 encodes integers sign-extended to 256 bits, big-endian; for a
    // negative signed value that is the two's-complement representation.
    const padded = new Uint8Array(32)
    const hex = (n < 0n ? n + (1n << 256n) : n).toString(16).padStart(64, "0")
    padded.set(hexToBytes(hex), 0)
    return padded
  }
  if (type.startsWith("bytes")) {
    const v = value as string
    const bytes = hexToBytes(v.startsWith("0x") ? v.slice(2) : v)
    if (bytes.length > 32) {
      throw new Error(`EIP-712: ${type} value exceeds 32 bytes`)
    }
    const padded = new Uint8Array(32)
    padded.set(bytes, 0)
    return padded
  }
  throw new Error(`Unsupported EIP-712 type: ${type}`)
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  // Reject malformed hex instead of silently truncating an odd-length string
  // or storing NaN (which coerces to 0) for non-hex characters.
  if (clean.length % 2 !== 0) {
    throw new Error("EIP-712: hex string has an odd length")
  }
  if (clean.length > 0 && !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error("EIP-712: hex string contains non-hex characters")
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
