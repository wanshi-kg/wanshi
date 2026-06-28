import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'wanshi',
  tagline: 'Knows ten thousand things; keeps only the ones it can source.',
  favicon: 'img/wanshi-avatar-256.svg',

  // Improve compatibility with the upcoming Docusaurus v4
  future: {
    v4: true,
  },

  // Production URL — GitHub Pages project site for wanshi-kg/wanshi.
  url: 'https://wanshi-kg.github.io',
  baseUrl: '/wanshi/',

  // GitHub Pages deployment config (the deploy workflow lands with the CI/CD track).
  organizationName: 'wanshi-kg',
  projectName: 'wanshi',
  trailingSlash: false,

  onBrokenLinks: 'throw',

  // `.md` → CommonMark (lenient, HTML passthrough), `.mdx` → MDX. Keeps generated
  // and migrated prose from tripping MDX's JSX parser on `<`/`{` in descriptions.
  markdown: {
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/wanshi-kg/wanshi/tree/master/website/',
        },
        // No blog — this is a documentation site.
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/wanshi-banner-light.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'wanshi',
      logo: {
        alt: 'wanshi',
        src: 'img/wanshi-avatar-256.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/docs/reference/configuration',
          label: 'Config reference',
          position: 'left',
        },
        {
          href: 'https://github.com/wanshi-kg/wanshi',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Introduction', to: '/docs/intro'},
            {label: 'Installation', to: '/docs/getting-started/installation'},
            {label: 'CLI reference', to: '/docs/reference/cli'},
            {label: 'Benchmarks', to: '/docs/benchmarks/results'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'GitHub', href: 'https://github.com/wanshi-kg/wanshi'},
            {
              label: 'License (MIT)',
              href: 'https://github.com/wanshi-kg/wanshi/blob/master/LICENSE',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Alex Sabaka · wanshi · MIT. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'yaml', 'json', 'diff'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
