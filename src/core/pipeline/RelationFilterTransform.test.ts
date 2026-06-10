import { RelationFilterTransform } from "./RelationFilterTransform";
import { PipelineRunner, TransformContext } from "./PipelineRunner";
import { parseConfig } from "../../config";
import { KnowledgeGraph } from "../../types/KnowledgeGraph";

function ctx(partial: any): TransformContext {
  return {
    options: parseConfig(partial),
    embeddings: {} as any,
    llm: {} as any,
    logger: { info() {}, debug() {}, warn() {}, error() {} } as any,
  };
}

const ent = (name: string) => ({ name, entityType: "concept", files: [], observations: [] });

const graph: KnowledgeGraph = {
  entities: [ent("salsa"), ent("chicken"), ent("garlic"), ent("Cooc")],
  relations: [
    // typed edge — always kept
    { from: "garlic", to: "chicken", relationType: ["pairs_with"] },
    // related_to whose pair ALSO has the typed edge above → redundant
    { from: "garlic", to: "chicken", relationType: ["related_to"] },
    // related_to with no typed twin → kept under `redundant`, dropped under `all`
    { from: "salsa", to: "chicken", relationType: ["related_to"] },
    { from: "Cooc", to: "salsa", relationType: ["related_to"] },
  ],
};

describe("RelationFilterTransform via PipelineRunner", () => {
  it("is OFF by default — runner skips it, graph passes through", async () => {
    const c = ctx({});
    const t = new RelationFilterTransform();
    expect(t.isEnabled(c)).toBe(false);
    const runner = new PipelineRunner([t], c);
    expect(runner.hasWork()).toBe(false);
    const out = await runner.run(graph);
    expect(out.relations).toHaveLength(4);
  });

  it("mode 'redundant' drops only related_to edges that have a typed twin", async () => {
    const c = ctx({ pipeline: { relationFilter: { mode: "redundant" } } });
    const out = await new RelationFilterTransform().apply(graph, c);
    // drops garlic→chicken related_to (typed twin exists); keeps the 2 twin-less ones + typed
    expect(out.relations).toHaveLength(3);
    expect(out.relations.some((r) => r.from === "garlic" && r.relationType[0] === "related_to")).toBe(false);
    expect(out.relations.some((r) => r.from === "salsa" && r.relationType[0] === "related_to")).toBe(true);
  });

  it("mode 'all' drops every related_to edge, keeping typed edges", async () => {
    const c = ctx({ pipeline: { relationFilter: { mode: "all" } } });
    const out = await new RelationFilterTransform().apply(graph, c);
    expect(out.relations).toHaveLength(1);
    expect(out.relations[0].relationType).toEqual(["pairs_with"]);
  });
});
