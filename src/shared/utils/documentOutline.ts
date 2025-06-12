import { default as DocumentOutline } from "document-outline-gen"

export class DocumentOutlineGenerator {
  static async generateOutlineFromContent(content: string, extension: string) {
    const generator = new DocumentOutline();
    const outline = await generator.generateFromContent(content, extension);
    return DocumentOutlineGenerator.formatAsTree(outline);
  }

  private static formatMetadata(metadata: Record<string, any>): string {
    const parts: string[] = [];

    if (metadata.visibility && metadata.visibility !== "public") {
      parts.push(metadata.visibility);
    }

    if (metadata.isStatic) {
      parts.push("static");
    }

    if (metadata.isAbstract) {
      parts.push("abstract");
    }

    if (metadata.parameters && metadata.parameters.length > 0) {
      const params = metadata.parameters.map((p: any) => p.name).join(", ");
      parts.push(`params: ${params}`);
    }

    if (metadata.dataType) {
      parts.push(`type: ${metadata.dataType}`);
    }

    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
  }

  private static formatAsTree(nodes: any[], depth: number = 0): string {
    let result = "";
    const indent = "  ".repeat(depth);

    for (const node of nodes) {
      const line = node.line ? ` (line ${node.line})` : "";
      const metadata = node.metadata
        ? DocumentOutlineGenerator.formatMetadata(node.metadata)
        : "";
      result += `${indent}├─ ${node.title} [${node.type}]${line}${metadata}\n`;

      if (node.children && node.children.length > 0) {
        result += DocumentOutlineGenerator.formatAsTree(
          node.children,
          depth + 1
        );
      }
    }

    return result;
  }
}
