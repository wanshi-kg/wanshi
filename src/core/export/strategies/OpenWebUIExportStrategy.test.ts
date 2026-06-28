import { OpenWebUIExportStrategy } from "./OpenWebUIExportStrategy";
import { KnowledgeGraph } from "../../../types/KnowledgeGraph";

const graph: KnowledgeGraph = {
  entities: [
    {
      name: "knowledge_graph_builder",
      entityType: "class",
      files: ["src/core/knowledge/KnowledgeGraphBuilder.ts"],
      observations: [
        {
          text: "Extracts entities and relations from file content using an LLM",
          source: "src/core/knowledge/KnowledgeGraphBuilder.ts",
          createdAt: "2026-06-05T15:57:59.856Z",
        },
        { text: "Validates output against a Zod schema" } as any,
      ],
    },
    {
      name: "ollama_service",
      entityType: "class",
      files: [],
      observations: [{ text: "Talks to the local Ollama server" } as any],
    },
  ],
  relations: [
    {
      from: "knowledge_graph_builder",
      to: "ollama_service",
      relationType: ["uses", "depends_on"],
    },
  ],
};

describe("OpenWebUIExportStrategy", () => {
  const strat = new OpenWebUIExportStrategy();

  it("declares the openwebui format", () => {
    expect(strat.getFormat()).toBe("openwebui");
    expect(strat.supportsFormat("openwebui")).toBe(true);
    expect(strat.supportsFormat("json")).toBe(false);
  });

  it("emits one markdown doc per entity plus the oikb helper files", () => {
    const files = strat.exportFiles(graph);
    const paths = files.map((f) => f.path).sort();

    expect(paths).toContain("knowledge_graph_builder.md");
    expect(paths).toContain("ollama_service.md");
    expect(paths).toContain("README.md");
    expect(paths).toContain(".oikb.yaml");
    expect(paths).toContain(".oikbignore");
    // 2 entities + 3 helpers
    expect(files).toHaveLength(5);
  });

  it("renders type, facts with provenance, and relations in an entity doc", () => {
    const files = strat.exportFiles(graph);
    const doc = files.find((f) => f.path === "knowledge_graph_builder.md")!.content;

    expect(doc).toContain("# knowledge_graph_builder");
    expect(doc).toContain("**Type:** class");
    expect(doc).toContain("## Facts");
    expect(doc).toContain("Extracts entities and relations from file content using an LLM");
    // inline provenance surfaced for RAG
    expect(doc).toContain("source: src/core/knowledge/KnowledgeGraphBuilder.ts");
    expect(doc).toContain("## Relations");
    expect(doc).toContain("**uses, depends_on** → ollama_service");

    // the target entity sees the incoming edge
    const target = files.find((f) => f.path === "ollama_service.md")!.content;
    expect(target).toContain("knowledge_graph_builder **uses, depends_on** →");
  });

  it("excludes README.md from the synced set via .oikbignore", () => {
    const files = strat.exportFiles(graph);
    const ignore = files.find((f) => f.path === ".oikbignore")!.content;
    expect(ignore).toContain("README.md");
    const yaml = files.find((f) => f.path === ".oikb.yaml")!.content;
    expect(yaml).toContain("kb-id: REPLACE_WITH_KB_ID");
  });

  it("gives colliding entity names distinct, filesystem-safe slugs", () => {
    const g: KnowledgeGraph = {
      entities: [
        { name: "Foo Bar", entityType: "x", files: [], observations: [] },
        { name: "foo/bar", entityType: "x", files: [], observations: [] },
      ],
      relations: [],
    };
    const docs = strat
      .exportFiles(g)
      .filter((f) => f.path.endsWith(".md") && f.path !== "README.md")
      .map((f) => f.path);
    expect(docs).toContain("foo-bar.md");
    expect(docs).toContain("foo-bar-2.md");
    docs.forEach((p) => expect(p).not.toMatch(/[/\\]/));
  });

  it("empty graph → just the helper files", () => {
    const files = strat.exportFiles({ entities: [], relations: [] });
    expect(files.map((f) => f.path).sort()).toEqual(
      [".oikb.yaml", ".oikbignore", "README.md"].sort()
    );
  });

  it("export() falls back to a single bundled markdown", () => {
    const md = strat.export(graph);
    expect(md).toContain("# knowledge_graph_builder");
    expect(md).toContain("# ollama_service");
    expect(md).toContain("\n---\n");
  });
});
