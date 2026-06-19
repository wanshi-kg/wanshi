import { mergeKnowledgeGraphs } from "./KnowledgeMerger";
import { JsonExportStrategy, McpExportStrategy } from "../../export/strategies";
import { KnowledgeGraph } from "../../../types";
import { stubLogger } from "../../../__tests__/helpers";

// The two facts live in different provenance groups, so dedup never compares
// them; embeddings aren't exercised but the merger requires the dependency.
const stubEmbed = {
  embed: async () => [1, 0, 0],
  embedBatch: async (xs: string[]) => xs.map(() => [1, 0, 0]),
} as any;

const opts = { entitySimilarityThreshold: 0.9, observationSimilarityThreshold: 0.7 };

// A confidence-bearing observation (à la the EXIF/C2PA image-metadata fragments).
const graph = (file: string, conf: number): KnowledgeGraph => ({
  entities: [
    {
      name: "photo.jpg",
      entityType: "image",
      files: [file],
      observations: [{ text: `Captured by Canon EOS R5`, source: file, sourceAdapter: "exif", confidence: conf }],
    },
  ],
  relations: [],
});

describe("Observation.confidence — survives merge + exports", () => {
  it("is preserved through a hierarchical merge", async () => {
    // Same entity name from two sources → both observations kept (distinct provenance).
    const merged = await mergeKnowledgeGraphs([graph("a.jpg", 0.9), graph("b.jpg", 0.42)], opts, stubEmbed, stubLogger());
    const photo = merged.entities.find((e) => e.name === "photo.jpg");
    expect(photo).toBeDefined();
    const confs = photo!.observations.map((o) => o.confidence).sort();
    expect(confs).toEqual([0.42, 0.9]);
    expect(photo!.observations.every((o) => o.sourceAdapter === "exif")).toBe(true);
  });

  it("passes through the JSON export and is dropped (bare string) by MCP", () => {
    const g = graph("a.jpg", 0.9);
    const json = JSON.parse(new JsonExportStrategy().export(g));
    expect(json.entities[0].observations[0].confidence).toBe(0.9);

    const mcp = new McpExportStrategy().export(g);
    const entityLine = mcp.split("\n").map((l) => JSON.parse(l)).find((r) => r.name === "photo.jpg");
    // MCP downgrades observations to bare strings — confidence is intentionally gone.
    expect(typeof entityLine.observations[0]).toBe("string");
    expect(entityLine.observations[0]).toContain("Canon EOS R5");
  });
});
