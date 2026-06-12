import { default as DocumentOutline, formatOutline } from "document-outline-gen";

/**
 * Subset of document-outline-gen's GeneratorOptions we expose via config, plus
 * the ascii-tree `compact` formatter toggle.
 */
export interface OutlineGeneratorOptions {
  maxDepth?: number;
  includeLineNumbers?: boolean;
  includePrivate?: boolean;
  includeComments?: boolean;
  /** Token-lean ascii-tree: drop the `(line N)` + metadata annotations. */
  compact?: boolean;
}

export class DocumentOutlineGenerator {
  static async generateOutlineFromContent(
    content: string,
    extension: string,
    options?: OutlineGeneratorOptions
  ): Promise<string> {
    const { compact, ...genOptions } = options ?? {};
    const generator = new DocumentOutline();
    // The Safe variant returns [] for unknown extensions / parse failures instead
    // of throwing — exactly what a heterogeneous corpus wants (no per-chunk
    // "No generator found" warning, KG-17). Rendering goes through upstream's
    // canonical ascii-tree formatter so kg-gen no longer carries its own copy;
    // `compact` drops line numbers + metadata for token-lean prompts.
    const outline = await generator.generateFromContentSafe(content, extension, genOptions);
    return formatOutline(outline, "ascii-tree", { compact: compact === true });
  }
}
