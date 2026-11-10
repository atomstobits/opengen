import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import type { ComponentType } from 'react';
let BillingReview: ComponentType<{ token: string; workspaceId?: string }>;
let operatorBillingRequestInit: (token: string, init?: RequestInit) => RequestInit;
beforeAll(async () => {
  // Next's app tsconfig preserves JSX. Compile this isolated SSR privacy fixture
  // in memory without changing the shared Vitest/web configuration or loading CSS.
  const result = await build({
    entryPoints: ['apps/web/app/operator/billing-review.tsx'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    packages: 'external',
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'css-fixture',
        setup(builder) {
          builder.onLoad({ filter: /\.css$/ }, () => ({
            contents: 'export default {};',
            loader: 'js',
          }));
        },
      },
    ],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', target: 'ES2022', module: 'ESNext' } },
  });
  const mod = {
    exports: {} as {
      BillingReview: typeof BillingReview;
      operatorBillingRequestInit: typeof operatorBillingRequestInit;
    },
  };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  BillingReview = mod.exports.BillingReview;
  operatorBillingRequestInit = mod.exports.operatorBillingRequestInit;
});

describe('standalone private operator billing queue', () => {
  it('never fetches on render or exposes the memory-only operator token', () => {
    const request = vi.fn(() => {
      throw new Error('no automatic fetch');
    });
    vi.stubGlobal('fetch', request);
    try {
      const html = renderToStaticMarkup(
        createElement(BillingReview, {
          token: 'fixture-operator-token-never-rendered',
          workspaceId: 'workspace-a',
        }),
      );
      expect(request).not.toHaveBeenCalled();
      expect(html).not.toContain('fixture-operator-token-never-rendered');
      expect(html).toContain('Refresh review queue');
      expect(html).toContain('The queue has not been fetched.');
      expect(html).not.toContain('type="password"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('sends only the dedicated bearer when the browser has a workspace session', () => {
    const init = operatorBillingRequestInit('fixture-operator-bearer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        authorization: 'Bearer stale-fixture-bearer',
        cookie: 'og_session=fixture',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-operator-bearer');
    expect(new Headers(init.headers).has('cookie')).toBe(false);
  });
  it('provides a signed-out operator state with no implicit authority', () => {
    const html = renderToStaticMarkup(createElement(BillingReview, { token: '' }));
    expect(html).toContain('Connect the installation operator');
    expect(html).toContain('disabled');
    expect(html).not.toContain('Record hold resolution');
  });
});
