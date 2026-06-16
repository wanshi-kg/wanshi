import { zodToJsonSchema } from "zod-to-json-schema";
import { buildGraphSchema } from "./KnowledgeGraphBuilder";

const TYPES = ["class", "function", "other"];
const RELS = ["uses", "calls", "related_to"];

describe("buildGraphSchema lenient enum coercion (recall guard)", () => {
  const schema = buildGraphSchema(TYPES, RELS);

  it("coerces an out-of-vocab relationType onto related_to instead of discarding the chunk", () => {
    const out: any = schema.parse({
      entities: [{ name: "A", entityType: "class", observations: ["x"] }],
      relations: [{ from: "A", to: "B", relationType: ["returns"] }], // 'returns' ∉ RELS
    });
    expect(out.relations[0].relationType).toEqual(["related_to"]);
    expect(out.entities).toHaveLength(1); // the rest of the chunk survives
  });

  it("coerces an out-of-vocab entityType onto other", () => {
    const out: any = schema.parse({
      entities: [{ name: "B", entityType: "gizmo" }], // 'gizmo' ∉ TYPES; no observations → []
      relations: [],
    });
    expect(out.entities[0].entityType).toBe("other");
    expect(out.entities[0].observations).toEqual([]);
  });

  it("passes valid vocab through unchanged and still coerces scalar relationType → array", () => {
    const out: any = schema.parse({
      entities: [{ name: "A", entityType: "function", observations: [] }],
      relations: [{ from: "A", to: "B", relationType: "uses" }], // scalar, valid
    });
    expect(out.entities[0].entityType).toBe("function");
    expect(out.relations[0].relationType).toEqual(["uses"]);
  });

  it("keeps the enum in the emitted JSON schema (model guidance is preserved despite .catch)", () => {
    const js = JSON.stringify(zodToJsonSchema(schema));
    expect(js).toContain("related_to");
    expect(js).toContain("function");
  });

  it("falls back to a free string when no vocab is supplied (legacy prompt versions)", () => {
    const open = buildGraphSchema();
    const out: any = open.parse({
      entities: [{ name: "X", entityType: "anything-goes" }],
      relations: [{ from: "X", to: "Y", relationType: ["whatever"] }],
    });
    expect(out.entities[0].entityType).toBe("anything-goes");
    expect(out.relations[0].relationType).toEqual(["whatever"]);
  });
});
