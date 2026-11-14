import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { imageToVideoGuide } from '@media-router/contracts';
import { parseGenerationRequest } from '@media-router/contracts/generation';

const origin = 'https://opengen.dev';
// Match the existing operations UI fixtures. Next preserves JSX in its local tsconfig.
const temporary = await mkdtemp(join(process.cwd(), 'node_modules/.guide-ui-'));
const entry = join(temporary, 'guide.cjs');
await build({
  stdin: {
    contents: `export { default as ImageToVideoGuidePage, metadata } from './apps/web/app/guides/image-to-video/page'; export { GuideBlocks, parseGuide } from './apps/web/app/guides/image-to-video/guide-content'; export { default as ModelSeriesPage } from './apps/web/app/[company]/[series]/page';`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'next/navigation'],
  loader: { '.css': 'empty' },
});
// Page metadata is evaluated on import, before the per-test environment hooks.
vi.stubEnv('OPENGEN_PUBLIC_URL', origin);
const { ImageToVideoGuidePage, metadata, GuideBlocks, parseGuide, ModelSeriesPage } = createRequire(
  import.meta.url,
)(entry) as typeof import('../apps/web/app/guides/image-to-video/guide-content') & {
  ImageToVideoGuidePage: typeof import('../apps/web/app/guides/image-to-video/page').default;
  metadata: typeof import('../apps/web/app/guides/image-to-video/page').metadata;
  ModelSeriesPage: typeof import('../apps/web/app/[company]/[series]/page').default;
};
vi.unstubAllEnvs();
afterAll(() => rm(temporary, { recursive: true, force: true }));
beforeEach(() => vi.stubEnv('OPENGEN_PUBLIC_URL', origin));
afterEach(() => vi.unstubAllEnvs());

describe('canonical image-to-video walkthrough', () => {
  it('renders the Markdown workflow and exact fenced examples in crawlable HTML', () => {
    const markdown = imageToVideoGuide(origin);
    const guide = parseGuide(markdown);
    const examples = guide.sections
      .flatMap((section) => section.blocks)
      .filter((block) => block.type === 'code');
    expect(guide.sections.map((section) => section.id)).toEqual([
      'connect-and-diagnose',
      'inspect-the-exact-model-and-route',
      'upload-privately-and-complete-ownership-checks',
      'build-and-quote-the-canonical-request',
      'submit-once-and-keep-the-receipt',
      'wait-recover-and-retrieve',
      'review-evidence',
    ]);
    expect(examples.map((block) => block.text)).toEqual(
      [...markdown.matchAll(/^```\w*\n([\s\S]*?)\n```/gm)].map((match) => match[1]),
    );
    for (const block of examples) {
      if (block.language === 'json') {
        const example = JSON.parse(block.text);
        if (example.modelId) expect(() => parseGenerationRequest(example)).not.toThrow();
        if (example.operationId === 'media.generate')
          expect(() => parseGenerationRequest(example.input)).not.toThrow();
      }
    }
    const html = renderToStaticMarkup(createElement(ImageToVideoGuidePage));
    expect(html).toContain(`<h1>${guide.title}</h1>`);
    expect(html).toContain('id="submit-once-and-keep-the-receipt"');
    expect(html).toContain('href="/guides/image-to-video.md"');
    expect(html).toContain('href="/agents#support-matrix"');
    expect(html).toContain('opengen generate --input request.json');
    expect(html.match(/aria-label="Billable submission"/g)).toHaveLength(2);
    expect(html).toContain('opengen job recover --idempotency-key ORIGINAL_UNIQUE_KEY');
    expect(html.match(/<pre /g)).toHaveLength(examples.length);
    expect(html).not.toContain('docs/AGENT-QUALIFICATION');
    expect(metadata.alternates?.canonical).toBe(`${origin}/guides/image-to-video`);
  });

  it('escapes content and links only to the configured gateway', () => {
    const guide = parseGuide(
      '# Example\n\n<script>bad()</script> [guide](/agents) [local](https://opengen.dev/docs#agents) [foreign](https://other.example/) [unsafe](javascript:bad)\n\n## Step\n\n```sh\n## literal heading\n<script>code()</script>\n```\n',
    );
    const introduction = renderToStaticMarkup(
      createElement(GuideBlocks, { blocks: guide.introduction, origin }),
    );
    expect(introduction).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(introduction).toContain('href="/agents"');
    expect(introduction).toContain('href="/docs#agents"');
    expect(introduction).not.toContain('href="https://other.example');
    expect(introduction).not.toContain('href="javascript:');
    expect(guide.sections).toHaveLength(1);
    expect(guide.sections[0]!.blocks[0]).toMatchObject({
      type: 'code',
      text: '## literal heading\n<script>code()</script>',
    });
  });

  it.each([
    ['bytedance', 'seedance-2.5', undefined, true],
    ['openai', 'gpt-image-2', undefined, false],
    ['xai', 'grok-imagine-video', 'xai/grok-imagine-video', false],
    ['xai', 'grok-imagine-video', 'xai/grok-imagine-video-1.5', true],
    ['minimax', 'h3', 'fal/h3-max-turbo', true],
    ['qwen', 'image-2.1', undefined, false],
  ])(
    'links from a series only when the selected variant supports a first frame',
    async (company, series, variant, expected) => {
      const page = await ModelSeriesPage({
        params: Promise.resolve({ company, series }),
        searchParams: Promise.resolve(variant ? { variant } : {}),
      });
      expect(renderToStaticMarkup(page).includes('href="/guides/image-to-video"')).toBe(expected);
    },
  );
});
