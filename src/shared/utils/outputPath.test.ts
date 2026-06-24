import { resolveOutputPath } from "./outputPath";

describe("resolveOutputPath (sidecar base — WS-59 / KG-11 root cause)", () => {
  it("is a no-op when the extension already matches the format (default run stays byte-identical)", () => {
    expect(resolveOutputPath("knowledge-graph.json", "json")).toBe(
      "knowledge-graph.json"
    );
    expect(resolveOutputPath("out/g.jsonl", "jsonl")).toBe("out/g.jsonl");
  });

  it("rewrites the extension to the export format so sidecars hang off the real graph path", () => {
    // --output kg.json --export-format jsonl → graph is written to kg.jsonl,
    // so the trace/cost sidecars must base off kg.jsonl, not kg.json.
    expect(resolveOutputPath("kg.json", "jsonl")).toBe("kg.jsonl");
    expect(resolveOutputPath("a/b/graph.json", "dot")).toBe("a/b/graph.dot");
  });

  it("handles a mcp-jsonl format suffix (dotted format string)", () => {
    expect(resolveOutputPath("kg.json", "mcp-jsonl")).toBe("kg.mcp-jsonl");
    expect(resolveOutputPath("kg.mcp-jsonl", "mcp-jsonl")).toBe("kg.mcp-jsonl");
  });
});
