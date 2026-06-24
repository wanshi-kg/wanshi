import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { z } from "zod";
import { KnowledgeGraph, Entity, Relation, obsText } from "../../../types";
import {
  Embedded,
  BorderlinePair,
  MergeDecision,
  clusterByEmbedding,
  cosineSimilarity,
} from "../../../shared/utils";
import { GraphTransform, TransformContext } from "../../pipeline/PipelineRunner";
import { canonicalizeRelationType, digitSignature } from "../merging/KnowledgeMerger";
import { MergeRecord } from "../MergeRecord";
import { CanonicalizationOptions } from "../../../config";
import { trace } from "../../trace";

export { MergeRecord } from "../MergeRecord";

/** Structural stats computed during canon (brief §7 — for Experiment 2's TF-over-graph). */
export interface StructuralStats {
  nodeDegree: Record<string, number>;
  edgeLabelFrequency: Record<string, number>;
}

/**
 * Global canonicalization pass (canon brief §5): over the COMPLETE merged graph,
 * cluster entity surface forms (and, separately, relation labels) by embedding
 * similarity, collapse each cluster to a canonical representative, then dedup the
 * resulting parallel edges and drop self-loops. Layered AFTER KnowledgeMerger —
 * the merger does string-similarity dedup; this catches semantic-but-not-string
 * variants (e.g. "LLM" / "large language model") with a global view.
 *
 * Emits the per-cluster merge log + a run manifest so over/under-merge (silent in
 * aggregate counts) can be audited. Methods: embeddings (cluster), llm/hybrid
 * (adjudicate borderline pairs — never re-extract).
 */
export class Canonicalizer implements GraphTransform {
  readonly stage = "canonicalization";

  /** LLM adjudication calls in the current apply() (reset per pass; capped by cfg.maxAdjudications). */
  private adjudications = 0;

  isEnabled(ctx: TransformContext): boolean {
    return ctx.options.pipeline.canonicalization.enabled;
  }

  async apply(graph: KnowledgeGraph, ctx: TransformContext): Promise<KnowledgeGraph> {
    const cfg = ctx.options.pipeline.canonicalization;
    this.assertSupported(cfg);

    this.adjudications = 0;
    const mergeLog: MergeRecord[] = [];
    let g = graph;

    if (cfg.target.includes("entities")) {
      g = await this.canonicalizeEntities(g, ctx, cfg, mergeLog);
    }
    if (cfg.target.includes("relations")) {
      g = await this.canonicalizeRelations(g, ctx, cfg, mergeLog);
    }

    g = this.dedupAndClean(g);

    const stats = computeStructuralStats(g);
    ctx.logger.info(
      `Canonicalization: ${graph.entities.length}→${g.entities.length} entities, ` +
        `${graph.relations.length}→${g.relations.length} relations ` +
        `(${mergeLog.filter((m) => m.member_count > 1).length} clusters collapsed, ` +
        `${this.adjudications} LLM adjudication(s))`
    );
    if (this.adjudications >= cfg.maxAdjudications) {
      ctx.logger.warn(
        `Adjudication cap (${cfg.maxAdjudications}) hit — remaining borderline pairs were treated as distinct`
      );
    }
    await this.emitInspection(ctx, mergeLog, stats);

    return g;
  }

  /** Only agglomerative clustering is implemented (hdbscan/kmeans are config stubs). */
  private assertSupported(cfg: CanonicalizationOptions): void {
    for (const which of ["entity", "relation"] as const) {
      const algo = cfg.embeddings[which].cluster;
      if (algo !== "agglomerative") {
        throw new Error(
          `Canonicalization cluster algorithm '${algo}' is not yet implemented (use 'agglomerative')`
        );
      }
    }
  }

  // ── entities ───────────────────────────────────────────────────────────────

  private async canonicalizeEntities(
    graph: KnowledgeGraph,
    ctx: TransformContext,
    cfg: CanonicalizationOptions,
    mergeLog: MergeRecord[]
  ): Promise<KnowledgeGraph> {
    const names = graph.entities.map((e) => e.name);
    if (names.length < 2) return graph;

    const embeddings = await ctx.embeddings.embedBatch(names);
    const items: Embedded[] = names.map((id, i) => ({ id, embedding: embeddings[i] }));
    const embByName = new Map(items.map((it) => [it.id, it.embedding]));

    const { clusters, borderline } = await clusterByEmbedding(
      items,
      this.policy(cfg, "entity", ctx)
    );

    const entityByName = new Map(graph.entities.map((e) => [e.name, e]));
    const degree = this.degreeMap(graph);
    const rename = new Map<string, string>();
    const mergedEntities: Entity[] = [];

    for (const cluster of clusters) {
      const canonical = this.pickCanonicalEntity(cluster, cfg, entityByName, degree);
      const merged = { ...entityByName.get(canonical)! };
      merged.observations = [...merged.observations];
      merged.files = [...merged.files];

      for (const member of cluster) {
        rename.set(member, canonical);
        if (member === canonical) continue;
        const e = entityByName.get(member)!;
        this.foldEntity(merged, e);
      }
      mergedEntities.push(merged);

      if (cluster.length > 1) {
        const record = this.buildRecord(
          "entity",
          cluster,
          canonical,
          cfg.method,
          embByName,
          borderline,
          this.spansForEntities(graph, cluster)
        );
        mergeLog.push(record);
        // Canon runs AFTER the merger, with its own clustering/renaming, so the
        // surface forms it collapses here were never folded into the lineage
        // thread. Reattribute each non-canonical member's mentions onto the
        // winner so mentionsFor(canonical) is complete, and emit the decision.
        // Observe-only (lineage lives outside the graph) → byte-identical when
        // trace is off, which is the default.
        this.emitLineageFold(record);
      }
    }

    const relations = graph.relations.map((r) => ({
      ...r,
      from: rename.get(r.from) ?? r.from,
      to: rename.get(r.to) ?? r.to,
    }));

    return { entities: mergedEntities, relations };
  }

  /** Fold member entity `e` into `canonical` (observations by exact text, files union). */
  private foldEntity(canonical: Entity, e: Entity): void {
    const seen = new Set(canonical.observations.map((o) => obsText(o)));
    for (const o of e.observations) {
      if (!seen.has(obsText(o))) {
        canonical.observations.push(o);
        seen.add(obsText(o));
      }
    }
    for (const f of e.files) if (!canonical.files.includes(f)) canonical.files.push(f);
  }

  private pickCanonicalEntity(
    cluster: string[],
    cfg: CanonicalizationOptions,
    entityByName: Map<string, Entity>,
    degree: Map<string, number>
  ): string {
    const score = (name: string): number =>
      cfg.canonicalSelection === "degree"
        ? degree.get(name) ?? 0
        : entityByName.get(name)?.observations.length ?? 0;
    // Highest score; deterministic tie-break by name (ascending).
    return [...cluster].sort((a, b) => score(b) - score(a) || (a < b ? -1 : 1))[0];
  }

  // ── relations ────────────────────────────────────────────────────────────

  private async canonicalizeRelations(
    graph: KnowledgeGraph,
    ctx: TransformContext,
    cfg: CanonicalizationOptions,
    mergeLog: MergeRecord[]
  ): Promise<KnowledgeGraph> {
    // Distinct predicate labels + their frequency across relations.
    const freq = new Map<string, number>();
    for (const r of graph.relations) {
      for (const p of asArray(r.relationType)) freq.set(p, (freq.get(p) ?? 0) + 1);
    }
    const labels = [...freq.keys()];
    if (labels.length < 2) return graph;

    const embeddings = await ctx.embeddings.embedBatch(labels);
    const items: Embedded[] = labels.map((id, i) => ({ id, embedding: embeddings[i] }));
    const embByLabel = new Map(items.map((it) => [it.id, it.embedding]));

    const { clusters, borderline } = await clusterByEmbedding(
      items,
      this.policy(cfg, "relation", ctx)
    );

    const rename = new Map<string, string>();
    for (const cluster of clusters) {
      // Canonical predicate = most frequent (tie-break by label asc).
      const canonical = [...cluster].sort(
        (a, b) => (freq.get(b)! - freq.get(a)!) || (a < b ? -1 : 1)
      )[0];
      for (const member of cluster) rename.set(member, canonical);

      if (cluster.length > 1) {
        const record = this.buildRecord(
          "relation",
          cluster,
          canonical,
          cfg.method,
          embByLabel,
          borderline,
          []
        );
        mergeLog.push(record);
        this.emitLineageFold(record);
      }
    }

    const relations = graph.relations.map((r) => ({
      ...r,
      relationType: dedupePreserveOrder(asArray(r.relationType).map((p) => rename.get(p) ?? p)),
    }));

    return { entities: graph.entities, relations };
  }

  // ── shared helpers ──────────────────────────────────────────────────────

  /** Per-pair decision policy for the configured method. */
  private policy(
    cfg: CanonicalizationOptions,
    which: "entity" | "relation",
    ctx: TransformContext
  ) {
    const threshold = cfg.embeddings[which].threshold;
    const linkage = cfg.embeddings[which].linkage;
    // Digit-mismatch veto (same rule as the string merger and the adjudicator's
    // "distinct versions/models/sizes are NOT the same"): Table 1 ≠ Table 2,
    // M1 ≠ M1 Pro, F_0/M0 ≠ F_4/M3 — embeddings put these too close, and one
    // false pair chains whole families together under single-linkage.
    const veto = (a: string, b: string): boolean => digitSignature(a) !== digitSignature(b);
    if (cfg.method === "embeddings") {
      return {
        decide: (sim: number, a: string, b: string): MergeDecision =>
          !veto(a, b) && sim >= threshold ? "merge" : "reject",
        band: cfg.llm.band as [number, number],
        linkage,
        blockTopN: cfg.blockTopN,
      };
    }
    // llm | hybrid: auto-merge above the band, escalate within it, reject below.
    const band = (cfg.method === "hybrid" ? cfg.hybrid.escalateBand : cfg.llm.band) as [
      number,
      number
    ];
    return {
      decide: (sim: number, a: string, b: string): MergeDecision =>
        veto(a, b) ? "reject" : sim >= band[1] ? "merge" : sim >= band[0] ? "escalate" : "reject",
      band,
      linkage,
      blockTopN: cfg.blockTopN,
      adjudicate: (a: string, b: string) => this.adjudicate(a, b, cfg, which, ctx),
    };
  }

  /** Ask the LLM whether two surface forms co-refer (merge/no-merge only). */
  private async adjudicate(
    a: string,
    b: string,
    cfg: CanonicalizationOptions,
    which: "entity" | "relation",
    ctx: TransformContext
  ): Promise<boolean> {
    const noun = which === "entity" ? "entity names" : "relation predicates";
    // Safety cap (the 26K guard): once exhausted, escalations resolve as "distinct"
    // without billing the LLM. Complete-linkage + blocking should keep us far below it.
    if (this.adjudications >= cfg.maxAdjudications) return false;
    this.adjudications++;
    const schema = z.object({ merge: z.boolean() });
    let verdict = false;
    try {
      const res = await ctx.llm.generateStructured(
        [
          {
            role: "system",
            content:
              "You decide whether two surface forms refer to the SAME thing. " +
              "Answer only by setting `merge` true (same) or false (distinct). " +
              "Be conservative: distinct versions/models/sizes are NOT the same.",
          },
          { role: "user", content: `Do these ${noun} refer to the same thing?\nA: "${a}"\nB: "${b}"` },
        ],
        schema
      );
      verdict = res.merge === true;
    } catch (err) {
      ctx.logger.warn(`Adjudication failed for "${a}" vs "${b}" (treating as distinct): ${err}`);
      verdict = false;
    }
    // Debug trace: emit the adjudicator verdict (previously computed-then-discarded).
    // This is what the parked adjudicator-recall canon analysis runs off. Observe-only.
    if (trace.enabled) {
      trace.emit({
        stage: "merge",
        type: "merge_decision",
        mergeDecisionId: `adj:${which}:${a}␟${b}`,
        target: which,
        canonical: a,
        surfaceForms: [a, b],
        method: "llm",
        verdict: verdict ? "accept" : "reject",
        adjudicated: true,
        adjudicatorVerdict: verdict,
      });
    }
    return verdict;
  }

  /**
   * Fold each non-canonical surface form's mentions onto the winner and emit one
   * `merge_decision` event for the cluster — the same lineage thread the merger
   * maintains (ContainerFactory's `onMergeRecord`), applied to the fusions canon
   * performs after merge. Guarded by `trace.enabled`, and lineage lives outside
   * the graph, so a trace-off run is byte-identical.
   */
  private emitLineageFold(record: MergeRecord): void {
    if (!trace.enabled) return;
    const foldedMentionIds: string[] = [];
    for (const sf of record.surface_forms) {
      if (sf === record.canonical_chosen) continue;
      foldedMentionIds.push(
        ...trace.lineage.fold(sf, record.canonical_chosen).map((m) => m.mentionId)
      );
    }
    trace.emit({
      stage: "merge",
      type: "merge_decision",
      mergeDecisionId: record.cluster_id,
      target: record.target,
      canonical: record.canonical_chosen,
      surfaceForms: record.surface_forms,
      foldedMentionIds,
      cosine: record.intra_cluster_sim?.max,
      method: record.method,
      verdict: "accept",
    });
  }

  private buildRecord(
    target: "entity" | "relation",
    cluster: string[],
    canonical: string,
    method: string,
    embById: Map<string, number[]>,
    borderline: BorderlinePair[],
    sourceSpans: string[]
  ): MergeRecord {
    const inCluster = new Set(cluster);
    return {
      cluster_id: crypto.createHash("sha1").update(cluster.join("␟")).digest("hex").slice(0, 12),
      target,
      surface_forms: cluster,
      canonical_chosen: canonical,
      member_count: cluster.length,
      method,
      intra_cluster_sim: intraClusterSim(cluster, embById),
      borderline_pairs: borderline.filter((p) => inCluster.has(p.a) && inCluster.has(p.b)),
      source_spans: sourceSpans,
    };
  }

  private spansForEntities(graph: KnowledgeGraph, cluster: string[], limit = 5): string[] {
    const names = new Set(cluster);
    const spans: string[] = [];
    for (const r of graph.relations) {
      if (r.sourceSpan && (names.has(r.from) || names.has(r.to))) {
        spans.push(r.sourceSpan);
        if (spans.length >= limit) break;
      }
    }
    return spans;
  }

  /** Drop self-loops (entity merging can create them) and dedup parallel edges. */
  private dedupAndClean(graph: KnowledgeGraph): KnowledgeGraph {
    const seen = new Set<string>();
    const relations: Relation[] = [];
    for (const r of graph.relations) {
      if (r.from === r.to) continue;
      const relationType = canonicalizeRelationType(asArray(r.relationType));
      const key = `${r.from}->${r.to}:${relationType.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relations.push({ ...r, relationType });
    }
    return { entities: graph.entities, relations };
  }

  private degreeMap(graph: KnowledgeGraph): Map<string, number> {
    const d = new Map<string, number>();
    for (const r of graph.relations) {
      d.set(r.from, (d.get(r.from) ?? 0) + 1);
      d.set(r.to, (d.get(r.to) ?? 0) + 1);
    }
    return d;
  }

  /** Write the merge log + run manifest when configured (the actual deliverable). */
  private async emitInspection(
    ctx: TransformContext,
    mergeLog: MergeRecord[],
    stats: StructuralStats
  ): Promise<void> {
    const { inspection, eval: evalCfg } = ctx.options;
    if (!inspection.emitMergeLog && !evalCfg.pinVersions) return;

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = inspection.mergeLogPath ?? path.join("runs", runId, "merges.jsonl");
    const dir = path.dirname(logPath);
    fs.mkdirSync(dir, { recursive: true });

    if (inspection.emitMergeLog) {
      fs.writeFileSync(logPath, mergeLog.map((r) => JSON.stringify(r)).join("\n") + "\n");
      ctx.logger.info(`Merge log written to ${logPath} (${mergeLog.length} cluster record(s))`);
    }

    if (evalCfg.pinVersions) {
      const manifest = {
        runId,
        timestamp: new Date().toISOString(),
        model: ctx.options.llm.model,
        embeddingModel: ctx.options.embeddings.model,
        seed: evalCfg.seed ?? null,
        canonicalization: ctx.options.pipeline.canonicalization,
        configHash: crypto
          .createHash("sha1")
          .update(JSON.stringify(ctx.options))
          .digest("hex")
          .slice(0, 12),
        clustersCollapsed: mergeLog.filter((r) => r.member_count > 1).length,
        structuralStats: stats,
      };
      const manifestPath = path.join(dir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      ctx.logger.info(`Run manifest written to ${manifestPath}`);
    }
  }
}

// ── pure helpers (module-level) ─────────────────────────────────────────────

function asArray(rt: string[] | string): string[] {
  return Array.isArray(rt) ? rt : [rt];
}

function dedupePreserveOrder(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) if (x && !seen.has(x)) (seen.add(x), out.push(x));
  return out;
}

function intraClusterSim(
  cluster: string[],
  embById: Map<string, number[]>
): { min: number; max: number } {
  let min = 1;
  let max = 0;
  let any = false;
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      const a = embById.get(cluster[i]);
      const b = embById.get(cluster[j]);
      if (!a || !b) continue;
      const sim = cosineSimilarity(a, b);
      min = Math.min(min, sim);
      max = Math.max(max, sim);
      any = true;
    }
  }
  return any ? { min, max } : { min: 1, max: 1 };
}

export function computeStructuralStats(graph: KnowledgeGraph): StructuralStats {
  const nodeDegree: Record<string, number> = {};
  for (const e of graph.entities) nodeDegree[e.name] = 0;
  for (const r of graph.relations) {
    nodeDegree[r.from] = (nodeDegree[r.from] ?? 0) + 1;
    nodeDegree[r.to] = (nodeDegree[r.to] ?? 0) + 1;
  }
  const edgeLabelFrequency: Record<string, number> = {};
  for (const r of graph.relations) {
    for (const p of asArray(r.relationType)) {
      edgeLabelFrequency[p] = (edgeLabelFrequency[p] ?? 0) + 1;
    }
  }
  return { nodeDegree, edgeLabelFrequency };
}
