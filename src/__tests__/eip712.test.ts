import { describe, expect, it } from "vitest"
import { hashTypedData } from "../util/eip712.js"

const domain = { name: "USD Coin", version: "2", chainId: 8453 }

describe("hashTypedData uint encoding", () => {
  it("rejects a negative value for an unsigned uint type", () => {
    expect(() =>
      hashTypedData(
        domain,
        "TransferWithAuthorization",
        { value: -1000n },
        { TransferWithAuthorization: [{ name: "value", type: "uint256" }] },
      ),
    ).toThrow("cannot encode negative value -1000 as uint256")
  })

  it("encodes a non-negative uint value", () => {
    const hash = hashTypedData(
      domain,
      "TransferWithAuthorization",
      { value: 1000n },
      { TransferWithAuthorization: [{ name: "value", type: "uint256" }] },
    )
    expect(hash).toBeInstanceOf(Uint8Array)
    expect(hash.length).toBe(32)
  })

  it("still two's-complement wraps a negative value for a signed int type", () => {
    const hash = hashTypedData(
      domain,
      "Signed",
      { value: -1n },
      { Signed: [{ name: "value", type: "int256" }] },
    )
    expect(hash).toBeInstanceOf(Uint8Array)
    expect(hash.length).toBe(32)
  })

  it("rejects a uint value that exceeds the type's width", () => {
    expect(() =>
      hashTypedData(
        domain,
        "Wide",
        { value: 1n << 256n },
        { Wide: [{ name: "value", type: "uint256" }] },
      ),
    ).toThrow("out of range for uint256")

    expect(() =>
      hashTypedData(
        domain,
        "Small",
        { value: 256n },
        { Small: [{ name: "value", type: "uint8" }] },
      ),
    ).toThrow("out of range for uint8")
  })

  it("rejects a signed int value outside its width range", () => {
    expect(() =>
      hashTypedData(
        domain,
        "Small",
        { value: 128n },
        { Small: [{ name: "value", type: "int8" }] },
      ),
    ).toThrow("out of range for int8")

    expect(() =>
      hashTypedData(
        domain,
        "Small",
        { value: -129n },
        { Small: [{ name: "value", type: "int8" }] },
      ),
    ).toThrow("out of range for int8")
  })

  it("accepts boundary values at the edge of the type's range", () => {
    expect(() =>
      hashTypedData(
        domain,
        "Edge",
        { max: 255n, sMax: 127n, sMin: -128n },
        {
          Edge: [
            { name: "max", type: "uint8" },
            { name: "sMax", type: "int8" },
            { name: "sMin", type: "int8" },
          ],
        },
      ),
    ).not.toThrow()
  })
})

describe("hashTypedData address & bytes encoding", () => {
  const addrType = { Msg: [{ name: "who", type: "address" }] }

  it("encodes a valid 20-byte address (case-insensitively)", () => {
    const lower = hashTypedData(
      domain,
      "Msg",
      { who: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" },
      addrType,
    )
    const mixed = hashTypedData(
      domain,
      "Msg",
      { who: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" },
      addrType,
    )
    expect(lower).toEqual(mixed)
  })

  it("rejects an address with non-hex characters instead of silently encoding zeros", () => {
    expect(() =>
      hashTypedData(
        domain,
        "Msg",
        { who: "0xZZZZefabcdefabcdefabcdefabcdefabcdefabcd" },
        addrType,
      ),
    ).toThrow(/invalid address value/i)
  })

  it("rejects an address longer than 20 bytes", () => {
    expect(() =>
      hashTypedData(domain, "Msg", { who: `0x${"ab".repeat(21)}` }, addrType),
    ).toThrow(/invalid address value/i)
  })

  it("rejects a bytes value with an odd-length hex string", () => {
    expect(() =>
      hashTypedData(
        domain,
        "Msg",
        { data: "0xabc" },
        { Msg: [{ name: "data", type: "bytes" }] },
      ),
    ).toThrow(/odd length/i)
  })

  it("rejects a bytesN value with non-hex characters", () => {
    expect(() =>
      hashTypedData(
        domain,
        "Msg",
        { data: "0xzz" },
        { Msg: [{ name: "data", type: "bytes4" }] },
      ),
    ).toThrow(/non-hex characters/i)
  })

  it("rejects a bytesN value wider than 32 bytes", () => {
    expect(() =>
      hashTypedData(
        domain,
        "Msg",
        { data: `0x${"ab".repeat(33)}` },
        { Msg: [{ name: "data", type: "bytes32" }] },
      ),
    ).toThrow(/exceeds 32 bytes/i)
  })
})
