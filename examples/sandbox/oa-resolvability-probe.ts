/**
 * OA-resolvability probe — the Phase-0 forcing output that GATES Phase 2
 * (citation span-fetch + faithfulness). Per
 * docs/inbox/2026-06-14-dove-to-cheetah-reference-resolution-roadmap.md.
 *
 * Over the citations a corpus actually contains, it reports:
 *   (a) OFFLINE  — % of citations carrying a hard id (DOI / arXiv-id / PMID).
 *   (b) LIVE     — of a sample, % that resolve to OPEN-ACCESS full text
 *                  (arXiv API · Unpaywall · PMC id-converter).  [--live]
 *
 * That second number is the go/no-go: if a corpus cites mostly id-less or
 * paywalled sources, the span-fetch apex has low yield and we DON'T build it —
 * learned for the cost of the cheapest phase. Standalone + network-isolated:
 * NOT wired into the pipeline, so core extraction stays offline-first.
 *
 * Run:
 *   npx ts-node examples/sandbox/oa-resolvability-probe.ts <corpus-dir>
 *   npx ts-node examples/sandbox/oa-resolvability-probe.ts <corpus-dir> --live --sample 30
 *   UNPAYWALL_EMAIL=you@example.org npx ts-node ... --live   # DOI checks need an email
 */
import * as fs from "fs";
import * as path from "path";
import {
  extractCitations,
  RawCitation,
} from "../../src/core/processor/readers/referenceExtraction";
import { splitTrailingReferences } from "../../src/core/processor/readers/stripReferences";

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const corpusDir = argv.find((a) => !a.startsWith("--"));
const LIVE = argv.includes("--live");
const SAMPLE = Number(argv[argv.indexOf("--sample") + 1]) || 25;
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".tex", ".rst"]);
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL;

if (!corpusDir || !fs.existsSync(corpusDir)) {
  console.error("usage: oa-resolvability-probe <corpus-dir> [--live] [--sample N]");
  process.exit(1);
}

// ── collect citations from text files (PDFs are skipped in this quick probe) ────
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      out.push(...walk(full));
    } else if (TEXT_EXT.has(path.extname(ent.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function collect(): RawCitation[] {
  const files = walk(corpusDir!);
  const byKey = new Map<string, RawCitation>();
  let scanned = 0;
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    scanned++;
    const { references } = splitTrailingReferences(text);
    for (const c of extractCitations(references, text)) {
      const key =
        c.arxivId?.toLowerCase() ??
        c.doi?.toLowerCase() ??
        (c.pmid ? `pmid:${c.pmid}` : undefined) ??
        c.title?.toLowerCase() ??
        c.raw.toLowerCase();
      if (key && !byKey.has(key)) byKey.set(key, c);
    }
  }
  console.log(`Scanned ${scanned} text file(s) under ${corpusDir}`);
  return Array.from(byKey.values());
}

// ── live OA resolution ─────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function arxivOA(id: string): Promise<boolean> {
  try {
    const r = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
    if (!r.ok) return false;
    const xml = await r.text();
    return /<entry>/.test(xml) && !/<title>Error<\/title>/.test(xml); // arXiv full text is always OA
  } catch {
    return false;
  }
}

async function doiOA(doi: string): Promise<boolean | null> {
  if (!UNPAYWALL_EMAIL) return null; // can't check without a polite email
  try {
    const r = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`
    );
    if (!r.ok) return false;
    const j = (await r.json()) as { is_oa?: boolean };
    return !!j.is_oa;
  } catch {
    return false;
  }
}

async function pmidOA(pmid: string): Promise<boolean> {
  try {
    const r = await fetch(
      `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${encodeURIComponent(pmid)}&format=json`
    );
    if (!r.ok) return false;
    const j = (await r.json()) as { records?: Array<{ pmcid?: string }> };
    return !!j.records?.[0]?.pmcid; // a PMCID ⇒ open in PMC
  } catch {
    return false;
  }
}

async function resolvesOA(c: RawCitation): Promise<boolean | null> {
  if (c.arxivId) return arxivOA(c.arxivId);
  if (c.doi) return doiOA(c.doi);
  if (c.pmid) return pmidOA(c.pmid);
  return false; // no id ⇒ unresolvable to full text
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

// ── main ────────────────────────────────────────────────────────────────────────
(async () => {
  const cites = collect();
  const total = cites.length;
  const withArxiv = cites.filter((c) => c.arxivId).length;
  const withDoi = cites.filter((c) => !c.arxivId && c.doi).length;
  const withPmid = cites.filter((c) => !c.arxivId && !c.doi && c.pmid).length;
  const withId = cites.filter((c) => c.arxivId || c.doi || c.pmid).length;

  console.log("\n=== (a) OFFLINE id coverage ===");
  console.log(`citations (deduped):   ${total}`);
  console.log(`carrying a hard id:    ${withId}  (${pct(withId, total)})`);
  console.log(`  · arXiv-id:          ${withArxiv}`);
  console.log(`  · DOI:               ${withDoi}`);
  console.log(`  · PMID:              ${withPmid}`);

  if (!LIVE) {
    console.log("\n(skipping live OA check — pass --live to run it)");
    console.log(
      "\nGO/NO-GO: id coverage is the ceiling on Phase-2 yield. Run --live for the OA fraction."
    );
    return;
  }

  const pool = cites.filter((c) => c.arxivId || c.doi || c.pmid);
  const sample = pool.sort(() => Math.random() - 0.5).slice(0, SAMPLE);
  console.log(`\n=== (b) LIVE OA resolution (sample ${sample.length} of ${pool.length} id-bearing) ===`);
  if (!UNPAYWALL_EMAIL) {
    console.log("note: UNPAYWALL_EMAIL unset → DOI-only citations are reported as 'unknown'");
  }

  let oa = 0;
  let unknown = 0;
  for (const c of sample) {
    const r = await resolvesOA(c);
    if (r === null) unknown++;
    else if (r) oa++;
    await sleep(300); // be polite to the APIs
  }
  const checked = sample.length - unknown;
  console.log(`OA full text resolvable: ${oa}/${checked}  (${pct(oa, checked)})` + (unknown ? `   [${unknown} unknown]` : ""));

  const projected = total ? (withId / total) * (checked ? oa / checked : 0) : 0;
  console.log(`\nGO/NO-GO — projected corpus OA-fulltext yield ≈ ${(100 * projected).toFixed(1)}%`);
  console.log(
    projected >= 0.2
      ? "→ Worth a Phase-2 brief: enough citations resolve to OA full text to span-fetch."
      : "→ Low yield: Phase-2 span-fetch likely not worth building on this corpus."
  );
})();
