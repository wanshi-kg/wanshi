import * as fs from "fs";
import * as path from "path";
import { mergeKnowledgeGraphs } from "./KnowledgeMerger";
import { KnowledgeGraph, Entity } from "../../../types";
import { stubLogger } from "../../../__tests__/helpers";

/**
 * Regression fixture from a real run (examples/kg-telegram-sink): an arXiv PDF
 * (Epicure, food-ingredient embeddings) + 3 tech articles, extracted by
 * gemini-2.5-flash with prompt v5 — 64 chunks, 1154 distinct raw entity names.
 *
 * The pre-fix merger (within-file Jaro-Winkler at min(t*0.7, 0.6), name-only)
 * collapsed this corpus to 150 entities, fusing unrelated ones: garlic→Anthropic
 * (JW 0.704), Core→Cooc (0.733), PyTorch→Anthropic (0.657). These assertions pin
 * the fixed behavior; if they go red, the merger is fusing across entities again.
 */
const FIXTURE = path.join(__dirname, "__fixtures__", "telegram-sink.checkpoint.jsonl");
const PDF = "2605-22391"; // the Epicure paper's filename fragment

// Embeddings must not influence the regression: a throwing stub makes observation
// dedup a deterministic no-op (the merger keeps observations whose embedding failed).
const throwingEmbed = {
  embed: async () => {
    throw new Error("no embeddings in regression test");
  },
  embedBatch: async () => {
    throw new Error("no embeddings in regression test");
  },
} as any;

function loadChunkGraphs(): KnowledgeGraph[] {
  return fs
    .readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).kg as KnowledgeGraph);
}

function obsSources(e: Entity): string[] {
  return [
    ...new Set(
      (e.observations || [])
        .map((o) => (typeof o === "string" ? undefined : o.source))
        .filter((s): s is string => !!s)
        .map((s) => path.basename(s))
    ),
  ];
}

describe("KnowledgeMerger — telegram-sink regression (real checkpoint corpus)", () => {
  let merged: KnowledgeGraph;

  beforeAll(async () => {
    merged = await mergeKnowledgeGraphs(
      loadChunkGraphs(),
      // schema defaults
      { entitySimilarityThreshold: 0.9, observationSimilarityThreshold: 0.9 },
      throwingEmbed,
      stubLogger()
    );
  }, 120_000);

  it("keeps garlic as its own entity, with only PDF-sourced observations", () => {
    const garlic = merged.entities.find((e) => e.name === "garlic");
    expect(garlic).toBeDefined();
    for (const src of obsSources(garlic!)) {
      expect(src).toContain(PDF);
    }
  });

  it("keeps the Core model (the paper's middle sibling) as a PDF-sourced entity", () => {
    const core = merged.entities.filter((e) => /^(epicure-)?core( model)?$/i.test(e.name));
    expect(core.length).toBeGreaterThan(0);
    expect(core.some((e) => obsSources(e).some((s) => s.includes(PDF)))).toBe(true);
  });

  it("keeps Anthropic free of PDF observations (no garlic/PyTorch/FastICA fusion)", () => {
    const anthropic = merged.entities.find((e) => e.name === "Anthropic");
    expect(anthropic).toBeDefined();
    expect(obsSources(anthropic!).some((s) => s.includes(PDF))).toBe(false);
  });

  it("never mixes PDF and article observations inside one entity", () => {
    const mixed = merged.entities.filter((e) => {
      const sources = obsSources(e);
      return sources.some((s) => s.includes(PDF)) && sources.some((s) => !s.includes(PDF));
    });
    expect(mixed.map((e) => e.name)).toEqual([]);
  });

  it("keeps cross-file sharing to genuine same-name concepts", () => {
    // Calibrated post-fix: 3 (language models / AI systems / external memory shared
    // by the two AI articles). Headroom for legit drift, but far below fusion levels.
    const multiSource = merged.entities.filter((e) => obsSources(e).length > 1);
    expect(multiSource.length).toBeLessThanOrEqual(10);
  });

  it("lands in the calibrated entity-count band (1064 ± 10%)", () => {
    // Pre-fix the same corpus collapsed to 150 entities.
    expect(merged.entities.length).toBeGreaterThanOrEqual(950);
    expect(merged.entities.length).toBeLessThanOrEqual(1170);
  });

  it("keeps digit-distinguished names distinct (Table 1 ≠ Table 2)", () => {
    const names = new Set(merged.entities.map((e) => e.name));
    expect(names.has("Table 1")).toBe(true);
    expect(names.has("Table 2")).toBe(true);
  });
});
