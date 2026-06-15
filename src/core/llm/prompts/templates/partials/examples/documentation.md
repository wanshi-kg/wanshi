### Example 1: README install + usage

Input:

## File information

Path: `README.md`

## Content to analyze
```
# Wanshi
Wanshi turns files into knowledge graphs. Requires Node.js 18+.

## Install
npm install -g wanshi

## Usage
Run `wanshi --config config.yaml`. Set `output` to choose the destination file.
```

Output:

```json
{
  "entities": [
    {
      "name": "Wanshi README",
      "entityType": "guide",
      "observations": ["Install and usage documentation for the Wanshi CLI"]
    },
    {
      "name": "Wanshi",
      "entityType": "product",
      "observations": ["CLI that turns files into knowledge graphs"]
    },
    {
      "name": "Node.js 18+",
      "entityType": "requirement",
      "observations": ["Minimum runtime needed to install Wanshi"]
    },
    {
      "name": "install wanshi",
      "entityType": "procedure",
      "observations": ["Run `npm install -g wanshi`"]
    },
    {
      "name": "output",
      "entityType": "configuration_option",
      "observations": ["Sets the destination file for the generated graph; configured in config.yaml"]
    }
  ],
  "relations": [
    { "from": "Wanshi README",  "to": "Wanshi",       "relationType": ["documents"] },
    { "from": "Wanshi README",  "to": "install wanshi","relationType": ["guides_through"] },
    { "from": "install wanshi", "to": "Node.js 18+",   "relationType": ["requires"] },
    { "from": "output",         "to": "Wanshi",        "relationType": ["configures"] }
  ]
}
```

Note: the named option `output` is a `configuration_option` node, but its concrete
value lives in the observation — a raw value like `graph.jsonl` would not be its own
node. The install command is the procedure's observation, not a separate entity.

---

### Example 2: API reference (method + parameters)

Input:

## File information

Path: `docs/api.md`

## Content to analyze
```
### `createGraph(files, options)`
Builds a knowledge graph from the given files.
- `files` (string[]) — paths to ingest. Required.
- `options.format` — output format, one of json|jsonl. Defaults to json.
Returns a `KnowledgeGraph`.
```

Output:

```json
{
  "entities": [
    {
      "name": "createGraph",
      "entityType": "api_method",
      "observations": [
        "Builds a knowledge graph from the given files",
        "Returns a KnowledgeGraph"
      ]
    },
    {
      "name": "files",
      "entityType": "parameter",
      "observations": ["string[] of paths to ingest; required"]
    },
    {
      "name": "options.format",
      "entityType": "parameter",
      "observations": ["Output format, one of json|jsonl; defaults to json"]
    }
  ],
  "relations": [
    { "from": "files",          "to": "createGraph", "relationType": ["part_of"] },
    { "from": "options.format", "to": "createGraph", "relationType": ["part_of"] }
  ]
}
```

Note: `Required` and the default value are observations on the parameter, not nodes.
Parameters are `part_of` their method; the return type stays an observation rather
than becoming a dangling `KnowledgeGraph` node with no facts of its own here.

---

### Example 3: Tutorial with ordered steps

Input:

## File information

Path: `docs/tutorial.md`

## Content to analyze
```
## Your first graph
1. Create a `config.yaml` pointing `input` at your project.
2. Run `wanshi --config config.yaml`.
3. Open the generated `graph.jsonl`.

Example: the snippet below ingests a TypeScript repo and writes JSONL.
```

Output:

```json
{
  "entities": [
    {
      "name": "first graph tutorial",
      "entityType": "guide",
      "observations": ["Walks a new user through producing their first knowledge graph"]
    },
    {
      "name": "create config.yaml",
      "entityType": "tutorial_step",
      "observations": ["Point `input` at the project to ingest"]
    },
    {
      "name": "run wanshi",
      "entityType": "tutorial_step",
      "observations": ["Run `wanshi --config config.yaml`"]
    },
    {
      "name": "open the output graph",
      "entityType": "tutorial_step",
      "observations": ["Inspect the generated `graph.jsonl`"]
    },
    {
      "name": "TypeScript repo walkthrough",
      "entityType": "example",
      "observations": ["Ingests a TypeScript repo and writes JSONL"]
    }
  ],
  "relations": [
    { "from": "first graph tutorial", "to": "create config.yaml",          "relationType": ["guides_through"] },
    { "from": "first graph tutorial", "to": "run wanshi",                  "relationType": ["guides_through"] },
    { "from": "first graph tutorial", "to": "open the output graph",       "relationType": ["guides_through"] },
    { "from": "first graph tutorial", "to": "TypeScript repo walkthrough", "relationType": ["demonstrates"] },
    { "from": "create config.yaml",   "to": "run wanshi",                  "relationType": ["precedes"] },
    { "from": "run wanshi",           "to": "open the output graph",       "relationType": ["precedes"] }
  ]
}
```

Note: `guides_through` links the tutorial to each step; `precedes` records step order
without restating it as a synonym; `demonstrates` links the tutorial to the worked
example. Direction stays consistent (guide → step, earlier step → later step).

---

### Example 4: Feature explanation

Input:

## File information

Path: `docs/features.md`

## Content to analyze
```
## Resume
The `--resume` flag checkpoints every chunk so an interrupted run can continue
without re-billing. It requires a writable output directory.
```

Output:

```json
{
  "entities": [
    {
      "name": "Resume documentation",
      "entityType": "guide",
      "observations": ["Explains how the resume feature works"]
    },
    {
      "name": "Resume",
      "entityType": "feature",
      "observations": [
        "Checkpoints every chunk so an interrupted run can continue without re-billing",
        "Enabled with the `--resume` flag"
      ]
    },
    {
      "name": "writable output directory",
      "entityType": "requirement",
      "observations": ["Needed so resume can persist checkpoints"]
    }
  ],
  "relations": [
    { "from": "Resume documentation", "to": "Resume",                    "relationType": ["explains"] },
    { "from": "Resume",               "to": "writable output directory", "relationType": ["requires"] }
  ]
}
```

Note: `explains` links the doc section to the feature it describes; `requires`
captures the precondition. The `--resume` flag is an observation on the feature, not
a separate node.

---

### Example 5: Badges / scaffolding → empty graph

Input:

## File information

Path: `README.md`
Chunk 1 of 4

## Content to analyze
```
![build](https://img.shields.io/badge/build-passing-green)
![npm](https://img.shields.io/npm/v/wanshi)
<!-- TOC generated, do not edit -->
```

Output:

```json
{ "entities": [], "relations": [] }
```

Note: status badges and generated table-of-contents markup carry no durable facts —
empty graph, not a node scraped from a shields.io URL.
