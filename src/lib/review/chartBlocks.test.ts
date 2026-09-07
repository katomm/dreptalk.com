import { describe, it, expect } from 'vitest';
import { transformChartNodes } from './chartBlocks.js';

const yaml = `type: bars
title: Votes per epoch
sources: ["votesByEpoch[].votesCast"]
epochSource: "votesByEpoch[].epoch"
epochs: [1, 2]
values: [3, 4]`;

describe('transformChartNodes', () => {
  it('replaces a chart code node with a figure html node', () => {
    const tree = { type: 'root', children: [{ type: 'code', lang: 'chart', value: yaml }, { type: 'code', lang: 'ts', value: 'x' }] } as never;
    transformChartNodes(tree, 'epochs-1-3.md');
    const kids = (tree as { children: Array<{ type: string; value: string }> }).children;
    expect(kids[0].type).toBe('html');
    expect(kids[0].value).toContain('<figure class="rv-chart">');
    expect(kids[1].type).toBe('code');
  });
  it('fails the build with file and block index on an invalid block', () => {
    const tree = { type: 'root', children: [{ type: 'code', lang: 'chart', value: 'type: bars\ntitle: t\nsources: ["x"]\nepochSource: "e"\nepochs: [1]\nvalues: []' }] } as never;
    expect(() => transformChartNodes(tree, 'epochs-1-3.md')).toThrow('epochs-1-3.md chart block 1');
  });
});
