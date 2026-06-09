import { KnowledgeGraph, Entity, Relation, IEmbeddingProvider, Observation, obsText } from "../../../types";
import { jaroWinklerSimilarity , cosineSimilarity } from "../../../shared/utils";
import { Logger } from "../../../shared";

// Default similarity thresholds for entities and observation merging
const DefaultSimilarityThreshold = 0.7;
const DefaultObservationThreshold = 0.7;

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

// Find similar entity by name
function findSimilarEntity(
  entityName: string,
  existingEntities: Map<string, Entity>,
  threshold: number
): string | null {
  let bestMatch: string | null = null;
  let bestSimilarity = 0;

  for (const existingName of existingEntities.keys()) {
    const similarity = jaroWinklerSimilarity(entityName, existingName);
    if (similarity >= threshold && similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = existingName;
    }
  }

  return bestMatch;
}

/** Thresholds the hierarchical merge needs (narrow slice of the merging config). */
export interface MergeThresholds {
  entitySimilarityThreshold?: number;
  observationSimilarityThreshold?: number;
}

export async function mergeKnowledgeGraphs(
  graphs: KnowledgeGraph[],
  options: MergeThresholds,
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
  const finalResult = await mergeGlobally(globalGraphs, options, embeddingService, logger);

  logger?.info(
    `Hierarchical merge complete: ${finalResult.entities.length} entities, ${finalResult.relations.length} relations`
  );

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

// Merge entities within a single file using stricter similarity
async function mergeWithinFile(
  fileGraphs: KnowledgeGraph[],
  fileName: string,
  options: MergeThresholds,
  embeddingService: IEmbeddingProvider,
  logger: Logger,
): Promise<KnowledgeGraph> {
  const entityMap = new Map<string, Entity>();
  const relationSet = new Set<string>();
  const relations: Relation[] = [];

  // Use stricter similarity threshold for same-file merging (entities are more likely to be related)
  const withinFileSimilarityThreshold = Math.min(
    (options.entitySimilarityThreshold || DefaultSimilarityThreshold) * 0.7,
    0.6
  );

  logger?.debug(
    `Within-file similarity threshold for ${fileName}: ${withinFileSimilarityThreshold}`
  );

  // Merge entities within the file
  for (const graph of fileGraphs) {
    for (const entity of graph.entities) {
      const similarEntityName = findSimilarEntity(
        entity.name,
        entityMap,
        withinFileSimilarityThreshold
      );

      if (similarEntityName) {
        // Merge with existing similar entity
        const existing = entityMap.get(similarEntityName)!;
        logger?.debug(
          `[${fileName}] Merging entity "${entity.name}" with existing "${similarEntityName}"`
        );

        // Combine observations
        const allObservations = [
          ...(existing.observations || []),
          ...(entity.observations || []),
        ];

        // Deduplicate observations using embeddings (more aggressive within file)
        if (allObservations.length > 0) {
          existing.observations = await deduplicateObservations(
            allObservations,
            Math.min((options.observationSimilarityThreshold || DefaultObservationThreshold) * 0.8, 0.7), // More aggressive deduplication
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
        const newEntity = { ...entity, file: fileName };
        entityMap.set(entity.name, newEntity);
      }
    }
  }

  // Merge relations within the file
  for (const graph of fileGraphs) {
    for (const relation of graph.relations) {
      // Map relation entity names to merged names
      const fromEntity =
        findSimilarEntity(
          relation.from,
          entityMap,
          withinFileSimilarityThreshold
        ) || relation.from;
      const toEntity =
        findSimilarEntity(
          relation.to,
          entityMap,
          withinFileSimilarityThreshold
        ) || relation.to;

      // Drop self-loops (X→X): an extraction artifact, and merging names can also
      // create one when both endpoints collapse to the same entity.
      if (fromEntity === toEntity) continue;

      // Only keep relations where both entities exist in the file's merged graph
      if (entityMap.has(fromEntity) && entityMap.has(toEntity)) {
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
  }

  return {
    entities: Array.from(entityMap.values()),
    relations: relations,
  };
}

// Global merge across different files using more relaxed similarity
async function mergeGlobally(
  fileGraphs: KnowledgeGraph[],
  options: MergeThresholds,
  embeddingService: IEmbeddingProvider,
  logger: Logger,
): Promise<KnowledgeGraph> {
  const entityMap = new Map<string, Entity>();
  const relationSet = new Set<string>();
  const relations: Relation[] = [];

  // Track which files each entity appears in
  const entityFileMap = new Map<string, Set<string>>();

  // Use the original similarity threshold for cross-file merging
  const globalSimilarityThreshold = options.entitySimilarityThreshold;

  logger?.debug(
    `Global similarity threshold: ${globalSimilarityThreshold}`
  );

  // Merge entities across files
  for (const graph of fileGraphs) {
    for (const entity of graph.entities) {
      const similarEntityName = findSimilarEntity(
        entity.name,
        entityMap,
        globalSimilarityThreshold || DefaultSimilarityThreshold
      );

      if (similarEntityName) {
        // Merge with existing similar entity from different file
        const existing = entityMap.get(similarEntityName)!;
        logger?.debug(
          `[Global] Merging entity "${entity.name}" (${entity.files[0]}) with existing "${similarEntityName}" (${existing.files[0]})`
        );

        // Combine observations (more conservative deduplication across files)
        const allObservations = [
          ...(existing.observations || []),
          ...(entity.observations || []),
        ];

        if (allObservations.length > 0) {
          existing.observations = await deduplicateObservations(
            allObservations,
            options.observationSimilarityThreshold || DefaultObservationThreshold, // Use original threshold
            embeddingService,
            logger,
          );
        }

        // Merge entity types (prefer more specific one)
        if (
          entity.entityType &&
          entity.entityType.length > existing.entityType.length
        ) {
          existing.entityType = entity.entityType;
        }

        // Track files this entity appears in
        if (!entityFileMap.has(similarEntityName)) {
          entityFileMap.set(
            similarEntityName,
            new Set([existing.files[0] || "unknown"])
          );
        }
        entityFileMap.get(similarEntityName)!.add(entity.files[0] || "unknown");

        // Update file information to include multiple files
        // const files = Array.from(entityFileMap.get(similarEntityName)!);
        // existing.files[0] = files.length === 1 ? files[0] : files.join(",");

        // Merge chunk information (keep ranges)
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
        entityMap.set(entity.name, { ...entity });
        entityFileMap.set(entity.name, new Set([entity.files[0] || "unknown"]));
      }
    }
  }

  // Merge relations across files
  for (const graph of fileGraphs) {
    for (const relation of graph.relations) {
      // Map relation entity names to merged names
      const fromEntity =
        findSimilarEntity(
          relation.from,
          entityMap,
          globalSimilarityThreshold || DefaultSimilarityThreshold
        ) || relation.from;
      const toEntity =
        findSimilarEntity(relation.to, entityMap, globalSimilarityThreshold || DefaultSimilarityThreshold) ||
        relation.to;

      // Drop self-loops (X→X): an extraction artifact, and cross-file name
      // mapping can also collapse both endpoints onto the same entity.
      if (fromEntity === toEntity) continue;

      // Only keep relations where both entities exist in final graph
      if (entityMap.has(fromEntity) && entityMap.has(toEntity)) {
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

  return {
    entities: Array.from(entityMap.values()),
    relations: relations,
  };
}

// Very basic search function
export function searchKnowledgeGraphsNodes(
  query: string,
  graphs: KnowledgeGraph[],
  similarityThreshold: number = 0.7,
  limit: number = 5
): KnowledgeGraph {
  const filteredGraph = graphs.reduce(
    (acc, graph) => {
      // Filter entities
      const filteredEntities = graph.entities.filter(
        (e) =>
          jaroWinklerSimilarity(e.name, query) > similarityThreshold ||
          jaroWinklerSimilarity(e.entityType, query) > similarityThreshold ||
          e.observations.some(
            (o) => jaroWinklerSimilarity(obsText(o), query) > similarityThreshold
          )
      );

      // Create a Set of filtered entity names for quick lookup
      const filteredEntityNames = new Set([
        ...filteredEntities.map((e) => e.name),
        ...acc.entities.map((e) => e.name)
      ]);

      // Filter relations to only include those between filtered entities
      const filteredRelations = [ ...graph.relations, ...acc.relations ].filter(
        (r) => filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
      );

      return { entities: filteredEntities, relations: filteredRelations };
    },
    { entities: [], relations: [] } as KnowledgeGraph
  );

  const filteredEntities = filteredGraph.entities.slice(0, limit);
  const filteredEntityNames = new Set(filteredEntities.map((e) => e.name));
  const filteredRelations = filteredGraph.relations.filter(
    (r) => filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
  );

  return {
    entities: filteredEntities,
    relations: filteredRelations
  }
}
