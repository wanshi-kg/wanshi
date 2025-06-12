# Action Items

- `DirectoryProcessor.ts` is doing too much (orchestration + business logic)
- Add clear error handling strategy
- Make it unit testable
- Implement parallel file processing in `DirectoryProcessor.ts`
- `Knowledge graph has duplicate/weird observations (data quality issue) – find a test file sets for predictable testing
- Create batch processing for multiple files
- Add progress reporting for long operations
- Performance benchmarking
- Add metrics collection, logging and reporting (Processing speed (files/second), Memory usage per file, LLM token usage, Cache hit rates, Error rates by file type, Knowledge graph quality scores)
- Try to follow common sense and basic patterns where appropriate, like KISS, SOLID, Separation of Concerns, GoF patterns