import * as fs from "fs";

interface MergeRecord {
  cluster_id: string;
  target: "entity" | "relation";
  surface_forms: string[];
  canonical_chosen: string;
  member_count: number;
  method: string;
  intra_cluster_sim: { min: number; max: number };
  borderline_pairs: Array<{ a: string; b: string; sim: number; merged: boolean }>;
  source_spans: string[];
}

export interface InspectMergesOptions {
  target?: "entity" | "relation";
  /** Flag clusters whose minimum intra-cluster similarity is below this as likely over-merges. */
  suspectBelow?: string;
  /** Limit the number of rows printed. */
  limit?: string;
}

/**
 * `kg-gen inspect-merges <merges.jsonl>` — a CLI table over the canonicalization
 * merge log (canon brief §7). The merge log, not the graph, is the deliverable:
 * over/under-merge are silent in aggregate counts, so this surfaces what got
 * fused, how tight each cluster was, and which pairs were borderline. Rows are
 * sorted suspicious-first (lowest min intra-cluster similarity) so likely
 * over-merges (e.g. distinct model sizes fused) rise to the top.
 */
export function inspectMergesCommand(logPath: string, opts: InspectMergesOptions): void {
  if (!fs.existsSync(logPath)) throw new Error(`Merge log not found: ${logPath}`);

  let records: MergeRecord[] = fs
    .readFileSync(logPath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MergeRecord)
    .filter((r) => r.member_count > 1);

  if (opts.target) records = records.filter((r) => r.target === opts.target);

  const suspectBelow = opts.suspectBelow ? Number(opts.suspectBelow) : 0.8;
  // Suspicious first: lowest min similarity, then largest cluster.
  records.sort(
    (a, b) =>
      a.intra_cluster_sim.min - b.intra_cluster_sim.min || b.member_count - a.member_count
  );

  const entities = records.filter((r) => r.target === "entity");
  const relations = records.filter((r) => r.target === "relation");
  const suspects = records.filter((r) => r.intra_cluster_sim.min < suspectBelow);

  const out: string[] = [];
  out.push(
    `Merge log: ${logPath}`,
    `  ${records.length} collapsed cluster(s) — ${entities.length} entity, ${relations.length} relation`,
    `  ${suspects.length} flagged as possible over-merge (min sim < ${suspectBelow})`,
    ""
  );

  const limit = opts.limit ? Number(opts.limit) : records.length;
  out.push(pad("⚠", 2) + pad("TARGET", 9) + pad("SIM", 12) + pad("N", 4) + "CANONICAL ⟵ MEMBERS");
  out.push("─".repeat(96));
  for (const r of records.slice(0, limit)) {
    const flag = r.intra_cluster_sim.min < suspectBelow ? "⚠" : " ";
    const sim = `${r.intra_cluster_sim.min.toFixed(2)}–${r.intra_cluster_sim.max.toFixed(2)}`;
    const members = r.surface_forms.filter((s) => s !== r.canonical_chosen).join(" | ");
    out.push(
      pad(flag, 2) +
        pad(r.target, 9) +
        pad(sim, 12) +
        pad(String(r.member_count), 4) +
        `${r.canonical_chosen}  ⟵  ${members}`
    );
  }

  process.stdout.write(out.join("\n") + "\n");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s + " " : s + " ".repeat(width - s.length);
}
