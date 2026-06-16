import { LineageRegistry, MentionRef } from "./lineage";

const ref = (name: string, extractionId: string, entityType = "concept"): MentionRef => ({
  mentionId: LineageRegistry.entityMentionId(extractionId, name),
  name,
  entityType,
  chunkId: extractionId.split("@")[0],
  extractionId,
  observationIds: [],
});

describe("LineageRegistry", () => {
  it("mints deterministic, reconstructable IDs", () => {
    expect(LineageRegistry.entityMentionId("f.md#0@0", "Qwen3")).toBe("f.md#0@0|e|Qwen3");
    expect(LineageRegistry.relationMentionId("f.md#0@0", "A", "B")).toBe("f.md#0@0|r|A>B");
    // observation id is stable for the same (name, text)
    const a = LineageRegistry.observationId("f.md#0@0", "Qwen3", "is a model");
    const b = LineageRegistry.observationId("f.md#0@0", "Qwen3", "is a model");
    expect(a).toBe(b);
    expect(a).not.toBe(LineageRegistry.observationId("f.md#0@0", "Qwen3", "different"));
  });

  it("keeps distinct mention instances for the same name across extractions", () => {
    const reg = new LineageRegistry();
    reg.registerEntity(ref("Qwen3", "f.md#0@0"));
    reg.registerEntity(ref("Qwen3", "f.md#3@0")); // same name, different chunk
    const mentions = reg.mentionsFor("Qwen3");
    expect(mentions).toHaveLength(2);
    expect(new Set(mentions.map((m) => m.mentionId)).size).toBe(2);
  });

  it("reassigns a folded name's mentions onto the canonical winner", () => {
    const reg = new LineageRegistry();
    reg.registerEntity(ref("Qwen3-0.6B", "f.md#0@0"));
    reg.registerEntity(ref("qwen3 0.6b", "g.md#1@0"));
    const folded = reg.fold("qwen3 0.6b", "Qwen3-0.6B");
    expect(folded).toHaveLength(1);
    // canonical now carries both mention instances; loser name is gone
    expect(reg.mentionsFor("Qwen3-0.6B")).toHaveLength(2);
    expect(reg.mentionsFor("qwen3 0.6b")).toHaveLength(0);
  });

  it("is a no-op fold when names are equal or loser unknown", () => {
    const reg = new LineageRegistry();
    reg.registerEntity(ref("A", "f.md#0@0"));
    expect(reg.fold("A", "A")).toEqual([]);
    expect(reg.fold("ghost", "A")).toEqual([]);
    expect(reg.mentionsFor("A")).toHaveLength(1);
  });
});
