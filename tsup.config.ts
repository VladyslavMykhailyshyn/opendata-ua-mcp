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
  // Some bundled deps are CommonJS and use require()/__dirname/__filename.
  // Provide real ESM equivalents so esbuild's dynamic-require shim resolves
  // (otherwise adm-zip's require("fs") throws at runtime).
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'module';",
      "import { fileURLToPath as __fileURLToPath } from 'url';",
      "import { dirname as __pathDirname } from 'path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
});
