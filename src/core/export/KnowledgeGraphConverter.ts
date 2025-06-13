import { MCPKnowledgeGraph } from "../../types/MCPKnowledgeGraph";
import { KnowledgeGraph, Entity, Relation } from "../../types/KnowledgeGraph";
import { logger } from "../../shared/logger";
import { DotExportOptions, ProcessingOptions } from "../../types";

// Conversion utilities
export class KnowledgeGraphConverter {
  // Convert our format to MCP format
  static toMCP(graph: KnowledgeGraph): MCPKnowledgeGraph {
    return {
      entities: graph.entities.map((entity) => ({
        name: entity.name,
        entityType: entity.entityType,
        observations: entity.observations || [],
      })),
      relations: graph.relations.map((relation) => ({
        from: relation.from,
        to: relation.to,
        relationType: Array.isArray(relation.relationType)
          ? relation.relationType.join(",")
          : relation.relationType,
      })),
    };
  }

  // Convert MCP format to our format
  static fromMCP(mcpGraph: MCPKnowledgeGraph): KnowledgeGraph {
    return {
      entities: mcpGraph.entities.map(
        (entity) =>
          ({
            name: entity.name,
            entityType: entity.entityType,
            observations: entity.observations || [],
          } as Entity)
      ),
      relations: mcpGraph.relations.map(
        (relation) =>
          ({
            from: relation.from,
            to: relation.to,
            relationType: relation.relationType.includes(",")
              ? relation.relationType.split(",").map((s) => s.trim())
              : relation.relationType,
          } as Relation)
      ),
    };
  }

  // Export to JSONL format (each line is a JSON object)
  static toJSONL(graph: KnowledgeGraph): string {
    const lines: string[] = [];

    // Add entities as JSONL
    graph.entities.forEach((entity) => {
      lines.push(JSON.stringify({ type: "entity", ...entity }));
    });

    // Add relations as JSONL
    graph.relations.forEach((relation) => {
      lines.push(JSON.stringify({ type: "relation", ...relation }));
    });

    return lines.join("\n");
  }

  // Import from JSONL format
  static fromJSONL(jsonlContent: string): KnowledgeGraph {
    const lines = jsonlContent.split("\n").filter((line) => line.trim() !== "");
    const graph: KnowledgeGraph = { entities: [], relations: [] };

    lines.forEach((line) => {
      try {
        const item = JSON.parse(line);
        if (item.type === "entity") {
          const { type, ...entity } = item;
          graph.entities.push(entity as Entity);
        } else if (item.type === "relation") {
          const { type, ...relation } = item;
          graph.relations.push(relation as Relation);
        }
      } catch (error) {
        logger.warn(`Failed to parse JSONL line: ${line}`);
      }
    });

    return graph;
  }

  // Export to MCP JSONL format
  static toMCPJSONL(graph: KnowledgeGraph): string {
    const mcpGraph = this.toMCP(graph);
    const lines: string[] = [];

    mcpGraph.entities.forEach((entity) => {
      lines.push(JSON.stringify({ type: "entity", ...entity }));
    });

    mcpGraph.relations.forEach((relation) => {
      lines.push(JSON.stringify({ type: "relation", ...relation }));
    });

    return lines.join("\n");
  }

  // Export to DOT language format for Graphviz visualization
  static toDOT(
    graph: KnowledgeGraph,
    processingOptions?: ProcessingOptions,
    options: DotExportOptions = {}
  ): string {
    const {
      layout = "dot",
      rankdir = "TB",
      nodeShape = "box",
      edgeStyle = "solid",
      colorScheme = "default",
      includeObservations = true,
      maxObservationsPerNode = 3,
      clusterByEntityType = false,
      clusterByFile = false,
      showLegend = true,
    } = options;

    const lines: string[] = [];

    // Graph header with processing info as title if available
    const graphTitle = processingOptions
      ? `Knowledge Graph - ${processingOptions.input} (${processingOptions.model})`
      : "Knowledge Graph";

    lines.push(`digraph KnowledgeGraph {`);
    lines.push(`  label="${this.escapeLabel(graphTitle)}";`);
    lines.push(`  labelloc="t";`);
    lines.push(`  fontsize="16";`);
    lines.push(`  fontname="Arial Bold";`);
    lines.push(`  layout="${layout}";`);
    lines.push(`  rankdir="${rankdir}";`);
    lines.push(`  node [shape="${nodeShape}", style="filled"];`);
    lines.push(`  edge [style="${edgeStyle}"];`);
    lines.push(`  overlap="false";`);
    lines.push(`  splines="true";`);
    lines.push("");

    // Color schemes
    const colors = this.getColorScheme(colorScheme);

    // Generate entity type to color mapping
    const entityTypes = [...new Set(graph.entities.map((e) => e.entityType))];
    const typeColorMap = new Map<string, string>();
    entityTypes.forEach((type, index) => {
      typeColorMap.set(
        type,
        colors.entityColors[index % colors.entityColors.length]
      );
    });

    // Generate file to cluster mapping if clustering by file
    const fileClusterMap = new Map<string, string>();
    if (clusterByFile) {
      const files = [
        ...new Set(graph.entities.map((e) => e.files[0]).filter(Boolean)),
      ];
      files.forEach((file, index) => {
        fileClusterMap.set(file!, `cluster_file_${index}`);
      });
    }

    // Generate entity type clusters if enabled
    if (clusterByEntityType && !clusterByFile) {
      entityTypes.forEach((entityType, index) => {
        const entitiesOfType = graph.entities.filter(
          (e) => e.entityType === entityType
        );
        if (entitiesOfType.length > 1) {
          lines.push(`  subgraph cluster_${entityType} {`);
          lines.push(`    label="${entityType}";`);
          lines.push(`    style="dashed";`);
          lines.push(
            `    color="${
              colors.clusterColors[index % colors.clusterColors.length]
            }";`
          );

          entitiesOfType.forEach((entity) => {
            lines.push(`    ${this.escapeNodeId(entity.name)};`);
          });

          lines.push(`  }`);
          lines.push("");
        }
      });
    }

    // Generate file clusters if enabled
    if (clusterByFile) {
      for (const [file, clusterId] of fileClusterMap) {
        const entitiesInFile = graph.entities.filter(
          (e) => e.files[0] === file
        );
        if (entitiesInFile.length > 1) {
          lines.push(`  subgraph ${clusterId} {`);
          lines.push(`    label="${this.escapeLabel(file)}";`);
          lines.push(`    style="dashed";`);
          lines.push(`    color="${colors.fileColors[0]}";`);

          entitiesInFile.forEach((entity) => {
            lines.push(`    ${this.escapeNodeId(entity.name)};`);
          });

          lines.push(`  }`);
          lines.push("");
        }
      }
    }

    // Generate nodes (entities)
    lines.push("  // Entities");
    graph.entities.forEach((entity) => {
      const nodeId = this.escapeNodeId(entity.name);
      const color = typeColorMap.get(entity.entityType) || colors.defaultColor;

      // Build label with observations if enabled
      let label = this.escapeLabel(entity.name);

      if (
        includeObservations &&
        entity.observations &&
        entity.observations.length > 0
      ) {
        const observations = entity.observations.slice(
          0,
          maxObservationsPerNode
        );
        const truncatedObs = observations.map((obs) =>
          obs.length > 40 ? obs.substring(0, 37) + "..." : obs
        );

        label +=
          "\\n\\n" +
          truncatedObs.map((obs) => "• " + this.escapeLabel(obs)).join("\\n");

        if (entity.observations.length > maxObservationsPerNode) {
          label += `\\n... +${
            entity.observations.length - maxObservationsPerNode
          } more`;
        }
      }

      // Add entity type as subtitle
      label += `\\n\\n[${entity.entityType}]`;

      // Add file information if available
      if (entity.files[0] && !clusterByFile) {
        const fileName = entity.files[0].split("/").pop() || entity.files[0];
        label += `\\n📁 ${this.escapeLabel(fileName)}`;
      }

      lines.push(
        `  ${nodeId} [label="${label}", fillcolor="${color}", tooltip="${this.escapeLabel(
          entity.entityType
        )}"];`
      );
    });

    lines.push("");

    // Generate edges (relations)
    lines.push("  // Relations");
    const relationColorMap = new Map<string, string>();
    const uniqueRelationTypes = [
      ...new Set(
        graph.relations.flatMap((r) =>
          Array.isArray(r.relationType) ? r.relationType : [r.relationType]
        )
      ),
    ];

    uniqueRelationTypes.forEach((relType, index) => {
      relationColorMap.set(
        relType,
        colors.relationColors[index % colors.relationColors.length]
      );
    });

    graph.relations.forEach((relation) => {
      const fromId = this.escapeNodeId(relation.from);
      const toId = this.escapeNodeId(relation.to);

      const relationTypes = Array.isArray(relation.relationType)
        ? relation.relationType
        : [relation.relationType];

      relationTypes.forEach((relType) => {
        const color =
          relationColorMap.get(relType) || colors.defaultRelationColor;
        const label = this.escapeLabel(relType);

        lines.push(
          `  ${fromId} -> ${toId} [label="${label}", color="${color}", fontcolor="${color}"];`
        );
      });
    });

    // Add processing configuration info if enabled and available
    if (processingOptions) {
      lines.push("");
      lines.push("  // Processing Configuration");
      lines.push("  subgraph cluster_processing {");
      lines.push('    label="Processing Configuration";');
      lines.push('    style="solid";');
      lines.push('    color="darkblue";');
      lines.push('    bgcolor="lightcyan";');
      lines.push('    fontcolor="darkblue";');
      lines.push("");

      // Core processing info
      const configInfo = [
        ["Input", processingOptions.input],
        ["Model", processingOptions.model],
        ["Host", processingOptions.host],
        ["Temperature", processingOptions.temperature.toString()],
        ["Chunk Size", processingOptions.chunkSize.toString()],
        ["Overlap Size", processingOptions.overlapSize.toString()],
        ["Chunking", processingOptions.chunking],
        ["Retrieval", processingOptions.retrieval],
        ["ASR", processingOptions.asr],
        ...(processingOptions.whisperModel
          ? [["Whisper Model", processingOptions.whisperModel]]
          : []),
        ...(processingOptions.language
          ? [["Language", processingOptions.language]]
          : []),
        ...(processingOptions.exportFormat
          ? [["Export Format", processingOptions.exportFormat]]
          : []),
        ...(processingOptions.seed !== undefined
          ? [["Seed", processingOptions.seed.toString()]]
          : []),
      ];

      configInfo.forEach(([key, value], index) => {
        if (value) {
          const nodeId = `config_${index}`;
          const displayValue =
            value.length > 30 ? value.substring(0, 27) + "..." : value;
          const label = `${key}:\\n${this.escapeLabel(displayValue)}`;
          lines.push(
            `    ${nodeId} [label="${label}", shape="note", fillcolor="lightyellow", fontsize="10"];`
          );
        }
      });

      lines.push("  }");
      lines.push("");
    }

    // Add legend if enabled
    if (showLegend) {
      lines.push("");
      lines.push("  // Legend");
      lines.push("  subgraph cluster_legend {");
      lines.push('    label="Legend";');
      lines.push('    style="solid";');
      lines.push('    color="black";');
      lines.push('    bgcolor="lightgray";');
      lines.push("");

      // Entity type legend
      lines.push("    // Entity Types");
      entityTypes.forEach((entityType, index) => {
        const color = typeColorMap.get(entityType) || colors.defaultColor;
        const legendNodeId = `legend_entity_${index}`;
        lines.push(
          `    ${legendNodeId} [label="${this.escapeLabel(
            entityType
          )}", shape="box", fillcolor="${color}"];`
        );
      });

      lines.push("");

      // Relation type legend
      if (uniqueRelationTypes.length > 0) {
        lines.push("    // Relation Types");
        lines.push(
          '    legend_rel_start [label="Relations:", shape="plaintext"];'
        );

        uniqueRelationTypes.slice(0, 10).forEach((relType, index) => {
          // Limit to 10 for readability
          const color =
            relationColorMap.get(relType) || colors.defaultRelationColor;
          const legendNodeId = `legend_rel_${index}`;
          lines.push(
            `    legend_rel_${index}_from [label="", shape="point", width="0.1"];`
          );
          lines.push(
            `    legend_rel_${index}_to [label="${this.escapeLabel(
              relType
            )}", shape="plaintext"];`
          );
          lines.push(
            `    legend_rel_${index}_from -> legend_rel_${index}_to [color="${color}", fontcolor="${color}"];`
          );
        });
      }

      lines.push("  }");
    }

    lines.push("}");

    return lines.join("\n");
  }

  // Helper method to escape node IDs for DOT format
  private static escapeNodeId(id: string): string {
    // Replace invalid characters and wrap in quotes if necessary
    const escaped = id.replace(/[^a-zA-Z0-9_]/g, "_");
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(escaped) ? escaped : `"${escaped}"`;
  }

  // Helper method to escape labels for DOT format
  private static escapeLabel(label: string): string {
    return label
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
  }

  // Get color scheme based on selection
  private static getColorScheme(scheme: string) {
    switch (scheme) {
      case "scientific":
        return {
          entityColors: [
            "lightblue",
            "lightgreen",
            "lightyellow",
            "lightcoral",
            "lightpink",
            "lightgray",
            "lightsteelblue",
            "lightseagreen",
          ],
          relationColors: [
            "blue",
            "darkgreen",
            "orange",
            "red",
            "purple",
            "brown",
            "darkblue",
            "darkred",
          ],
          clusterColors: ["blue", "green", "red", "purple", "orange"],
          fileColors: ["gray"],
          defaultColor: "white",
          defaultRelationColor: "black",
        };

      case "code":
        return {
          entityColors: [
            "#FFE6CC",
            "#E6F3FF",
            "#E6FFE6",
            "#FFE6F3",
            "#F3E6FF",
            "#FFFFE6",
            "#E6FFFF",
            "#FFE6E6",
          ],
          relationColors: [
            "#FF6B35",
            "#004E89",
            "#4CAF50",
            "#E91E63",
            "#9C27B0",
            "#FF9800",
            "#00BCD4",
            "#F44336",
          ],
          clusterColors: [
            "#1976D2",
            "#388E3C",
            "#D32F2F",
            "#7B1FA2",
            "#F57C00",
          ],
          fileColors: ["#616161"],
          defaultColor: "#F5F5F5",
          defaultRelationColor: "#424242",
        };

      case "minimal":
        return {
          entityColors: ["white", "lightgray"],
          relationColors: ["black", "gray"],
          clusterColors: ["gray"],
          fileColors: ["lightgray"],
          defaultColor: "white",
          defaultRelationColor: "black",
        };

      default: // 'default'
        return {
          entityColors: [
            "lightblue",
            "lightgreen",
            "lightyellow",
            "lightcoral",
            "lightpink",
            "lightgray",
            "lightsteelblue",
            "lightseagreen",
            "wheat",
            "plum",
            "khaki",
            "lightcyan",
          ],
          relationColors: [
            "blue",
            "darkgreen",
            "orange",
            "red",
            "purple",
            "brown",
            "darkblue",
            "darkred",
            "darkorange",
            "darkviolet",
          ],
          clusterColors: ["blue", "green", "red", "purple", "orange", "brown"],
          fileColors: ["gray", "darkgray"],
          defaultColor: "white",
          defaultRelationColor: "black",
        };
    }
  }
}
