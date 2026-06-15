import * as fs from "fs";
import * as path from "path";
import {
  BASE_ENTITY_TYPES,
  BASE_RELATION_TYPES,
  allowedEntityTypes,
  allowedRelationTypes,
} from "./vocabulary";
import { ContentClass } from "../../types";

// Pinned copy of PromptManager.CLASS_TO_PARTIAL — the test asserts the contract
// that every routed example file teaches only enum-legal types/predicates. If the
// routing map changes, this copy must change with it (a deliberate tripwire).
const CLASS_TO_PARTIAL: Record<ContentClass, string> = {
  code: "code.md",
  financial: "financial.md",
  medical: "medical.md",
  legal: "legal.md",
  technical: "logs.md",
  research: "research.md",
  transcript: "transcript.md",
  tabular: "tabular.md",
  communication: "communication.md",
  documentation: "documentation.md",
  narrative: "article.md",
  reference: "notes.md",
};

const EXAMPLES_DIR = path.join(
  __dirname,
  "../llm/prompts/templates/partials/examples"
);
const SYSTEM_HBS = path.join(
  __dirname,
  "../llm/prompts/templates/v5/system.hbs"
);

/** Invert CLASS_TO_PARTIAL → which classes route to a given example file. */
function partialToClasses(): Map<string, ContentClass[]> {
  const map = new Map<string, ContentClass[]>();
  for (const [cls, file] of Object.entries(CLASS_TO_PARTIAL)) {
    const list = map.get(file) ?? [];
    list.push(cls as ContentClass);
    map.set(file, list);
  }
  return map;
}

/** Extract every `{entities,relations}` JSON block from an example markdown file. */
function parseExampleGraphs(md: string): {
  entityTypes: string[];
  relationTypes: string[];
} {
  const entityTypes: string[] = [];
  const relationTypes: string[] = [];
  const fence = /```json\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(md))) {
    let parsed: any;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue; // a non-graph json block (rare); skip
    }
    if (!parsed || (!parsed.entities && !parsed.relations)) continue;
    for (const e of parsed.entities ?? []) {
      if (e.entityType) entityTypes.push(e.entityType);
    }
    for (const r of parsed.relations ?? []) {
      for (const t of r.relationType ?? []) relationTypes.push(t);
    }
  }
  return { entityTypes, relationTypes };
}

/** Pull a fenced (```) block that immediately follows a marker string. */
function fencedBlockAfter(hbs: string, marker: string): string[] {
  const start = hbs.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const fenceStart = hbs.indexOf("```", start);
  const fenceEnd = hbs.indexOf("```", fenceStart + 3);
  return hbs
    .slice(fenceStart + 3, fenceEnd)
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("gold example partials ⊆ active enum (KG-05)", () => {
  const routing = partialToClasses();
  const files = fs
    .readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".md") && f !== "EXAMPLE_STYLE_GUIDE.md");

  it.each(files)(
    "%s teaches only types/predicates inside its domain's enum",
    (file) => {
      const classes = routing.get(file) ?? [];
      // Every example file must be reachable via CLASS_TO_PARTIAL, else it can
      // teach an unconstrained vocabulary that never matches a runtime enum.
      expect(classes.length).toBeGreaterThan(0);

      const allowedEnt = new Set<string>();
      const allowedRel = new Set<string>();
      for (const cls of classes) {
        const probe = [{ class: cls, confidence: 1 }];
        allowedEntityTypes(probe).forEach((t) => allowedEnt.add(t));
        allowedRelationTypes(probe).forEach((t) => allowedRel.add(t));
      }

      const md = fs.readFileSync(path.join(EXAMPLES_DIR, file), "utf-8");
      const { entityTypes, relationTypes } = parseExampleGraphs(md);

      const badEntityTypes = [...new Set(entityTypes)].filter(
        (t) => !allowedEnt.has(t)
      );
      const badRelationTypes = [...new Set(relationTypes)].filter(
        (t) => !allowedRel.has(t)
      );

      expect({ file, badEntityTypes, badRelationTypes }).toEqual({
        file,
        badEntityTypes: [],
        badRelationTypes: [],
      });
    }
  );
});

describe("v5 system.hbs base lists stay in sync with BASE_* (KG-05)", () => {
  const hbs = fs.readFileSync(SYSTEM_HBS, "utf-8");

  it("the {{else}} entity base list equals BASE_ENTITY_TYPES", () => {
    expect(fencedBlockAfter(hbs, "**Entity types.**")).toEqual(
      BASE_ENTITY_TYPES
    );
  });

  it("the {{else}} relation base list equals BASE_RELATION_TYPES", () => {
    expect(fencedBlockAfter(hbs, "**Relation predicates.**")).toEqual(
      BASE_RELATION_TYPES
    );
  });
});
