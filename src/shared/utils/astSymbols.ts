import {
  SymbolEntry,
  SymbolReference,
  SymbolTable,
  SymbolKind,
  hashContent,
} from "@wanshi-kg/outlion";

export { hashContent };
export type { SymbolEntry, SymbolReference, SymbolTable, SymbolKind };

/**
 * Mapping tables + filters for the AST symbol seed (Phase 8). Per the locked
 * decision, every target type/predicate is an **existing** Phase-2 vocabulary
 * member (`src/core/knowledge/vocabulary.ts`) — no `vocabulary.ts` / `system.hbs`
 * extension — so seeded nodes/edges validate against the closed enum.
 */

/** Structural definitions — always seeded as entities. */
export const DEFINITION_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  "module",
  "namespace",
  "class",
  "struct",
  "interface",
  "trait",
  "enum",
  "type_alias",
  "function",
  "method",
  "constructor",
]);

/** Fine-grained members — seeded only when `exported` (public surface; locals are noise). */
export const MEMBER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  "field",
  "property",
  "variable",
  "constant",
  "enum_member",
]);

/** `SymbolKind` → an existing `BASE_ENTITY_TYPE`. */
export const SYMBOL_KIND_TO_ENTITY_TYPE: Record<SymbolKind, string> = {
  module: "module",
  namespace: "module",
  class: "class",
  struct: "class",
  interface: "interface",
  trait: "interface",
  enum: "data_structure",
  type_alias: "data_structure",
  function: "function",
  method: "function",
  constructor: "function",
  field: "term",
  property: "term",
  variable: "term",
  constant: "term",
  enum_member: "term",
};

/** `SymbolReference.kind` → an existing `BASE_RELATION_TYPE` predicate. */
export const REFERENCE_KIND_TO_PREDICATE: Record<SymbolReference["kind"], string> = {
  calls: "calls",
  imports: "depends_on",
};

/** The marker the Symbol API uses for a reference `from` at file/module top level. */
export const MODULE_MARKER = "<module>";

/** Seed definitions always; members only when exported (covers all 16 kinds). */
export function shouldSeedSymbol(symbol: SymbolEntry): boolean {
  if (DEFINITION_KINDS.has(symbol.kind)) return true;
  if (MEMBER_KINDS.has(symbol.kind)) return symbol.exported;
  return false;
}
