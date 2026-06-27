#!/usr/bin/env ts-node
/**
 * Vendor a well-known library's source and build the AST code-gold sidecar.
 *
 *   data/code/<lib>/src/**.py        ← vendored source (pinned tag)
 *   data/code/<lib>/gold.jsonl       ← { file, symbols, triples } per file (outlion AST)
 *   data/code/<lib>/relations.vocab  ← calls, depends_on   (H4 closed schema)
 *   data/code/<lib>/PROVENANCE.md     ← repo + tag + license
 *
 * Gold = the deterministic call/import graph (extractCodeGold, mirrors AstSeedService).
 * Scored against the PURE-LLM extraction (gold-compare bypasses the AST seed), so deriving
 * gold from the same parser is not circular. Idempotent: skips the vendor step when the
 * source is already present; always rebuilds the gold.
 *
 *   npx ts-node scripts/build-code-gold.ts            # default: flask 3.0.3
 *   npx ts-node scripts/build-code-gold.ts --lib flask --tag 3.0.3
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { extractCodeGold } from '../src/evaluation/datasets/astGold';

interface LibSpec { repo: string; tag: string; srcSubdir: string; ext: string; license: string }
const LIBS: Record<string, LibSpec> = {
  // pure-Python, famous, rich internal call/import structure; BSD-3-Clause (vendorable)
  flask: { repo: 'pallets/flask', tag: '3.0.3', srcSubdir: 'src/flask', ext: 'py', license: 'BSD-3-Clause' },
  requests: { repo: 'psf/requests', tag: 'v2.32.3', srcSubdir: 'src/requests', ext: 'py', license: 'Apache-2.0' },
  click: { repo: 'pallets/click', tag: '8.1.7', srcSubdir: 'src/click', ext: 'py', license: 'BSD-3-Clause' },
};

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (e.name.endsWith(`.${ext}`)) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  const lib = arg('lib', 'flask');
  const spec = LIBS[lib];
  if (!spec) { console.error(`Unknown lib: ${lib}. Known: ${Object.keys(LIBS).join(', ')}`); process.exit(1); }
  const tag = arg('tag', spec.tag);

  const root = path.resolve(__dirname, '..', 'data', 'code', lib);
  const srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // ── Vendor (idempotent) ──
  if (walk(srcDir, spec.ext).length === 0) {
    const url = `https://github.com/${spec.repo}/archive/refs/tags/${tag}.tar.gz`;
    console.log(`Vendoring ${spec.repo}@${tag} …\n  ${url}`);
    const tgz = path.join(root, 'src.tar.gz');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    const tmp = path.join(root, '_extract');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    execSync(`tar -xzf "${tgz}" -C "${tmp}"`);
    const top = fs.readdirSync(tmp)[0]; // <repo>-<tag>/
    const from = path.join(tmp, top, spec.srcSubdir);
    if (!fs.existsSync(from)) throw new Error(`srcSubdir not found after extract: ${from}`);
    for (const file of walk(from, spec.ext)) {
      const rel = path.relative(from, file);
      const dest = path.join(srcDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tgz, { force: true });
    fs.writeFileSync(
      path.join(root, 'PROVENANCE.md'),
      `# ${lib} code corpus\n\n- Source: https://github.com/${spec.repo} @ \`${tag}\`\n- Subtree: \`${spec.srcSubdir}\`\n- License: ${spec.license}\n- Vendored read-only as an AST relation-extraction gold corpus (calls/imports).\n`,
    );
    console.log(`  vendored ${walk(srcDir, spec.ext).length} .${spec.ext} files → ${srcDir}`);
  } else {
    console.log(`Source already vendored at ${srcDir} — skipping download.`);
  }

  // ── Build gold ──
  const files = walk(srcDir, spec.ext).sort();
  const goldPath = path.join(root, 'gold.jsonl');
  const lines: string[] = [];
  let totalSym = 0, totalTri = 0, withTri = 0;
  for (const file of files) {
    const rel = path.relative(srcDir, file).split(path.sep).join('/');
    const content = fs.readFileSync(file, 'utf-8');
    const { symbols, triples } = await extractCodeGold(content, spec.ext, rel);
    if (triples.length === 0 && symbols.length === 0) continue; // empty/init files
    lines.push(JSON.stringify({ file: rel, symbols, triples }));
    totalSym += symbols.length; totalTri += triples.length;
    if (triples.length) withTri++;
  }
  fs.writeFileSync(goldPath, lines.join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'relations.vocab'), 'calls\ndepends_on\n');

  console.log(`\ngold.jsonl: ${lines.length} files, ${totalSym} symbols, ${totalTri} triples (${withTri} files with ≥1 edge)`);
  console.log(`  → ${goldPath}`);
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
