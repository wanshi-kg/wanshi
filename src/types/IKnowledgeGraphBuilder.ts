import { ProcessedFile } from './IProcessingService';
import { KnowledgeGraph } from './KnowledgeGraph';
import { CorpusGlossary } from './CorpusProfile';

/**
 * Interface for Knowledge Graph Building services
 */

export interface IKnowledgeGraphBuilder {
  /**
   * Build knowledge graphs from processed file. An optional corpus glossary
   * steers entity naming/types when corpus profiling is enabled.
   */
  build(
    file: ProcessedFile,
    systemPrompt: string,
    retrieve?: (chunkContent: string) => Promise<any>,
    glossary?: CorpusGlossary
  ): Promise<KnowledgeGraph[]>;
}
