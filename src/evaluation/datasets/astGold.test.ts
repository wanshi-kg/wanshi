import { extractCodeGold, isCodeSupported } from "./astGold";

const PY = `
import os
from flask.helpers import url_for

def greet(name):
    return os.path.join("/", name)

class App:
    def run(self):
        greet("world")
        url_for("index")
`;

describe("astGold (code oracle)", () => {
  it("reports JS/TS/Python supported and C unsupported", () => {
    expect(isCodeSupported("py")).toBe(true);
    expect(isCodeSupported("ts")).toBe(true);
    // outlion has no references grammar for C → cannot produce a relation gold.
    expect(isCodeSupported("c")).toBe(false);
  });

  it("derives import (depends_on) + call edges from Python source", async () => {
    const { symbols, triples } = await extractCodeGold(PY, "py", "mod.py");

    expect(symbols).toEqual(expect.arrayContaining(["greet", "App", "run"]));

    // imports → depends_on, subject = the module node
    expect(triples).toEqual(
      expect.arrayContaining([
        { subject: "mod.py", predicate: "depends_on", object: "os" },
        { subject: "mod.py", predicate: "depends_on", object: "flask.helpers" },
      ]),
    );
    // calls resolve the enclosing symbol's qualified name to its simple name (App.run → run)
    expect(triples).toEqual(
      expect.arrayContaining([
        { subject: "greet", predicate: "calls", object: "join" },
        { subject: "run", predicate: "calls", object: "greet" },
        { subject: "run", predicate: "calls", object: "url_for" },
      ]),
    );

    // only the two structural predicates, no self-loops, no dups
    expect(new Set(triples.map((t) => t.predicate))).toEqual(new Set(["calls", "depends_on"]));
    for (const t of triples) expect(t.subject).not.toBe(t.object);
    expect(new Set(triples.map((t) => `${t.subject}|${t.predicate}|${t.object}`)).size).toBe(triples.length);
  });

  it("returns empty gold for an unsupported extension", async () => {
    expect(await extractCodeGold("int main(){}", "c", "m.c")).toEqual({ symbols: [], triples: [] });
  });
});
