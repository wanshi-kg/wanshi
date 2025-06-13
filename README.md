# Knowledge Graph Generator

> 🧠 Transform your codebase into intelligent knowledge graphs using local LLMs

An advanced CLI tool that analyzes files, extracts meaningful entities and relationships, and builds comprehensive knowledge graphs. Perfect for understanding complex codebases, research projects, and documentation systems.

## 🎯 Project Goals

**Primary Objective**: Create the most intelligent file-to-knowledge-graph converter that:

- ✅ **Zero Hallucination**: Only extracts factually verifiable information
- ✅ **Semantic Understanding**: Goes beyond syntax to capture meaning and relationships  
- ✅ **Scalable Processing**: Handles large codebases with smart chunking and caching
- ✅ **Multiple Formats**: Supports code, documentation, research papers, and more
- ✅ **Production Ready**: Reliable, fast, and integrates with existing workflows

**Secondary Objectives**:

- 🔗 **MCP Integration**: Compatible with Claude Desktop and Anthropic MCP protocol
- 🎛️ **Quality Metrics**: Comprehensive evaluation system for continuous improvement
- 🧪 **Research Ready**: Support for LoRa fine-tuning and model improvement
- 🔍 **Intelligent Search**: Vector and graph-based context retrieval

## 🚀 Key Features

### 🔥 Core Capabilities

- **Multi-format Processing**: Text, code, PDFs, images and audi/video with smart content extraction
- **Hierarchical Merging**: File-level → entity-level → global-level intelligent merging
- **Smart Chunking**: Content-aware splitting with overlap for large files
- **Context-Aware Processing**: Uses existing knowledge to maintain consistency
- **Quality Evaluation**: Comprehensive metrics for factual accuracy and semantic quality

### 🎛️ Advanced Features

- **MCP Compatibility**: Works with Claude Desktop and server-memory tools
- **Multiple Export Formats**: JSON, JSONL, MCP-compatible formats
- **Vector Search**: ChromaDB and Neo4j integration for semantic retrieval
- **Embeddings Caching**: Persistent caching for 10x performance improvements
- **Watch Mode**: Real-time knowledge graph updates as files change

### 🧠 Intelligence Features

- **Zero Hallucination**: Strict factual grounding with source verification
- **Entity Deduplication**: Smart similarity matching with configurable thresholds
- **Observation Ranking**: Embedding-based duplicate detection and relevance scoring
- **Cross-file Consistency**: Maintains entity naming and relationships across files

## 📦 Installation

```bash
TODO: Add examples later
```

## 🎮 Usage

### Basic Usage

```bash
TODO: Add examples later
```

### Advanced Usage

```bash
TODO: Add examples later
```

### CLI Options

```bash
TODO: Add actual help output later
```

## 🔬 Quality Metrics

The system includes comprehensive quality evaluation:

### Structural Metrics

- Entity and relation counts
- Graph density and connectivity
- Type distributions

### Semantic Metrics

- Entity name quality (naming conventions, descriptiveness)
- Observation specificity (detailed vs. trivial facts)
- Domain coverage (how well it captures file content)

### Factual Metrics

- Hallucination detection (ungrounded claims)
- Source grounding (facts verifiable in source)
- Factual consistency (no contradictions)

### Consistency Metrics

- Cross-file consistency (entity naming)
- Type consistency (similar entities, similar types)

### Composite Score

- Overall quality score (0-100)
- Specific recommendations for improvement
- Training data generation for LoRa fine-tuning

## 📊 Output Formats

### Standard JSON

```json
{
  "entities": [
    {
      "name": "entity_name",
      "entityType": "function|class|concept|etc",
      "observations": ["fact1", "fact2"],
      "file": "src/example.ts",
      "chunk": 0,
      "totalChunks": 3
    }
  ],
  "relations": [
    {
      "from": "entity1",
      "to": "entity2", 
      "relationType": ["uses", "depends_on"]
    }
  ]
}
```

### MCP-Compatible JSONL

```jsonl
{"type": "entity", "name": "example_function", "entityType": "function", "observations": ["Processes user input"]}
{"type": "relation", "from": "example_function", "to": "user_input", "relationType": "processes"}
```

## 🧪 Testing

```bash
TODO: Add examples later
```

## 🔧 Configuration

### Environment Variables

```bash
TODO: Add examples later
```

## 🤖 Local LLM Requirements & Leaderboard

TODO: Add benchmarking table. Currently tested qwen2.5-coder:1.5b, qwen3:0.6b, qwen3:1.7b, gemma3:1b, gemma3:4b

## 🔗 Integration Examples

TODO: Add examples later

### Development Setup

```bash
git clone https://github.com/alex_sabaka/kg-gen
cd kg-gen
npm install
npm run dev
```

## 📄 License

GPL-3.0 License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Anthropic** for MCP protocol and Claude integration inspiration
- **Ollama** for local LLM deployment and API
- **ChromaDB** and **Neo4j** for vector and graph database capabilities
- **LangChain** for text splitting and processing utilities
- **Open Source Community** for the amazing tools and libraries that make this possible

---

**Built with ❤️ for developers, researchers, and knowledge workers who want to understand their data better.**
