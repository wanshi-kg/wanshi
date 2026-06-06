import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CorpusAnalyzer } from "./CorpusAnalyzer";
import { stubLogger } from "../../__tests__/helpers";
import { ProcessingOptions } from "../../types";

describe("CorpusAnalyzer", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgca-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const fileText: Record<string, string> = {
    "/corpus/a.txt": "Bayes Theorem Bayes Theorem probability probability inference",
    "/corpus/b.txt": "probability inference inference evidence prior posterior",
  };
  const files = Object.keys(fileText);

  const stubFactory = () =>
    ({
      getReader: (f: string) => ({
        read: async () => ({ chunks: [{ content: fileText[f] }] }),
      }),
    } as any);

  const stubClassifier = () =>
    ({
      classify: async () => [{ class: "research", confidence: 0.8 }],
    } as any);

  const stubLlm = (calls: { n: number }) =>
    ({
      generateStructured: async () => {
        calls.n += 1;
        return {
          entityNames: ["Bayes Theorem", "Bayes Theorem", " "],
          entityTypes: ["concept", "method"],
          relationTypes: ["assumes"],
        };
      },
      getModelCapabilities: async () => [],
    } as any);

  const makeOptions = (over: Partial<ProcessingOptions> = {}): ProcessingOptions =>
    ({
      input: "/corpus",
      output: path.join(tmp, "kg.json"),
      model: "m1",
      classifier: "llm",
      corpusProfiling: "enabled",
      corpusTopTerms: 50,
      ...over,
    } as any);

  it("builds a profile: top terms, aggregated class, cached per-file classes, glossary", async () => {
    const calls = { n: 0 };
    const analyzer = new CorpusAnalyzer(
      stubLlm(calls),
      stubClassifier(),
      stubFactory(),
      stubLogger()
    );

    const profile = await analyzer.analyzeOrLoad(files, makeOptions());

    expect(profile.fileCount).toBe(2);
    expect(profile.topTerms.length).toBeGreaterThan(0);
    expect(profile.topTerms.find((t) => t.term === "probability")?.count).toBe(3);
    expect(profile.corpusClasses[0].class).toBe("research");
    // per-file classes keyed by path-relative-to-input
    expect(profile.perFileClasses["a.txt"][0].class).toBe("research");
    expect(profile.perFileClasses["b.txt"]).toBeDefined();
    // glossary deduped + trimmed
    expect(profile.glossary.entityNames).toEqual(["Bayes Theorem"]);
    expect(profile.glossary.entityTypes).toEqual(["concept", "method"]);
    expect(calls.n).toBe(1);

    // sidecar written
    expect(fs.existsSync(path.join(tmp, "kg.json.corpus-profile.json"))).toBe(true);
  });

  it("reuses the cached profile on re-run without a second LLM call", async () => {
    const calls = { n: 0 };
    const analyzer = new CorpusAnalyzer(
      stubLlm(calls),
      stubClassifier(),
      stubFactory(),
      stubLogger()
    );

    await analyzer.analyzeOrLoad(files, makeOptions());
    expect(calls.n).toBe(1);

    // Second run, same corpus + model → cache hit, no glossary call.
    const again = await analyzer.analyzeOrLoad(files, makeOptions());
    expect(calls.n).toBe(1);
    expect(again.glossary.entityNames).toEqual(["Bayes Theorem"]);
  });

  it("rebuilds (new LLM call) when the model changes — stale key", async () => {
    const calls = { n: 0 };
    const analyzer = new CorpusAnalyzer(
      stubLlm(calls),
      stubClassifier(),
      stubFactory(),
      stubLogger()
    );

    await analyzer.analyzeOrLoad(files, makeOptions({ model: "m1" }));
    await analyzer.analyzeOrLoad(files, makeOptions({ model: "m2" }));
    expect(calls.n).toBe(2);
  });
});
