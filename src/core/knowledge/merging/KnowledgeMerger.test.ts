import {
  mergeKnowledgeGraphs,
  canonicalizeRelationType,
  normalizeEntityName,
} from "./KnowledgeMerger";
import { MergeRecord } from "../MergeRecord";
import { JsonExportStrategy, McpExportStrategy } from "../../export/strategies";
import { KnowledgeGraph } from "../../../types";
import { stubLogger } from "../../../__tests__/helpers";

// Embeddings aren't exercised here (the two facts live in different provenance
// groups, so they're never compared), but the merger requires the dependency.
const stubEmbed = {
  embed: async () => [1, 0, 0],
  embedBatch: async (xs: string[]) => xs.map(() => [1, 0, 0]),
} as any;

const opts = {
  entitySimilarityThreshold: 0.9,
  observationSimilarityThreshold: 0.7,
};

describe("KnowledgeMerger — provenance & bi-temporal", () => {
  it("keeps per-source attribution: two sources asserting one fact → two observations", async () => {
    const g1: KnowledgeGraph = {
      entities: [
        {
          name: "Sky",
          entityType: "concept",
          files: ["A.txt"],
          observations: [
            {
              text: "the sky is blue",
              source: "A.txt",
              speaker: "alice",
              createdAt: "2026-01-01T00:00:00Z",
              validAt: "2025-12-01T00:00:00Z",
            },
          ],
        },
      ],
      relations: [],
    };
    const g2: KnowledgeGraph = {
      entities: [
        {
          name: "Sky",
          entityType: "concept",
          files: ["B.txt"],
          observations: [
            {
              text: "the sky is blue",
              source: "B.txt",
              speaker: "bob",
              createdAt: "2026-01-02T00:00:00Z",
            },
          ],
        },
      ],
      relations: [],
    };

    const merged = await mergeKnowledgeGraphs([g1, g2], opts, stubEmbed, stubLogger());

    const sky = merged.entities.find((e) => e.name === "Sky");
    expect(sky).toBeDefined();
    // one merged entity, but the identical fact from two sources is NOT flattened
    expect(sky!.observations).toHaveLength(2);
    expect(sky!.observations.map((o) => o.source).sort()).toEqual(["A.txt", "B.txt"]);
    expect(sky!.observations.map((o) => o.speaker).sort()).toEqual(["alice", "bob"]);
    // bi-temporal fields preserved through merge
    expect(sky!.observations.some((o) => o.validAt === "2025-12-01T00:00:00Z")).toBe(true);
    expect(sky!.observations.every((o) => !!o.createdAt)).toBe(true);

    // ...and survive a JSON round-trip
    const parsed = JSON.parse(new JsonExportStrategy().export(merged)) as KnowledgeGraph;
    const skyJson = parsed.entities.find((e) => e.name === "Sky")!;
    expect(skyJson.observations).toHaveLength(2);
    expect(skyJson.observations.every((o) => !!o.source && !!o.createdAt)).toBe(true);

    // MCP export downgrades to bare strings (memory-server compatible) but keeps text
    const mcp = new McpExportStrategy().export(merged);
    expect(mcp).toContain("the sky is blue");
    expect(mcp).toContain('"type":"entity"');
  });
});

describe("canonicalizeRelationType", () => {
  it("trims, lowercases, de-dupes and sorts so reversed twins collapse", () => {
    expect(canonicalizeRelationType(["uses", "calls"])).toEqual(["calls", "uses"]);
    expect(canonicalizeRelationType(["calls", "uses"])).toEqual(["calls", "uses"]);
    expect(canonicalizeRelationType([" Uses ", "USES", "uses"])).toEqual(["uses"]);
    expect(canonicalizeRelationType([])).toEqual([]);
  });
});

// Entity factory shared by the guard/rename tests below.
const mkEnt = (name: string, entityType = "concept", file = "A.txt") => ({
  name,
  entityType,
  files: [file],
  observations: [{ text: `${name} fact`, source: file, createdAt: "2026-01-01T00:00:00Z" }],
});

describe("KnowledgeMerger — merge guards (the garlic↔Anthropic class)", () => {
  it("does NOT fuse dissimilar same-file names (garlic vs Anthropic, JW 0.704)", async () => {
    const g: KnowledgeGraph = {
      entities: [mkEnt("Anthropic", "organization"), mkEnt("garlic", "concept")],
      relations: [],
    };

    const merged = await mergeKnowledgeGraphs([g], opts, stubEmbed, stubLogger());

    expect(merged.entities.map((e) => e.name).sort()).toEqual(["Anthropic", "garlic"]);
  });

  it("digit guard: Table 1 / Table 2 stay distinct even at an absurdly low threshold", async () => {
    const g: KnowledgeGraph = {
      entities: [mkEnt("Table 1"), mkEnt("Table 2")],
      relations: [],
    };

    const merged = await mergeKnowledgeGraphs(
      [g],
      { ...opts, entitySimilarityThreshold: 0.5 },
      stubEmbed,
      stubLogger()
    );

    expect(merged.entities).toHaveLength(2);
  });

  it("normalized-exact path: black_pepper and black pepper merge", async () => {
    const g: KnowledgeGraph = {
      entities: [mkEnt("black_pepper"), mkEnt("black pepper")],
      relations: [],
    };

    const merged = await mergeKnowledgeGraphs([g], opts, stubEmbed, stubLogger());

    expect(merged.entities).toHaveLength(1);
    expect(merged.entities[0].name).toBe("black_pepper"); // first-seen surface form wins
  });

  it("cross-type fuzzy matches need near-exact similarity (South Asian ≠ Southeast Asian)", async () => {
    const g: KnowledgeGraph = {
      entities: [mkEnt("Southeast Asian", "concept"), mkEnt("South Asian", "location")],
      relations: [],
    };

    // JW ≈ 0.90 — above the 0.9 name threshold but below the cross-type bar.
    const merged = await mergeKnowledgeGraphs(
      [g],
      { ...opts, entitySimilarityThreshold: 0.85 },
      stubEmbed,
      stubLogger()
    );

    expect(merged.entities).toHaveLength(2);
  });

  it("enableSimilarityMerging: false ⇒ only exact matches merge", async () => {
    const g: KnowledgeGraph = {
      entities: [mkEnt("GMM partitioning"), mkEnt("GMM partition"), mkEnt("gmm_partitioning")],
      relations: [],
    };

    const merged = await mergeKnowledgeGraphs(
      [g],
      { ...opts, enableSimilarityMerging: false },
      stubEmbed,
      stubLogger()
    );

    // exact-normalized pair collapses, the fuzzy variant survives
    expect(merged.entities.map((e) => e.name).sort()).toEqual([
      "GMM partition",
      "GMM partitioning",
    ]);
  });

  it("emits a merge-log record per fusion of distinct surface forms", async () => {
    const records: MergeRecord[] = [];
    const g: KnowledgeGraph = {
      entities: [mkEnt("black_pepper"), mkEnt("black pepper"), mkEnt("garlic")],
      relations: [],
    };

    await mergeKnowledgeGraphs(
      [g],
      { ...opts, onMergeRecord: (r) => records.push(r) },
      stubEmbed,
      stubLogger()
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      target: "entity",
      method: "string-exact",
      canonical_chosen: "black_pepper",
      surface_forms: ["black_pepper", "black pepper"],
    });
  });
});

describe("normalizeEntityName", () => {
  it("unifies case, underscores, hyphens and whitespace runs", () => {
    expect(normalizeEntityName("Black_Pepper")).toBe("black pepper");
    expect(normalizeEntityName("soft-NMI")).toBe("soft nmi");
    expect(normalizeEntityName("  Foo   Bar ")).toBe("foo bar");
  });
});

describe("KnowledgeMerger — relation re-keying via rename map", () => {
  it("relation endpoints follow merged entities; unextracted endpoints drop the relation", async () => {
    const g: KnowledgeGraph = {
      entities: [mkEnt("black_pepper"), mkEnt("black pepper"), mkEnt("Cooc")],
      relations: [
        { from: "Cooc", to: "black pepper", relationType: ["contains"] },
        // endpoint never extracted as an entity → dropped, NOT fuzzily rebound
        { from: "Cooc", to: "blck peppr", relationType: ["contains"] },
      ],
    };

    const merged = await mergeKnowledgeGraphs([g], opts, stubEmbed, stubLogger());

    expect(merged.relations).toHaveLength(1);
    expect(merged.relations[0]).toMatchObject({ from: "Cooc", to: "black_pepper" });
  });
});

describe("KnowledgeMerger — relation hygiene (cheap wins)", () => {
  const ent = (name: string) => ({
    name,
    entityType: "concept",
    files: ["A.txt"],
    observations: [{ text: `${name} fact`, source: "A.txt", createdAt: "2026-01-01T00:00:00Z" }],
  });

  it("drops self-loops and collapses reversed-twin predicates", async () => {
    const g: KnowledgeGraph = {
      entities: [ent("Foo"), ent("Bar")],
      relations: [
        { from: "Foo", to: "Foo", relationType: ["uses"] }, // self-loop → dropped
        { from: "Foo", to: "Bar", relationType: ["uses", "calls"] },
        { from: "Foo", to: "Bar", relationType: ["calls", "uses"] }, // reversed twin → collapses
        { from: "Bar", to: "Foo", relationType: ["implements"] }, // distinct direction survives
      ],
    };

    const merged = await mergeKnowledgeGraphs([g], opts, stubEmbed, stubLogger());

    expect(merged.relations.some((r) => r.from === r.to)).toBe(false);
    const fooBar = merged.relations.filter((r) => r.from === "Foo" && r.to === "Bar");
    expect(fooBar).toHaveLength(1);
    expect(fooBar[0].relationType).toEqual(["calls", "uses"]);
    // the genuinely distinct Bar→Foo edge is kept
    expect(merged.relations.some((r) => r.from === "Bar" && r.to === "Foo")).toBe(true);
    expect(merged.relations).toHaveLength(2);
  });
});
