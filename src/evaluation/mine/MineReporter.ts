import * as fs from 'fs';
import * as path from 'path';
import { MineResult, MineTool } from './types';

function pct(n: number | undefined): string {
  return n === undefined ? '   —  ' : `${(n * 100).toFixed(2)}%`.padStart(7);
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const TOOL_LABEL: Record<MineTool, string> = {
  wanshi: 'wanshi',
  kggen: 'KGGen',
  graphrag: 'GraphRAG',
  openie: 'OpenIE',
};

/**
 * Four-way MINE comparison table. The "Re-scored" column is the apples-to-apples
 * number (one identical retrieve+judge over all four graphs). "Published" is the
 * KGGen-paper headline — a reference only; it used a different judge/retrieval and
 * must not be conflated with the re-scored column.
 */
export class MineReporter {
  print(result: MineResult): void {
    const sep = '─'.repeat(52);
    console.log('');
    console.log(
      `MINE benchmark (n=${result.sampleCount})  Model: ${result.model}  Judge: ${result.judgeModel}`
    );
    console.log('');
    console.log(`${'Tool'.padEnd(12)}  ${'Re-scored'.padStart(9)}  ${'Published'.padStart(9)}`);
    console.log(sep);

    const order: MineTool[] = ['wanshi', 'kggen', 'graphrag', 'openie'];
    for (const tool of order) {
      const rescored = result.byTool[tool];
      if (rescored === undefined && tool !== 'wanshi') continue;
      const published = tool === 'wanshi' ? undefined : result.published[tool];
      console.log(`${TOOL_LABEL[tool].padEnd(12)}  ${pct(rescored)}  ${pct(published)}`);
    }
    console.log(sep);
    console.log('Re-scored = our identical retrieve+judge over all graphs (comparable).');
    console.log('Published = KGGen-paper headline (different judge/retrieval; reference only).');
    if (result.relatedToShare !== undefined) {
      // Guardrail: a high wanshi `related_to` share means the closed vocab is
      // coercing real predicates away (Bug 1) — it caps the recall ceiling on MINE.
      console.log(
        `wanshi vocab fit: ${(result.relatedToShare * 100).toFixed(0)}% of relations are 'related_to' ` +
          `(high ⇒ closed vocab is coercing predicates; hurts MINE recall)`
      );
    }
    console.log('');
    console.log(`Duration: ${fmtDuration(result.durationMs)}`);
    console.log('');
  }

  save(result: MineResult, outputPath: string): void {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`Report saved to: ${outputPath}`);
  }
}
