import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    viem: "src/bridges/viem.ts",
    ethers: "src/bridges/ethers.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  external: ["viem", "ethers"],
})
