import * as fs from 'fs';
import { FileReader, FileReadResult } from './FileReader';
import { logger } from '../../../shared/logger';

/**
 * Reader for plain text files
 */
export class TextReader extends FileReader {
  constructor() {
    super([
      '.txt', '.md', '.markdown', '.rst', '.asciidoc',
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      '.py', '.pyw', '.pyi', '.pyc', '.pyd', '.pyo',
      '.java', '.class', '.jar',
      '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
      '.cs', '.vb', '.fs', '.fsx', '.fsi',
      '.rb', '.rake', '.gemspec',
      '.go', '.mod', '.sum',
      '.rs', '.toml',
      '.swift', '.kt', '.kts',
      '.scala', '.sbt',
      '.r', '.R', '.rmd', '.Rmd',
      '.php', '.phtml',
      '.l', '.log', '.lisp', '.lua',
      '.vim', '.vimrc',
      '.pl', '.pm', '.pod',
      '.css', '.scss', '.sass', '.less',
      '.html', '.htm', '.xhtml',
      '.xml', '.xsl', '.xslt',
      '.json', '.jsonl', '.geojson',
      '.yaml', '.yml',
      '.toml', '.ini', '.cfg', '.conf', '.config',
      '.env', '.env.example', '.env.local', '.env.development', '.env.production',
      '.sh', '.bash', '.zsh', '.fish', '.ksh',
      '.ps1', '.psm1', '.psd1',
      '.bat', '.cmd',
      '.sql', '.pgsql', '.mysql',
      '.dockerfile', '.dockerignore',
      '.gitignore', '.gitattributes', '.gitmodules',
      '.editorconfig', '.eslintrc', '.prettierrc',
      '.npmrc', '.yarnrc', '.nvmrc',
      'Makefile', 'makefile', 'GNUmakefile',
      'Rakefile', 'Gemfile', 'Guardfile',
      'Gruntfile', 'gulpfile',
      'webpack.config', 'rollup.config', 'vite.config',
      'tsconfig', 'jsconfig', 'package.json', 'package-lock.json',
      'pom.xml', 'build.gradle', 'build.sbt',
      'requirements.txt', 'setup.py', 'setup.cfg', 'pyproject.toml',
      'Cargo.toml', 'Cargo.lock',
      'go.mod', 'go.sum',
      '.proto', '.graphql', '.gql'

    ]);
  }

  getName(): string {
    return 'TextReader';
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);
    
    try {
      logger.debug(`Reading text file: ${filePath}`);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      
      return {
        content,
        metadata: {
          type: 'text',
          encoding: 'utf-8',
          size: content.length
        }
      };
    } catch (error) {
      logger.error(`Failed to read text file ${filePath}: ${error}`);
      throw new Error(`Failed to read text file: ${error}`);
    }
  }
}