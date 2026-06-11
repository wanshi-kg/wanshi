import { GroundingTransform } from "./GroundingTransform";
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

const graph: KnowledgeGraph = {
  entities: [
    { name: "alice", entityType: "person", files: [], observations: [] },
    { name: "acme", entityType: "organization", files: [], observations: [] },
  ],
  relations: [
    // endpoints co-occur in the span → kept
    { from: "alice", to: "acme", relationType: ["works_at"], sourceSpan: "Alice works at Acme." },
    // 'acme' absent from the span → dropped when enabled
    { from: "alice", to: "acme", relationType: ["founded"], sourceSpan: "Alice likes coffee." },
    // no span → kept (can't judge)
    { from: "alice", to: "acme", relationType: ["knows"] },
  ],
};

describe("GroundingTransform via PipelineRunner", () => {
  it("is OFF by default — the runner skips it and the graph passes through", async () => {
    const c = ctx({});
    const t = new GroundingTransform();
    expect(t.isEnabled(c)).toBe(false);
    const runner = new PipelineRunner([t], c);
    expect(runner.hasWork()).toBe(false);
    const out = await runner.run(graph);
    expect(out.relations).toHaveLength(3);
  });

  it("drops only edges whose endpoints don't co-occur in their span when enabled", async () => {
    const c = ctx({ pipeline: { grounding: { enabled: true } } });
    const runner = new PipelineRunner([new GroundingTransform()], c);
    expect(runner.hasWork()).toBe(true);
    const out = await runner.run(graph);
    // keeps the co-occurring edge + the span-less edge; drops the non-co-occurring one
    expect(out.relations.map((r) => r.relationType[0]).sort()).toEqual(["knows", "works_at"]);
  });

  it("requireCooccurrence:false makes it a no-op even when enabled", async () => {
    const c = ctx({ pipeline: { grounding: { enabled: true, requireCooccurrence: false } } });
    const out = await new GroundingTransform().apply(graph, c);
    expect(out.relations).toHaveLength(3);
  });
});
