import { KnowledgeGraph, Entity, Relation } from "../../../types/KnowledgeGraph";
import { Observation, obsText, normalizeObservations } from "../../../types/Observation";
import { ExportFile } from "../../../types/IKnowledgeGraphExporter";
import { ProcessingOptions } from "../../../types/ProcessingOptions";
import { IExportStrategy } from "./IExportStrategy";

/**
 * Export the graph as a folder of per-entity markdown documents, ready to sync
 * into an OpenWebUI knowledge base.
 *
 * OpenWebUI's "knowledge" is a RAG document store — it chunks + embeds documents,
 * with no native graph/triple import. Its official `oikb` tool syncs a local
 * folder with per-file SHA-256 diffing, so **one markdown document per entity**
 * means re-running wanshi re-embeds only the entities that changed (a single
 * bundled file would re-embed the whole graph).
 *
 * `exportFiles()` writes the folder:
 *   <output>/<entity-slug>.md   one retrievable doc per entity (these sync)
 *   <output>/README.md          how to sync via oikb            (excluded from sync)
 *   <output>/.oikb.yaml         starter oikb daemon config      (hidden -> skipped)
 *   <output>/.oikbignore        keeps README.md out of the KB   (hidden -> skipped)
 *
 * `export()` is a single-string fallback: the whole graph as one bundled markdown.
 */
export class OpenWebUIExportStrategy implements IExportStrategy {
  getFormat(): string {
    return "openwebui";
  }

  supportsFormat(format: string): boolean {
    return format === "openwebui";
  }

  /** Single-string fallback — the whole graph as one bundled markdown document. */
  export(graph: KnowledgeGraph, _processingOptions?: ProcessingOptions): string {
    return (graph.entities ?? [])
      .map((e) => this.renderEntity(e, graph))
      .join("\n\n---\n\n");
  }

  /** The folder layout — one document per entity + the oikb helper files. */
  exportFiles(graph: KnowledgeGraph, _processingOptions?: ProcessingOptions): ExportFile[] {
    const used = new Set<string>();
    const files: ExportFile[] = (graph.entities ?? []).map((entity) => ({
      path: `${this.slug(entity.name, used)}.md`,
      content: this.renderEntity(entity, graph),
    }));

    files.push({ path: "README.md", content: README });
    files.push({ path: ".oikb.yaml", content: OIKB_YAML });
    files.push({ path: ".oikbignore", content: OIKBIGNORE });
    return files;
  }

  /** Render one entity as a self-contained, retrievable markdown document. */
  private renderEntity(entity: Entity, graph: KnowledgeGraph): string {
    const lines: string[] = [`# ${entity.name}`, ""];
    lines.push(`- **Type:** ${entity.entityType}`);
    if (entity.files && entity.files.length) {
      lines.push(`- **Sources:** ${entity.files.join(", ")}`);
    }

    const observations = normalizeObservations(entity.observations);
    if (observations.length) {
      lines.push("", "## Facts", "");
      for (const o of observations) {
        lines.push(`- ${obsText(o)}${this.provenance(o)}`);
      }
    }

    const outgoing = (graph.relations ?? []).filter((r) => r.from === entity.name);
    const incoming = (graph.relations ?? []).filter(
      (r) => r.to === entity.name && r.from !== entity.name
    );
    if (outgoing.length || incoming.length) {
      lines.push("", "## Relations", "");
      for (const r of outgoing) {
        lines.push(`- **${this.predicate(r)}** → ${r.to}`);
      }
      for (const r of incoming) {
        lines.push(`- ${r.from} **${this.predicate(r)}** →`);
      }
    }

    return lines.join("\n") + "\n";
  }

  private predicate(r: Relation): string {
    return Array.isArray(r.relationType)
      ? r.relationType.join(", ")
      : String(r.relationType);
  }

  /**
   * Inline provenance — wanshi's "knows where every fact came from", surfaced so
   * OpenWebUI's RAG keeps the source attached to the retrieved chunk.
   */
  private provenance(o: Observation): string {
    const bits: string[] = [];
    if (o.source) bits.push(`source: ${o.source}`);
    if (o.validAt) bits.push(`as of ${o.validAt}`);
    if (o.speaker) bits.push(`by ${o.speaker}`);
    return bits.length ? `  _(${bits.join("; ")})_` : "";
  }

  /** Filesystem-safe, unique slug for an entity name (no path separators). */
  private slug(name: string, used: Set<string>): string {
    // Preserve underscores — wanshi entities are often snake_case code identifiers,
    // so `knowledge_graph_builder` stays readable rather than becoming `...-builder`.
    let base = (name || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    if (!base) base = "entity";
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${n++}`;
    }
    used.add(candidate);
    return candidate;
  }
}

const README = [
  "# wanshi → OpenWebUI knowledge base",
  "",
  "This folder is a wanshi knowledge graph rendered as **one markdown document per entity**,",
  "ready to sync into an [OpenWebUI](https://openwebui.com) knowledge base.",
  "",
  "OpenWebUI's *knowledge* is retrieval-augmented (RAG): it chunks + embeds documents.",
  "Sync this folder with OpenWebUI's official **[oikb](https://github.com/open-webui/oikb)**",
  "tool — it diffs per file (SHA-256), so re-running wanshi only re-embeds the entities that changed:",
  "",
  "```bash",
  "# one-off sync",
  "oikb sync . --kb-id <your-knowledge-base-id>",
  "",
  "# or keep it live",
  "oikb watch . --kb-id <your-knowledge-base-id>",
  "```",
  "",
  "Get `<your-knowledge-base-id>` from the Knowledge base in OpenWebUI (Workspace → Knowledge).",
  "For a scheduled/daemon setup, edit `.oikb.yaml` here and run `oikb` from this folder.",
  "",
  "> `README.md` is excluded from the sync (see `.oikbignore`); only the entity documents are uploaded.",
  "",
].join("\n");

const OIKB_YAML = [
  "# Starter oikb config — sync this folder into an OpenWebUI knowledge base.",
  "# Docs: https://docs.openwebui.com/features/knowledge-base-sync/",
  "#",
  "# 1. Create a knowledge base in OpenWebUI (Workspace → Knowledge); copy its id.",
  "# 2. Put the id in `kb-id` below.",
  "# 3. Run `oikb sync .` (or `oikb watch .`) from this folder.",
  "sources:",
  "  - name: wanshi-graph",
  "    source: .",
  "    kb-id: REPLACE_WITH_KB_ID",
  "    filter:",
  '      include: ["*.md"]',
  '      exclude: ["README.md"]',
  "",
].join("\n");

const OIKBIGNORE = [
  "# Keep helper files out of the OpenWebUI knowledge base — only entity docs sync.",
  "README.md",
  "",
].join("\n");
