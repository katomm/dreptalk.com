// Turns ```chart fenced blocks (YAML) in a review edition into inline SVG
// figures at build time. Invalid blocks fail the build with the file and the
// block's index, so a broken chart can never ship as an empty box.
import { parse as parseYaml } from 'yaml';
import { chartSpecSchema, renderFigure } from './charts/index.js';

interface MdNode { type: string; lang?: string | null; value?: string; children?: MdNode[] }

export function transformChartNodes(tree: MdNode, file: string): void {
  let index = 0;
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      if (child.type === 'code' && child.lang === 'chart') {
        index++;
        let raw: unknown;
        try {
          raw = parseYaml(child.value ?? '');
        } catch (e) {
          throw new Error(`${file} chart block ${index}: invalid YAML (${(e as Error).message})`);
        }
        const parsed = chartSpecSchema.safeParse(raw);
        if (!parsed.success) throw new Error(`${file} chart block ${index}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`);
        return { type: 'html', value: renderFigure(parsed.data) };
      }
      walk(child);
      return child;
    });
  };
  walk(tree);
}

/** remark plugin wrapper for astro.config.mjs. Only review editions carry chart blocks. */
export function remarkReviewCharts() {
  return (tree: MdNode, file: { path?: string; history?: string[] }) => {
    const name = file.path ?? file.history?.[0] ?? 'markdown';
    transformChartNodes(tree, name.split('/').pop() ?? name);
  };
}
