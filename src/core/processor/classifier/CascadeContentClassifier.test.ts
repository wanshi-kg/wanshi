import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CascadeContentClassifier } from "./CascadeContentClassifier";
import { IContentClassifier } from "./IContentTypeClassifier";
import { ClassificationResult, ContentClass } from "../../../types";
import { activeDomainClasses } from "../../knowledge/vocabulary";
import { stubLogger } from "../../../__tests__/helpers";
import { trace } from "../../trace";

const dist = (entries: [ContentClass, number][]): ClassificationResult[] =>
  entries.map(([cls, confidence]) => ({ class: cls, confidence }));

const heuristicStub = (results: ClassificationResult[]): IContentClassifier => ({
  classify: async () => results,
});

function llmStub(pick: ContentClass) {
  const calls: string[] = [];
  const classifier: IContentClassifier = {
    classify: async (content) => {
      calls.push(content);
      return [{ class: pick, confidence: 0.99 }]; // confidence is intentionally ignored
    },
  };
  return { classifier, calls };
}

// top-2 tie (gate routes multi); decisive (single); flat (abstain)
const TIE = dist([
  ["code", 0.42],
  ["documentation", 0.34],
  ["narrative", 0.05],
]);
const DECISIVE = dist([["code", 0.8], ["documentation", 0.1]]);
const FLAT = dist([["code", 0.12], ["documentation", 0.1], ["narrative", 0.08]]);

describe("CascadeContentClassifier (Phase B)", () => {
  it("does not escalate a decisive result", async () => {
    const llm = llmStub("documentation");
    const cascade = new CascadeContentClassifier(
      heuristicStub(DECISIVE),
      llm.classifier,
      stubLogger()
    );
    const out = await cascade.classify("x", "f.ts");
    expect(llm.calls).toHaveLength(0);
    expect(activeDomainClasses(out)).toEqual(["code"]);
  });

  it("does not escalate an abstain (flat) result", async () => {
    const llm = llmStub("code");
    const cascade = new CascadeContentClassifier(
      heuristicStub(FLAT),
      llm.classifier,
      stubLogger()
    );
    const out = await cascade.classify("x", "f.txt");
    expect(llm.calls).toHaveLength(0);
    expect(activeDomainClasses(out)).toEqual([]);
  });

  it("escalates a tie and collapses to the LLM's pick (single domain)", async () => {
    const llm = llmStub("documentation");
    const cascade = new CascadeContentClassifier(
      heuristicStub(TIE),
      llm.classifier,
      stubLogger()
    );
    const out = await cascade.classify("x", "f.md");

    expect(llm.calls).toHaveLength(1);
    expect(activeDomainClasses(out)).toEqual(["documentation"]); // tie → single
    expect(out[0].class).toBe("documentation");
    expect(out[0].confidence).toBeCloseTo(0.76, 5); // absorbed 0.42 + 0.34
  });

  it("can resolve a tie in favor of the heuristic's own top class", async () => {
    const llm = llmStub("code");
    const cascade = new CascadeContentClassifier(
      heuristicStub(TIE),
      llm.classifier,
      stubLogger()
    );
    const out = await cascade.classify("x", "f.md");
    expect(activeDomainClasses(out)).toEqual(["code"]);
  });

  it("keeps heuristic-multi when the LLM picks outside the tied pair", async () => {
    const llm = llmStub("narrative"); // not in [code, documentation]
    const cascade = new CascadeContentClassifier(
      heuristicStub(TIE),
      llm.classifier,
      stubLogger()
    );
    const out = await cascade.classify("x", "f.md");
    expect(llm.calls).toHaveLength(1); // escalation attempted (counts against budget)
    expect(activeDomainClasses(out)).toEqual(["code", "documentation"]);
  });

  it("keeps heuristic-multi when the LLM throws", async () => {
    const llm: IContentClassifier = {
      classify: async () => {
        throw new Error("provider boom");
      },
    };
    const cascade = new CascadeContentClassifier(heuristicStub(TIE), llm, stubLogger());
    const out = await cascade.classify("x", "f.md");
    expect(activeDomainClasses(out)).toEqual(["code", "documentation"]);
  });

  it("falls through to multi when no LLM is wired", async () => {
    const cascade = new CascadeContentClassifier(heuristicStub(TIE), undefined, stubLogger());
    const out = await cascade.classify("x", "f.md");
    expect(activeDomainClasses(out)).toEqual(["code", "documentation"]);
  });

  it("respects the per-run escalation budget", async () => {
    const llm = llmStub("documentation");
    const cascade = new CascadeContentClassifier(
      heuristicStub(TIE),
      llm.classifier,
      stubLogger(),
      1 // budget = 1 escalation
    );
    const first = await cascade.classify("a", "f.md");
    const second = await cascade.classify("b", "f.md");

    expect(llm.calls).toHaveLength(1);
    expect(activeDomainClasses(first)).toEqual(["documentation"]); // escalated
    expect(activeDomainClasses(second)).toEqual(["code", "documentation"]); // budget spent
  });
});

// WS-38: the escalation trace must report the *post-collapse* gate (a resolved
// tie reads `single`, not the hardcoded `multi`) and emit exactly once.
describe("CascadeContentClassifier trace (WS-38)", () => {
  let tmp: string;
  let out: string;

  const readEvents = () =>
    fs
      .readFileSync(out, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgcascade-"));
    out = path.join(tmp, "graph.json.trace.jsonl");
    trace.reset();
  });

  afterEach(() => {
    trace.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports gate:single (post-collapse) and emits one classify event on a resolved tie", async () => {
    trace.configure({ enabled: true, path: out, runId: "r-cascade" });
    const llm = llmStub("documentation");
    const cascade = new CascadeContentClassifier(
      heuristicStub(TIE),
      llm.classifier,
      stubLogger()
    );
    await cascade.classify("x", "f.md");

    const events = readEvents();
    expect(events).toHaveLength(1); // not double-emitted
    expect(events[0].type).toBe("classification");
    expect(events[0].gate).toBe("single"); // was hardcoded "multi"
    expect(events[0].escalated).toBe(true);
    expect(events[0].activeClasses).toEqual(["documentation"]);
    expect((events[0].tieBreak as { pick: string }).pick).toBe("documentation");
  });

  it("reports gate:multi when the LLM pick is outside the tied pair (kept multi)", async () => {
    trace.configure({ enabled: true, path: out, runId: "r-cascade" });
    const llm = llmStub("narrative"); // not in [code, documentation]
    const cascade = new CascadeContentClassifier(
      heuristicStub(TIE),
      llm.classifier,
      stubLogger()
    );
    await cascade.classify("x", "f.md");

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].gate).toBe("multi"); // distribution unchanged → still multi
    expect(events[0].activeClasses).toEqual(["code", "documentation"]);
  });

  it("emits nothing when trace is off (default byte-identical path)", async () => {
    const llm = llmStub("documentation");
    const cascade = new CascadeContentClassifier(
      heuristicStub(TIE),
      llm.classifier,
      stubLogger()
    );
    await cascade.classify("x", "f.md");
    expect(fs.existsSync(out)).toBe(false);
  });
});
