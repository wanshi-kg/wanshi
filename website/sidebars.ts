import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// Curated sidebar for the wanshi documentation site.
// (Pages live under website/docs/; reference/configuration is generated from `wanshi schema`.)
const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Getting started',
      collapsed: false,
      items: [
        'getting-started/installation',
        'getting-started/quick-start',
        'getting-started/configuration',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      items: [
        'guides/supported-inputs',
        'guides/output-formats',
        'guides/config-tiers',
        'guides/local-models',
        'guides/migration',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: ['reference/cli', 'reference/configuration'],
    },
    {
      type: 'category',
      label: 'Benchmarks',
      items: ['benchmarks/results', 'benchmarks/methodology'],
    },
    {
      type: 'category',
      label: 'Examples',
      items: [
        'examples/overview',
        'examples/canonicalization',
        'examples/knowledge-injection',
        'examples/telegram-sink',
      ],
    },
    'architecture',
    'contributing',
  ],
};

export default sidebars;
