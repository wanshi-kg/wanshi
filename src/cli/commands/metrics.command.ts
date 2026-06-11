import * as fs from "fs";
import { ContainerFactory, TYPES } from "../../core/di";
import { readConfigurationFile, Logger } from "../../shared";
import { parseConfig, ConfigError, ProcessingOptions } from "../../config";
import { computeGraphHealth, GraphHealthMetrics } from "../../quality";
import { KnowledgeGraph } from "../../types/KnowledgeGraph";
import { IEmbeddingProvider } from "../../types/IEmbeddingProvider";
import { SemanticMatcher } from "../../evaluation/matching/SemanticMatcher";
import { computeMetrics } from "../../evaluation/metrics/TripleMetrics";
import { Triplet, EvalMetrics } from "../../evaluation/datasets/IDataset";

export interface MetricsCommandOptions {
  config?: string;
  groundTruth?: string;
  output?: string;
  matchThreshold?: string;
}

interface GroundedMetrics {
  groundTruthTriples: number;
  extractedTriples: number;
  /** Semantic triple-level precision/recall/F1 against ground truth. */
  triple: EvalMetrics;
  /** Edges not supported by ground truth: fp / extracted (= 1 − precision). */
  fabricatedEdgeRate: number;
}

interface MetricsReport {
  graph: string;
  health: GraphHealthMetrics;
  grounded?: GroundedMetrics;
}

/**
 * `kg-gen metrics <graph.json>` — the uniform A/B scorecard (brief §2/§9).
 *
 * The no-ground-truth metrics (type counts, self-loops, bidirectional
 * contradictions, referential integrity, parallel edges) are computed offline
 * for every arm, including the baseline. When `--ground-truth <facts.jsonl>` is
 * supplied, semantic triple precision/recall and the fabricated-edge rate are
 * added — this path needs embeddings, so it builds a container from the config
 * (default: local Ollama) to resolve the configured embedding provider.
 */
export async function metricsCommand(
  graphPath: string,
  opts: MetricsCommandOptions
): Promise<void> {
  const graph = loadGraph(graphPath);
  const report: MetricsReport = {
    graph: graphPath,
    health: computeGraphHealth(graph),
  };

  if (opts.groundTruth) {
    report.grounded = await scoreAgainstGroundTruth(graph, opts);
  }

  const json = JSON.stringify(report, null, 2);
  if (opts.output) {
    fs.writeFileSync(opts.output, json + "\n");
    process.stdout.write(`Metrics written to ${opts.output}\n`);
  }
  process.stdout.write(renderReport(report) + "\n");
}

/** Load a `json`-format export ({entities, relations}). */
function loadGraph(graphPath: string): KnowledgeGraph {
  if (!fs.existsSync(graphPath)) {
    throw new Error(`Graph file not found: ${graphPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
  if (!parsed || !Array.isArray(parsed.entities) || !Array.isArray(parsed.relations)) {
    throw new Error(
      `Not a json-format knowledge graph (expected {entities:[], relations:[]}): ${graphPath}`
    );
  }
  return parsed as KnowledgeGraph;
}

/** Flatten a graph's relations into subject-predicate-object triples. */
function graphToTriplets(graph: KnowledgeGraph): Triplet[] {
  return graph.relations.flatMap((r) => {
    const preds = Array.isArray(r.relationType) ? r.relationType : [r.relationType];
    return preds.map((p) => ({ subject: r.from, predicate: p, object: r.to }));
  });
}

/**
 * Load ground-truth triples from a JSONL file. Each line is one record; we
 * accept the {subject,predicate,object} triple shape and the {from,to,
 * relationType} edge shape (relationType may be a string or array).
 */
function loadGroundTruthTriplets(gtPath: string): Triplet[] {
  if (!fs.existsSync(gtPath)) {
    throw new Error(`Ground-truth file not found: ${gtPath}`);
  }
  const triples: Triplet[] = [];
  const lines = fs.readFileSync(gtPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rec = JSON.parse(trimmed);
    if (rec.subject && rec.object) {
      triples.push({
        subject: String(rec.subject),
        predicate: String(rec.predicate ?? ""),
        object: String(rec.object),
      });
    } else if (rec.from && rec.to) {
      const preds = Array.isArray(rec.relationType)
        ? rec.relationType
        : [rec.relationType ?? ""];
      for (const p of preds) {
        triples.push({ subject: String(rec.from), predicate: String(p), object: String(rec.to) });
      }
    }
  }
  return triples;
}

async function scoreAgainstGroundTruth(
  graph: KnowledgeGraph,
  opts: MetricsCommandOptions
): Promise<GroundedMetrics> {
  const options = await resolveOptions(opts.config);
  const container = ContainerFactory.createContainer({ processingOptions: options });
  const embeddings = await container.resolve<IEmbeddingProvider>(TYPES.EmbeddingService);

  const threshold = opts.matchThreshold ? Number(opts.matchThreshold) : 0.8;
  const matcher = new SemanticMatcher(embeddings, threshold);

  const extracted = graphToTriplets(graph);
  const groundTruth = loadGroundTruthTriplets(opts.groundTruth!);

  const raw = await matcher.matchTriplets(extracted, groundTruth);
  const triple = computeMetrics(raw.tp, raw.fp, raw.fn);

  return {
    groundTruthTriples: groundTruth.length,
    extractedTriples: extracted.length,
    triple,
    fabricatedEdgeRate: extracted.length > 0 ? raw.fp / extracted.length : 0,
  };
}

/** Resolve embeddings/provider config from an optional file, else schema defaults. */
async function resolveOptions(configPath?: string): Promise<ProcessingOptions> {
  const fileRaw = configPath
    ? ((await readConfigurationFile(configPath)) as Record<string, any>)
    : {};
  const envApiKey = process.env.OPENAI_API_KEY || process.env.KG_API_KEY;
  if (envApiKey && !(fileRaw as any)?.embeddings?.apiKey) {
    (fileRaw as any).embeddings = { ...(fileRaw as any).embeddings, apiKey: envApiKey };
  }
  try {
    return parseConfig(fileRaw);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

function renderReport(report: MetricsReport): string {
  const h = report.health;
  const lines = [
    `Graph: ${report.graph}`,
    `  entities                       ${h.entityCount}`,
    `  relations                      ${h.relationCount}`,
    `  entity types                   ${h.entityTypeCount}`,
    `  relation types                 ${h.relationTypeCount}`,
    `  self-loops                     ${h.selfLoopCount}`,
    `  bidirectional contradictions   ${h.bidirectionalContradictionCount}`,
    `  dangling endpoints             ${h.danglingEndpointCount}`,
    `  referential integrity          ${h.referentialIntegrity.toFixed(3)}`,
    `  parallel edges                 ${h.parallelEdgeCount}`,
  ];
  if (report.grounded) {
    const g = report.grounded;
    lines.push(
      `  ── vs ground truth (${g.groundTruthTriples} facts, ${g.extractedTriples} edges) ──`,
      `  triple precision               ${g.triple.precision.toFixed(3)}`,
      `  triple recall                  ${g.triple.recall.toFixed(3)}`,
      `  triple F1                      ${g.triple.f1.toFixed(3)}`,
      `  fabricated-edge rate           ${g.fabricatedEdgeRate.toFixed(3)}`
    );
  }
  return lines.join("\n");
}
