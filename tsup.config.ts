import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    stdio: "src/stdio.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  // Bundle everything so the DXT package needs no node_modules at the user's machine.
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node" },
});
