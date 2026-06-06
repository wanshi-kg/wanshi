/*
 * Copy non-TypeScript runtime assets (Handlebars templates + Markdown domain
 * examples) from src/ into dist/, preserving structure. `tsc` only emits .js, so
 * without this step `node dist/index.js` fails to load prompt templates
 * (ENOENT on dist/core/llm/prompts/templates/.../*.hbs).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");
const ASSET_EXTS = new Set([".hbs", ".md"]);

function walk(dir) {
  let copied = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      copied += walk(full);
    } else if (ASSET_EXTS.has(path.extname(entry.name))) {
      const dest = path.join(DIST, path.relative(SRC, full));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
      copied += 1;
    }
  }
  return copied;
}

if (!fs.existsSync(DIST)) {
  console.error("copy-assets: dist/ not found — run `tsc` first");
  process.exit(1);
}
const n = walk(SRC);
console.log(`copy-assets: copied ${n} asset file(s) into dist/`);
