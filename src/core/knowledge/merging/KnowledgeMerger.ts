import * as crypto from "crypto";
import { KnowledgeGraph, Entity, Relation, IEmbeddingProvider, Observation, obsText, IContradictionChecker } from "../../../types";
import { jaroWinklerSimilarity , cosineSimilarity } from "../../../shared/utils";
import { Logger } from "../../../shared";
import { MergeRecord } from "../MergeRecord";

// Default similarity thresholds for entities and observation merging
const DefaultSimilarityThreshold = 0.7;
const DefaultObservationThreshold = 0.7;
// A fuzzy match across two different known entity types must clear this bar —
// spelling similarity alone is weak evidence of co-reference when types disagree
// (garlic/concept vs Anthropic/organization sit at JW 0.704).
const CrossTypeThreshold = 0.95;

/** Provenance identity used to keep distinct sources/speakers un-merged. */
function provenanceKey(o: Observation): string {
  return `${o.source ?? ""}␟${o.speaker ?? ""}`;
}

/**
 * Canonicalize a relation's `relationType` array so semantically identical edges
 * collapse on merge: trim → lowercase → de-dupe → sort. This makes the compound
 * predicate order-insensitive, so `["uses","calls"]` and `["calls","uses"]` (the
 * "reversed-twin" class that bloats the predicate vocabulary) map to one key.
 * Pure — exported for tests.
 */
export function canonicalizeRelationType(types: string[]): string[] {
  return Array.from(
    new Set((types ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))
  ).sort();
}

/**
 * Deduplicate observations while PRESERVING per-source attribution: the same
 * fact asserted by two different sources/speakers stays as two observations.
 * We partition by provenance identity and only collapse near-duplicates *within*
 * a single provenance group.
 */
async function deduplicateObservations(
  observations: Observation[],
  threshold: number,
  embeddingService: IEmbeddingProvider,
  logger: Logger,
): Promise<Observation[]> {
  if (observations.length <= 1) return observations;

  logger?.debug(`Deduplicating ${observations.length} observations (provenance-aware)`);

  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    const key = provenanceKey(o);
    const g = groups.get(key);
    if (g) g.push(o);
    else groups.set(key, [o]);
  }

  const result: Observation[] = [];
  for (const group of groups.values()) {
    result.push(
      ...(await dedupWithinProvenance(group, threshold, embeddingService, logger))
    );
  }

  logger?.debug(
    `Deduplicated to ${result.length} observations (removed ${
      observations.length - result.length
    }, across ${groups.size} provenance group(s))`
  );
  return result;
}

/** Collapse near-duplicate observations that share the same provenance. */
async function dedupWithinProvenance(
  observations: Observation[],
  threshold: number,
  embeddingService: IEmbeddingProvider,
  logger: Logger,
): Promise<Observation[]> {
  if (observations.length <= 1) return observations;

  const data: Array<{ obs: Observation; embedding: number[] }> = [];
  for (const obs of observations) {
    try {
      const embedding = await embeddingService.embed(obs.text);
      data.push({ obs, embedding });
    } catch (error) {
      logger?.warn(`Failed to get embedding for observation: ${obs.text}`);
      data.push({ obs, embedding: [] }); // keep it even if embedding fails
    }
  }

  const toRemove = new Set<number>();
  for (let i = 0; i < data.length; i++) {
    if (toRemove.has(i) || data[i].embedding.length === 0) continue;
    for (let j = i + 1; j < data.length; j++) {
      if (toRemove.has(j) || data[j].embedding.length === 0) continue;
      const similarity = cosineSimilarity(data[i].embedding, data[j].embedding);
      if (similarity >= threshold) {
        // keep the longer/more detailed observation (with its provenance)
        if (data[i].obs.text.length >= data[j].obs.text.length) {
          toRemove.add(j);
        } else {
          toRemove.add(i);
          break;
        }
      }
    }
  }

  return data.filter((_, index) => !toRemove.has(index)).map((d) => d.obs);
}

/** Normalize an entity name for the exact-match fast path: case, `_`/`-`/dash and whitespace runs. */
export function normalizeEntityName(name: string): string {
  return name.toLowerCase().replace(/[_\-‐-―\s]+/g, " ").trim();
}

/** Digit tokens of a name ("Table 12 v2" → "12,2"). Differing signatures veto fuzzy merging. */
export function digitSignature(name: string): string {
  return (name.match(/\d+/g) ?? []).join(",");
}

interface EntityMatch {
  name: string;
  sim: number;
  method: "string-exact" | "string-jw";
}

/**
 * Find an existing entity the candidate should fold into. A normalized-exact name
 * match always wins. Fuzzy (Jaro-Winkler) matching is gated by guards encoding
 * "similar spelling is not co-reference": names whose digit tokens differ never
 * merge (Table 1 ≠ Table 2, NeurIPS 2019 ≠ NeurIPS 2024), and a match across two
 * different known entity types must clear the near-exact CrossTypeThreshold.
 */
function findSimilarEntity(
  entity: Entity,
  existingEntities: Map<string, Entity>,
  threshold: number,
  enableSimilarityMerging: boolean,
  qualifyFileIdentity: boolean = false
): EntityMatch | null {
  // At the global stage, file-identity entities (file/document) are matched by an
  // exact name+file key *before* this is called, so skip them here — a conceptual
  // entity must never fuse with a file artifact, and a file artifact never fuzzy-
  // matches another file's same-named artifact (KG-13). Within-file merge passes
  // false, preserving its name-only behavior.
  const skip = (e: Entity) => qualifyFileIdentity && FILE_IDENTITY_TYPES.has(e.entityType);

  const norm = normalizeEntityName(entity.name);
  for (const [existingName, existing] of existingEntities) {
    if (skip(existing)) continue;
    if (normalizeEntityName(existingName) === norm) {
      return { name: existingName, sim: 1, method: "string-exact" };
    }
  }

  if (!enableSimilarityMerging) return null;

  const digits = digitSignature(entity.name);
  let best: EntityMatch | null = null;

  for (const [existingName, existing] of existingEntities) {
    if (skip(existing)) continue;
    if (digitSignature(existingName) !== digits) continue;

    const crossType =
      !!entity.entityType &&
      !!existing.entityType &&
      entity.entityType !== existing.entityType &&
      entity.entityType !== "other" &&
      existing.entityType !== "other";
    const required = crossType ? Math.max(threshold, CrossTypeThreshold) : threshold;

    const similarity = jaroWinklerSimilarity(entity.name, existingName);
    if (similarity >= required && (!best || similarity > best.sim)) {
      best = { name: existingName, sim: similarity, method: "string-jw" };
    }
  }

  return best;
}

/**
 * Cross-file linking health, emitted once per merge (KG-04). Unlike the post-hoc
 * `danglingEndpointCount` on a saved graph — which is ~0 by design because the
 * global stage enforces referential integrity — these are *merge-time* counts: the
 * dropped edges are by definition absent from the final graph, so this is the only
 * place the recall signal exists. A high `droppedDanglingEdges` means the model is
 * inventing endpoints; a healthy `crossFileEdges` means retrieval-driven cross-file
 * linking is actually surviving to the output (the whole point of retrieval context).
 */
export interface MergeStats {
  /** Edges in the final graph whose endpoints were first defined in different
   *  files — the cross-file links the within-file gate used to destroy before
   *  the global merge ever saw them. */
  crossFileEdges: number;
  /** Edges dropped at the global stage because an endpoint resolved to no entity
   *  anywhere in the merged graph (true danglers / hallucinated endpoints). */
  droppedDanglingEdges: number;
}

/** Options the hierarchical merge needs (narrow slice of the merging config). */
export interface MergeOptions {
  entitySimilarityThreshold?: number;
  observationSimilarityThreshold?: number;
  /** false ⇒ only normalized-exact name matches merge (no fuzzy JW). Default true. */
  enableSimilarityMerging?: boolean;
  /** Called once per fusion of two differently-named surface forms (merge-log seam). */
  onMergeRecord?: (record: MergeRecord) => void;
  /** Called once at end-of-merge with the cross-file linking health (KG-04). */
  onMergeStats?: (stats: MergeStats) => void;
  /** When set, run merge-time supersession (KG-10): a newer fact contradicting an
   *  older one invalidates the older (bi-temporal `invalidAt`/`expiredAt`) rather
   *  than deleting it. Off ⇒ no supersession (default). */
  contradictionChecker?: IContradictionChecker;
}

/**
 * Merge-time supersession (KG-10, Graphiti "invalidate, don't delete"): for each
 * pair of an entity's observations the checker flags as contradictory AND that
 * carry orderable `validAt`, stamp the OLDER one's `invalidAt` (= when the newer
 * fact began holding) and `expiredAt` (= now, when we recorded the supersession).
 * Both observations are kept — history is preserved, the newer is current.
 */
async function applySupersession(
  observations: Observation[],
  checker: IContradictionChecker,
  now: string
): Promise<void> {
  for (let i = 0; i < observations.length; i++) {
    for (let j = i + 1; j < observations.length; j++) {
      const a = observations[i];
      const b = observations[j];
      if (!a.validAt || !b.validAt || a.validAt === b.validAt) continue;
      if (a.expiredAt || b.expiredAt) continue; // already superseded
      const { contradicts } = await checker.check(a.text, b.text);
      if (!contradicts) continue;
      const older = a.validAt < b.validAt ? a : b;
      const newer = older === a ? b : a;
      older.invalidAt = newer.validAt;
      older.expiredAt = now;
    }
  }
}

/** Emit a merge-log record for one fusion (same JSONL shape as canon's merges.jsonl). */
function recordFusion(
  options: MergeOptions,
  winner: string,
  loser: string,
  match: EntityMatch
): void {
  if (!options.onMergeRecord || winner === loser) return;
  options.onMergeRecord({
    cluster_id: crypto.createHash("sha1").update(`${winner}␟${loser}`).digest("hex").slice(0, 12),
    target: "entity",
    surface_forms: [winner, loser],
    canonical_chosen: winner,
    member_count: 2,
    method: match.method,
    intra_cluster_sim: { min: match.sim, max: match.sim },
    borderline_pairs: [],
    source_spans: [],
  });
}

export async function mergeKnowledgeGraphs(
  graphs: KnowledgeGraph[],
  options: MergeOptions,
  embeddingService: IEmbeddingProvider,
  logger: Logger,
): Promise<KnowledgeGraph> {
  logger?.info(
    `Starting hierarchical merge of ${graphs.length} knowledge graphs`
  );
  logger?.info(
    `Entity similarity threshold: ${options.entitySimilarityThreshold}`
  );
  logger?.info(
    `Observation similarity threshold: ${options.observationSimilarityThreshold}`
  );

  // Step 1: Group graphs by file
  const graphsByFile = new Map<string, KnowledgeGraph[]>();

  for (const graph of graphs) {
    for (const entity of graph.entities) {
      const file = entity.files[0] || "unknown";
      if (!graphsByFile.has(file)) {
        graphsByFile.set(file, []);
      }

      // Create a mini-graph for this entity and related relations
      const entityGraph: KnowledgeGraph = {
        entities: [entity],
        relations: graph.relations.filter(
          (r) => r.from === entity.name || r.to === entity.name
        ),
      };

      graphsByFile.get(file)!.push(entityGraph);
    }
  }

  logger?.info(`Step 1: Grouped into ${graphsByFile.size} files`);

  // Step 2: Merge entities within each file
  const mergedByFile = new Map<string, KnowledgeGraph>();

  for (const [file, fileGraphs] of graphsByFile) {
    logger?.debug(
      `Step 2: Merging ${fileGraphs.length} entities in file: ${file}`
    );

    const fileMerged = await mergeWithinFile(fileGraphs, file, options, embeddingService, logger);
    mergedByFile.set(file, fileMerged);

    logger?.debug(
      `File ${file}: ${fileMerged.entities.length} entities, ${fileMerged.relations.length} relations`
    );
  }

  // Step 3: Global merge across files
  logger?.info(
    `Step 3: Global merge across ${mergedByFile.size} files`
  );

  const globalGraphs = Array.from(mergedByFile.values());
  const { graph: finalResult, stats } = await mergeGlobally(
    globalGraphs,
    options,
    embeddingService,
    logger
  );

  logger?.info(
    `Hierarchical merge complete: ${finalResult.entities.length} entities, ${finalResult.relations.length} relations`
  );

  // Cross-file linking health (KG-04) — the recall signal "0 dangling" used to hide.
  logger?.info(
    `Cross-file linking: ${stats.crossFileEdges} edge(s) link entities across files; ` +
      `${stats.droppedDanglingEdges} relation(s) dropped as dangling at the global stage`
  );
  options.onMergeStats?.(stats);

  logVocabularyFit(finalResult, logger);

  return finalResult;
}

/**
 * Closed-vocabulary fit metric (Dove's guardrail for the v5 enums): how often the
 * model fell back to a catch-all instead of a specific type/predicate. A high
 * relation `related_to` fraction (north of ~15–20%) suggests the closed predicate
 * set is too tight for this corpus, not that the corpus is weird.
 */
function logVocabularyFit(graph: KnowledgeGraph, logger: Logger): void {
  const rels = graph.relations;
  const ents = graph.entities;
  if (rels.length === 0 && ents.length === 0) return;

  const relCatchAll = rels.filter((r) => {
    const types = Array.isArray(r.relationType) ? r.relationType : [r.relationType];
    return types.length > 0 && types.every((t) => t === "related_to");
  }).length;
  const entCatchAll = ents.filter((e) => e.entityType === "other").length;

  const relPct = rels.length ? ((100 * relCatchAll) / rels.length).toFixed(1) : "0.0";
  const entPct = ents.length ? ((100 * entCatchAll) / ents.length).toFixed(1) : "0.0";
  logger?.info(
    `Vocabulary fit: ${relCatchAll}/${rels.length} relations → 'related_to' (${relPct}%), ` +
      `${entCatchAll}/${ents.length} entities → 'other' (${entPct}%)`
  );
}

// Merge entities within a single file. Same threshold as the global pass — the old
// "stricter for same-file" heuristic (×0.7, cap 0.6) fused unrelated short names
// (garlic↔Anthropic at JW 0.704); same-file proximity is not evidence of co-reference.
async function mergeWithinFile(
  fileGraphs: KnowledgeGraph[],
  fileName: string,
  options: MergeOptions,
  embeddingService: IEmbeddingProvider,
  logger: Logger,
): Promise<KnowledgeGraph> {
  const entityMap = new Map<string, Entity>();
  const relationSet = new Set<string>();
  const relations: Relation[] = [];

  const threshold = options.entitySimilarityThreshold || DefaultSimilarityThreshold;
  const enableSimilarity = options.enableSimilarityMerging !== false;
  // Every incoming surface form → its final entity key; relations re-key through this
  // map only (never through an independent fuzzy lookup).
  const rename = new Map<string, string>();

  // Merge entities within the file
  for (const graph of fileGraphs) {
    for (const entity of graph.entities) {
      const match = findSimilarEntity(entity, entityMap, threshold, enableSimilarity);

      if (match) {
        rename.set(entity.name, match.name);
        recordFusion(options, match.name, entity.name, match);

        const existing = entityMap.get(match.name)!;
        logger?.debug(
          `[${fileName}] Merging entity "${entity.name}" with existing "${match.name}"`
        );

        // Combine observations
        const allObservations = [
          ...(existing.observations || []),
          ...(entity.observations || []),
        ];

        // Deduplicate observations using embeddings
        if (allObservations.length > 0) {
          existing.observations = await deduplicateObservations(
            allObservations,
            options.observationSimilarityThreshold || DefaultObservationThreshold,
            embeddingService,
            logger
          );
        }

        // Merge other properties
        existing.entityType = existing.entityType || entity.entityType;

        // Merge chunk information (keep the range)
        if (entity.chunk !== undefined) {
          existing.chunk =
            existing.chunk !== undefined
              ? Math.min(existing.chunk, entity.chunk)
              : entity.chunk;
        }
        if (entity.totalChunks !== undefined) {
          existing.totalChunks = Math.max(
            existing.totalChunks || 0,
            entity.totalChunks
          );
        }
      } else {
        // Add as new entity
        rename.set(entity.name, entity.name);
        const newEntity = { ...entity, file: fileName };
        entityMap.set(entity.name, newEntity);
      }
    }
  }

  // Merge relations within the file, re-keying endpoints through the rename map.
  // Referential integrity is NOT enforced here (KG-04): a relation may legitimately
  // point at an entity defined in ANOTHER file — the v5 cross-file contract — and
  // those endpoints aren't visible until the global stage, where the full entity
  // universe is known. Dropping them here destroyed every compliant cross-file edge
  // before global merge ever saw it. So pass all (re-keyed, non-self-loop) relations
  // through; mergeGlobally is the sole endpoint-existence gate.
  for (const graph of fileGraphs) {
    for (const relation of graph.relations) {
      const fromEntity = rename.get(relation.from) ?? relation.from;
      const toEntity = rename.get(relation.to) ?? relation.to;

      // Drop self-loops (X→X): an extraction artifact, and merging names can also
      // create one when both endpoints collapse to the same entity.
      if (fromEntity === toEntity) continue;

      const relationType = canonicalizeRelationType(relation.relationType);
      const relationKey = `${fromEntity}->${toEntity}:${relationType.join(",")}`;
      if (!relationSet.has(relationKey)) {
        relationSet.add(relationKey);
        relations.push({
          from: fromEntity,
          to: toEntity,
          relationType,
          ...(relation.sourceSpan ? { sourceSpan: relation.sourceSpan } : {}),
          ...(relation.validAt ? { validAt: relation.validAt } : {}),
        });
      }
    }
  }

  return {
    entities: Array.from(entityMap.values()),
    relations: relations,
  };
}

const ENTITY_CATCH_ALL = "other";

/**
 * Entity types that denote a *file/document artifact* rather than a concept
 * (KG-13). Two `package.json` (or `index.ts`, or a `document` per paper) in
 * different files are distinct artifacts that must NOT fuse, whereas a `function`
 * or `concept` of the same name across files is the same thing and *should* merge
 * (the whole point of global cross-file linking). So identity is name+file for
 * these types only.
 */
const FILE_IDENTITY_TYPES = new Set(["file", "document"]);

/** Field separator for a name+file qualified identity key (unit separator). */
const ID_SEP = "␟";

/**
 * Global-merge identity key for an entity: its bare name for conceptual entities
 * (so same-name concepts merge across files), or `name␟primaryFile` for
 * file-identity types (so same-name file artifacts in different files stay
 * distinct). The bare name never contains `␟`, so the two key spaces can't collide.
 */
function entityIdentityKey(entity: Entity): string {
  if (FILE_IDENTITY_TYPES.has(entity.entityType)) {
    return `${entity.name}${ID_SEP}${entity.files[0] ?? "unknown"}`;
  }
  return entity.name;
}

/**
 * Elect a merged entity's type from all the types its fused surface forms carried
 * (KG-13): a specific type always beats the `other` catch-all, then majority vote
 * wins (ties broken by first occurrence, so it's deterministic). Replaces the old
 * "longest string wins" heuristic, under which `other`(5) beat `file`(4) and
 * `organization` always beat `person`.
 */
function electEntityType(types: string[]): string {
  const specific = types.filter((t) => t && t !== ENTITY_CATCH_ALL);
  const pool = specific.length > 0 ? specific : types.filter(Boolean);
  if (pool.length === 0) return ENTITY_CATCH_ALL;
  const counts = new Map<string, number>();
  for (const t of pool) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best = pool[0];
  let bestN = 0;
  for (const t of pool) {
    const n = counts.get(t)!;
    if (n > bestN) {
      bestN = n;
      best = t;
    }
  }
  return best;
}

// Global merge across different files. The sole referential-integrity gate (KG-04):
// the within-file pass defers here, where every entity across all files is visible.
async function mergeGlobally(
  fileGraphs: KnowledgeGraph[],
  options: MergeOptions,
  embeddingService: IEmbeddingProvider,
  logger: Logger,
): Promise<{ graph: KnowledgeGraph; stats: MergeStats }> {
  const entityMap = new Map<string, Entity>();
  const relationSet = new Set<string>();
  const relations: Relation[] = [];

  // Track which files each entity appears in
  const entityFileMap = new Map<string, Set<string>>();
  // Every entityType each fused surface form carried → elected at end-of-merge (KG-13).
  const entityTypeVotes = new Map<string, string[]>();

  const globalSimilarityThreshold =
    options.entitySimilarityThreshold || DefaultSimilarityThreshold;
  const enableSimilarity = options.enableSimilarityMerging !== false;
  // Relation re-keying is PER GRAPH (KG-13): a file artifact's bare name is
  // ambiguous across files, so each graph's relations resolve endpoints against
  // that graph's own surface-name → output-name map; conceptual names also fall
  // back to a global map for genuine cross-file references.
  const renamePerGraph: Map<string, string>[] = [];
  const globalConceptualRename = new Map<string, string>();
  // For file-identity entities, `name␟file` → the output name already assigned, so
  // the same artifact re-extracted (e.g. across chunks) merges into one entity.
  const idKeyToName = new Map<string, string>();

  logger?.debug(
    `Global similarity threshold: ${globalSimilarityThreshold}`
  );

  // Assign a unique output name, disambiguating a file artifact only when its bare
  // name is already taken by a *different* file/entity (so the common single-project
  // case keeps the clean `package.json`, but two projects' don't collide → no data loss).
  const uniqueName = (name: string, file?: string): string => {
    if (!entityMap.has(name)) return name;
    const base = file ? `${name} [${file}]` : name;
    let candidate = base;
    let i = 2;
    while (entityMap.has(candidate)) candidate = `${base}#${i++}`;
    return candidate;
  };

  // Merge entities across files
  for (const graph of fileGraphs) {
    const localRename = new Map<string, string>();
    renamePerGraph.push(localRename);

    for (const entity of graph.entities) {
      const fileIdentity = FILE_IDENTITY_TYPES.has(entity.entityType);

      // Resolve which existing entity (if any) this one merges into, as an output
      // name. File artifacts merge only with the exact same name+file; conceptual
      // entities merge by name/similarity (and never with a file artifact).
      let outName: string;
      let isNew: boolean;
      let match: EntityMatch | null = null;

      if (fileIdentity) {
        const idKey = `${entity.name}${ID_SEP}${entity.files[0] ?? "unknown"}`;
        const claimed = idKeyToName.get(idKey);
        if (claimed) {
          outName = claimed;
          isNew = false;
        } else {
          outName = uniqueName(entity.name, entity.files[0]);
          idKeyToName.set(idKey, outName);
          isNew = true;
        }
      } else {
        match = findSimilarEntity(entity, entityMap, globalSimilarityThreshold, enableSimilarity, true);
        if (match) {
          outName = match.name;
          isNew = false;
        } else {
          // A conceptual entity that clashes with a file artifact holding the bare
          // name gets disambiguated rather than overwriting it.
          outName = uniqueName(entity.name);
          isNew = true;
        }
      }

      localRename.set(entity.name, outName);
      if (!fileIdentity) globalConceptualRename.set(entity.name, outName);

      if (!isNew) {
        const existing = entityMap.get(outName)!;
        // Only a genuinely different surface form fused is merge-log-worthy.
        if (match && existing.name !== entity.name) {
          recordFusion(options, outName, entity.name, match);
        }
        logger?.debug(
          `[Global] Merging entity "${entity.name}" (${entity.files[0]}) into "${outName}" (${existing.files[0]})`
        );

        const allObservations = [
          ...(existing.observations || []),
          ...(entity.observations || []),
        ];
        if (allObservations.length > 0) {
          existing.observations = await deduplicateObservations(
            allObservations,
            options.observationSimilarityThreshold || DefaultObservationThreshold,
            embeddingService,
            logger,
          );
        }

        // Vote this surface form's type; the winner is elected at end-of-merge (KG-13).
        entityTypeVotes.get(outName)!.push(entity.entityType);

        for (const f of entity.files.length ? entity.files : ["unknown"]) {
          entityFileMap.get(outName)!.add(f);
        }

        if (entity.chunk !== undefined) {
          existing.chunk =
            existing.chunk !== undefined ? Math.min(existing.chunk, entity.chunk) : entity.chunk;
        }
        if (entity.totalChunks !== undefined) {
          existing.totalChunks = Math.max(existing.totalChunks || 0, entity.totalChunks);
        }
      } else {
        entityMap.set(outName, { ...entity, name: outName });
        entityFileMap.set(outName, new Set(entity.files.length ? entity.files : ["unknown"]));
        entityTypeVotes.set(outName, [entity.entityType]);
      }
    }
  }

  // Merge relations across files, re-keying endpoints through the rename map. This
  // is the sole endpoint-existence gate (KG-04): an endpoint missing here resolved
  // to no entity in ANY file, so it's a true dangler. Cross-file edges — endpoints
  // first surfaced in different files — survive here precisely because the within-
  // file pass no longer destroys them.
  let droppedDanglingEdges = 0;
  let crossFileEdges = 0;
  fileGraphs.forEach((graph, gi) => {
    const localRename = renamePerGraph[gi];
    for (const relation of graph.relations) {
      // Resolve endpoints against THIS graph's name map first (so a file artifact
      // resolves to the right disambiguated entity), then a global conceptual
      // fallback for genuine cross-file references (KG-13).
      const fromEntity =
        localRename.get(relation.from) ?? globalConceptualRename.get(relation.from) ?? relation.from;
      const toEntity =
        localRename.get(relation.to) ?? globalConceptualRename.get(relation.to) ?? relation.to;

      // Drop self-loops (X→X): an extraction artifact, and cross-file name
      // mapping can also collapse both endpoints onto the same entity.
      if (fromEntity === toEntity) continue;

      const fromNode = entityMap.get(fromEntity);
      const toNode = entityMap.get(toEntity);
      if (fromNode && toNode) {
        const relationType = canonicalizeRelationType(relation.relationType);
        const relationKey = `${fromEntity}->${toEntity}:${relationType.join(",")}`;
        if (!relationSet.has(relationKey)) {
          relationSet.add(relationKey);
          // Count once per unique surviving edge whose endpoints were first defined
          // in different files — the cross-file links the old within-file gate killed.
          if ((fromNode.files?.[0] ?? "") !== (toNode.files?.[0] ?? "")) {
            crossFileEdges++;
          }
          relations.push({
            from: fromEntity,
            to: toEntity,
            relationType,
            ...(relation.sourceSpan ? { sourceSpan: relation.sourceSpan } : {}),
            ...(relation.validAt ? { validAt: relation.validAt } : {}),
          });
        }
      } else {
        droppedDanglingEdges++;
      }
    }
  });
  if (droppedDanglingEdges > 0) {
    logger?.info(
      `Global merge dropped ${droppedDanglingEdges} relation(s) whose endpoints resolved to no entity (true danglers)`
    );
  }

  // Log cross-file entity statistics
  const crossFileEntities = Array.from(entityFileMap.entries()).filter(
    ([_, files]) => files.size > 1
  );

  if (crossFileEntities.length > 0) {
    logger?.info(
      `Found ${crossFileEntities.length} entities appearing across multiple files:`
    );
    crossFileEntities.forEach(([entityName, files]) => {
      logger?.debug(`  ${entityName}: ${Array.from(files).join(", ")}`);
    });
  }

  // Finalize each merged entity: elect its type from all votes (specific beats
  // `other`, then majority), write back the cross-file files[] union (KG-13), and
  // run merge-time supersession over its observations when enabled (KG-10).
  const supersessionNow = new Date().toISOString();
  for (const [key, entity] of entityMap) {
    entity.entityType = electEntityType(entityTypeVotes.get(key) ?? [entity.entityType]);
    const files = entityFileMap.get(key);
    if (files && files.size > 0) {
      entity.files = Array.from(files).filter((f) => f !== "unknown");
      if (entity.files.length === 0) entity.files = Array.from(files);
    }
    if (options.contradictionChecker) {
      await applySupersession(entity.observations, options.contradictionChecker, supersessionNow);
    }
  }

  return {
    graph: {
      entities: Array.from(entityMap.values()),
      relations: relations,
    },
    stats: { crossFileEdges, droppedDanglingEdges },
  };
}
