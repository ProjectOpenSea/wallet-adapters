import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    viem: "src/bridges/viem.ts",
    ethers: "src/bridges/ethers.ts",
  },
  format: ["esm"],
  dts: { sourcemap: true },
  clean: true,
  sourcemap: true,
  target: "node18",
  fixedExtension: false,
  deps: { neverBundle: ["viem", "ethers"] },
})
