#!/usr/bin/env node
/**
 * Generates website/docs/reference/configuration.md from `wanshi schema`.
 *
 * The page is AUTO-GENERATED from the Zod ConfigSchema (the single source of
 * truth for config types/defaults/help), so the documented config surface can't
 * drift from the code. Run via `npm run gen:config` (wired to prebuild/prestart).
 *
 * Contract: it shells the literal `wanshi schema --json` command (CLI entry at
 * src/cli/index.ts via ts-node, or built dist/cli/index.js), exactly the
 * anti-drift interface the docs promise.
 */
import {execFileSync} from 'node:child_process';
import {writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..'); // website/scripts → repo root
const outPath = resolve(here, '..', 'docs', 'reference', 'configuration.md');

// Run the schema command. Prefer ts-node against src/ (always reflects current
// source — a built dist/ can be stale), fall back to a built dist/cli/index.js (CI,
// after `npm run build`). The repo runs ts-node globally, so try PATH too.
function runSchema() {
  const MAX = 64 * 1024 * 1024;
  const srcEntry = resolve(repoRoot, 'src', 'cli', 'index.ts');
  const env = {...process.env, TS_NODE_TRANSPILE_ONLY: '1'};
  if (existsSync(srcEntry)) {
    const localBin = resolve(repoRoot, 'node_modules', '.bin', 'ts-node');
    for (const bin of [localBin, 'ts-node']) {
      try {
        return execFileSync(bin, [srcEntry, 'schema', '--json'], {cwd: repoRoot, encoding: 'utf8', maxBuffer: MAX, env});
      } catch {
        // try the next resolution (local bin → global on PATH)
      }
    }
  }
  const distEntry = resolve(repoRoot, 'dist', 'cli', 'index.js');
  if (existsSync(distEntry)) {
    return execFileSync('node', [distEntry, 'schema', '--json'], {cwd: repoRoot, encoding: 'utf8', maxBuffer: MAX});
  }
  throw new Error(
    `could not run \`wanshi schema\` — need ts-node (for ${srcEntry}) or a built ${distEntry}. ` +
      `Run \`npm install\` and/or \`npm run build\` in ${repoRoot}.`,
  );
}

let payload;
try {
  payload = JSON.parse(runSchema());
} catch (err) {
  console.error('[gen:config] failed running `wanshi schema --json`:', err.message);
  process.exit(1);
}

const js = payload.jsonSchema || {};
const defs = js.definitions || {};
const rootName = String(js.$ref || '').replace('#/definitions/', '');
const root = defs[rootName];
if (!root || !root.properties) {
  console.error('[gen:config] unexpected schema shape (no root definition).');
  process.exit(1);
}

const deref = (node) => {
  let n = node;
  let guard = 0;
  while (n && n.$ref && guard++ < 20) n = defs[String(n.$ref).replace('#/definitions/', '')];
  return n || {};
};

const esc = (s) =>
  String(s ?? '')
    .replace(/\n+/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[') // neutralize markdown links/wikilinks in example text
    .trim();

const typeLabel = (node) => {
  const n = deref(node);
  if (Array.isArray(n.enum)) return n.enum.map((e) => '`' + e + '`').join(' · ');
  if (n.type === 'array') {
    const items = deref(n.items || {});
    if (Array.isArray(items.enum)) return items.enum.map((e) => '`' + e + '`').join(' · ') + '[]';
    return (items.type || 'any') + '[]';
  }
  if (Array.isArray(n.type)) return n.type.join(' \\| ');
  return n.type || 'object';
};

const fmtDefault = (node) => {
  const n = deref(node);
  if (n.default === undefined) return '—';
  if (n.default === '') return '`""`';
  if (typeof n.default === 'object') return '`' + JSON.stringify(n.default) + '`';
  return '`' + String(n.default) + '`';
};

const walk = (node, path, rows) => {
  const n = deref(node);
  if (n.type === 'object' && n.properties) {
    for (const [k, child] of Object.entries(n.properties)) {
      walk(child, path ? `${path}.${k}` : k, rows);
    }
  } else {
    rows.push({path, type: typeLabel(n), def: fmtDefault(n), desc: esc(n.description)});
  }
};

// Group leaf fields: top-level scalars → "Top-level"; each nested object → its own section.
const sections = [];
const generalRows = [];
for (const [key, child] of Object.entries(root.properties)) {
  const c = deref(child);
  if (c.type === 'object' && c.properties) {
    const rows = [];
    walk(c, key, rows);
    sections.push({title: key, description: esc(c.description), rows});
  } else {
    generalRows.push({path: key, type: typeLabel(c), def: fmtDefault(c), desc: esc(c.description)});
  }
}
if (generalRows.length) {
  sections.unshift({
    title: 'Top-level',
    description: 'Input/output and run-wide options (kept at the top level of a config file).',
    rows: generalRows,
  });
}

const lines = [
  '---',
  'id: configuration',
  'title: Configuration reference',
  'description: The complete wanshi config surface, generated from the Zod schema.',
  '---',
  '',
  '<!-- AUTO-GENERATED from `wanshi schema` — do not edit by hand. Run `npm run gen:config`. -->',
  '',
  ':::info Generated page',
  "This page is generated from the `ConfigSchema` (Zod) via `wanshi schema`, so it can't drift from the code. " +
    'Config **files** use this nested shape; CLI **flags** stay flat — see the [CLI reference](./cli.md). ' +
    'Defaults live only in the schema.',
  ':::',
  '',
];
for (const s of sections) {
  lines.push(`## ${s.title}`, '');
  if (s.description) lines.push(s.description, '');
  lines.push('| Key | Type / values | Default | Description |', '| --- | --- | --- | --- |');
  for (const r of s.rows) lines.push(`| \`${r.path}\` | ${r.type} | ${r.def} | ${r.desc} |`);
  lines.push('');
}

mkdirSync(dirname(outPath), {recursive: true});
writeFileSync(outPath, lines.join('\n') + '\n');
const fieldCount = sections.reduce((a, s) => a + s.rows.length, 0);
console.log(`[gen:config] wrote ${outPath} (${sections.length} sections, ${fieldCount} fields)`);
