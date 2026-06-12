import { PromptManager } from "./PromptManager";
import { stubLogger } from "../../../__tests__/helpers";

describe("PromptManager corpus glossary injection (v5 user prompt)", () => {
  const manager = () => new PromptManager(stubLogger());

  it("renders the authoritative corpus vocabulary block into the user prompt", async () => {
    const prompt = await manager().getUserPrompt({
      input: "",
      filter: "",
      fileName: "f.txt",
      fileContent: "some content",
      chunkContent: "some content",
      corpusGlossary: {
        entityNames: ["Bayes Theorem", "Naive Bayes Classifier"],
        entityTypes: ["theorem"],
        relationTypes: ["assumes"],
      },
    });

    expect(prompt).toContain("Corpus vocabulary (authoritative)");
    expect(prompt).toContain("Bayes Theorem");
    expect(prompt).toContain("Naive Bayes Classifier");
    expect(prompt).toContain("theorem");
    expect(prompt).toContain("assumes");
  });

  it("omits the vocabulary block when no glossary is supplied", async () => {
    const prompt = await manager().getUserPrompt({
      input: "",
      filter: "",
      fileName: "f.txt",
      fileContent: "some content",
      chunkContent: "some content",
    });
    expect(prompt).not.toContain("Corpus vocabulary");
  });

  it("omits the block for an empty glossary", async () => {
    const prompt = await manager().getUserPrompt({
      input: "",
      filter: "",
      fileName: "f.txt",
      fileContent: "some content",
      chunkContent: "some content",
      corpusGlossary: { entityNames: [], entityTypes: [], relationTypes: [] },
    });
    expect(prompt).not.toContain("Corpus vocabulary");
  });
});

describe("PromptManager v5 system prompt — controlled vocabularies", () => {
  const manager = () => new PromptManager(stubLogger());

  it("falls back to the base vocabulary when no glossary is supplied", async () => {
    const prompt = await manager().getSystemPrompt("/repo", "**/*.ts");
    // base entity + relation sets from the template {{else}} branches
    expect(prompt).toContain("data_structure");
    expect(prompt).toContain("has_attribute");
    // the working-directory token is interpolated, not the literal ${pwd}
    expect(prompt).toContain("/repo");
    expect(prompt).not.toContain("${pwd}");
  });

  it("interpolates the working directory in the legacy v4.5 prompt, not literal ${pwd} (KG-16)", async () => {
    const m = manager();
    m.setPromptVersion("v4.5");
    const prompt = await m.getSystemPrompt("/repo", "**/*.ts");
    expect(prompt).toContain("/repo");
    expect(prompt).not.toContain("${pwd}");
    expect(prompt).not.toContain("${filter}");
  });

  it("permits cross-file relation endpoints — no exact-match-only contradiction (KG-04)", async () => {
    const prompt = await manager().getSystemPrompt("/repo", "**/*.ts");
    // the old contract that contradicted user.hbs ("just point relations at them
    // by name") must be gone
    expect(prompt).not.toContain("must each match a `name` in `entities` exactly");
    // the new contract explicitly allows referencing established-in-context entities
    expect(prompt).toContain("already established in the provided context");
    expect(prompt).toContain("Link across files");
  });

  it("renders the glossary's types as the closed vocabulary when supplied", async () => {
    const prompt = await manager().getSystemPrompt("/repo", "**/*.ts", undefined, undefined, {
      entityNames: ["KnowledgeGraphBuilder"],
      entityTypes: ["service", "reader"],
      relationTypes: ["builds", "reads"],
    });
    expect(prompt).toContain("use these and only these");
    expect(prompt).toContain("service, reader");
    expect(prompt).toContain("builds, reads");
  });
});

describe("PromptManager.getGlossaryPrompt (v5 templates)", () => {
  const manager = () => new PromptManager(stubLogger());

  it("renders the versioned glossary system + user templates", async () => {
    const rendered = await manager().getGlossaryPrompt({
      classLine: "code (0.91)",
      termList: "logger (524), content (430)",
      snippets: "--- sample 1 ---\nexport class Foo {}",
    });
    expect(rendered).toBeDefined();
    expect(rendered!.system).toContain("controlled vocabulary");
    expect(rendered!.user).toContain("code (0.91)");
    expect(rendered!.user).toContain("logger (524)");
  });

  it("returns undefined for a version without glossary templates (e.g. v4.5)", async () => {
    const m = manager();
    m.setPromptVersion("v4.5");
    const rendered = await m.getGlossaryPrompt({
      classLine: "x",
      termList: "y",
      snippets: "z",
    });
    expect(rendered).toBeUndefined();
  });
});
