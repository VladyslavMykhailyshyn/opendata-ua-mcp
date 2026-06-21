/*
 * Build a .dxt package: a ZIP with manifest.json at the root + the bundled
 * dist/. Drag-and-drop installable in Claude Desktop. Self-contained (adm-zip),
 * no external CLI needed.
 *
 * Prereq: `npm run build` (produces dist/). Run: `npm run build:dxt`.
 */
import AdmZip from "adm-zip";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "opendata-ua-mcp.dxt");

if (!existsSync(resolve(root, "dist/stdio.js"))) {
  console.error("dist/ missing — run `npm run build` first.");
  process.exit(1);
}

const zip = new AdmZip();
zip.addLocalFile(resolve(root, "dxt/manifest.json")); // must be at root
zip.addLocalFile(resolve(root, "README.md"));
zip.addLocalFile(resolve(root, "LICENSE"));
zip.addLocalFolder(resolve(root, "dist"), "dist");

rmSync(out, { force: true });
zip.writeZip(out);
console.log(`Built ${out}`);
