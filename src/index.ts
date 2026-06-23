// Library entry point — programmatic API.
// The CLI is NOT re-exported here: it runs `program.parse()` at import time,
// which must not fire when this module is `require`d as a library. The CLI is
// shipped via the `wanshi` bin (./dist/cli/index.js).

export * from './core/DirectoryProcessor';
export * from './core/processor';
export * from './core/llm/OllamaService';
export * from './core/llm/EmbeddingService';
export * from './core/knowledge/KnowledgeGraphBuilder';
export * from './core/knowledge/merging/KnowledgeMerger';
export * from './core/knowledge/search/KnowledgeGraphSearch';
