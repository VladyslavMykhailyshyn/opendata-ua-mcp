import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist/**", "node_modules/**", "*.dxt", ".dxt-staging/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2023,
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // TypeScript already verifies identifiers/globals; no-undef double-flags
      // Node/Web globals (process, fetch, Buffer, …) under flat config.
      "no-undef": "off",
      "no-console": "off",
    },
  },
  { ignores: ["dist/**", "node_modules/**"] },
];
