#!/usr/bin/env node
// Pool node-capture (semantic) tp/fp/fn across one-or-more gold-compare reports and
// print wanshi-vs-kggen node P/R/F1 + the delta. Pooling 3 code-lib reports → one N≈50 row.
//   node temp/node-table.js <label> <report.json> [<report.json> ...]
const fs = require('fs');
const [, , label, ...files] = process.argv;
const acc = { wanshi: { tp: 0, fp: 0, fn: 0 }, kggen: { tp: 0, fp: 0, fn: 0 } };
let n = 0, present = 0;
for (const f of files) {
  if (!fs.existsSync(f)) { console.error(`  (missing: ${f})`); continue; }
  present++;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  n += r.scoredCount || 0;
  for (const tool of ['wanshi', 'kggen']) {
    const s = r.tools?.[tool]?.nodeEntityCapture?.semantic;
    if (!s) continue;
    acc[tool].tp += s.tp; acc[tool].fp += s.fp; acc[tool].fn += s.fn;
  }
}
const m = (t) => {
  const p = t.tp + t.fp ? t.tp / (t.tp + t.fp) : 0;
  const r = t.tp + t.fn ? t.tp / (t.tp + t.fn) : 0;
  const f = p + r ? 2 * p * r / (p + r) : 0;
  return { p, r, f };
};
const w = m(acc.wanshi), k = m(acc.kggen);
const f3 = (x) => x.toFixed(3);
const delta = ((w.f - k.f) * 100).toFixed(1);
console.log(
  `${label.padEnd(16)} N=${String(n).padEnd(4)} files=${present}/${files.length} | ` +
  `wanshi P${f3(w.p)} R${f3(w.r)} F${f3(w.f)} | kggen P${f3(k.p)} R${f3(k.r)} F${f3(k.f)} | ` +
  `Δnode ${delta >= 0 ? '+' : ''}${delta}pt`
);
