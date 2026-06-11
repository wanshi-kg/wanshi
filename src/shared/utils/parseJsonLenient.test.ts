import { parseJsonLenient } from "./parseJsonLenient";

describe("parseJsonLenient", () => {
  it("parses well-formed JSON without invoking the repair callback", () => {
    const onRepair = jest.fn();
    const out = parseJsonLenient('{"entities":[{"name":"garlic"}]}', onRepair);
    expect(out).toEqual({ entities: [{ name: "garlic" }] });
    expect(onRepair).not.toHaveBeenCalled();
  });

  it("repairs an unterminated string (the output-budget truncation class)", () => {
    const onRepair = jest.fn();
    // Model hit its token budget mid-string — the exact SyntaxError seen on big chunks.
    const truncated = '{"entities":[{"name":"garlic","observations":["an aromatic vegetable';
    const out = parseJsonLenient(truncated, onRepair) as any;
    expect(out.entities[0].name).toBe("garlic");
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("repairs dangling brackets / trailing commas", () => {
    const out = parseJsonLenient('{"relations":[{"from":"a","to":"b"},]') as any;
    expect(out.relations[0]).toEqual({ from: "a", to: "b" });
  });

  it("propagates when the content is unrepairable (e.g. an empty response)", () => {
    expect(() => parseJsonLenient("")).toThrow();
    expect(() => parseJsonLenient("   ")).toThrow();
  });
});
