import { expect, test, type Page } from '@playwright/test';
import { catalog, quote } from '@media-router/catalog';
import type { GenerateInput, Job } from '@media-router/contracts';

// Synthetic gateway only. No provider traffic, credentials, or actual billable jobs.
const modelId = 'alibaba/wan-3.0';
const routeId = 'alibaba/ap-southeast-1/wan-3.0';
const playground = `/playground?model=${encodeURIComponent(modelId)}&route=${encodeURIComponent(routeId)}`;
const imagePlayground = '/playground?model=openai%2Fgpt-image-2';
const authorizedSession = {
  authenticated: true,
  workspaceId: 'fixture-workspace-a',
  recoveryScope: 'fixture-identity-a',
  scopes: ['read', 'generate'],
  oidcEnabled: false,
};

function job(
  input: GenerateInput,
  workspaceId = authorizedSession.workspaceId,
  id = 'fixture-job-a',
): Job {
  const selectedRoute =
    catalog.routes.find((route) => route.id === input.routeId) ??
    catalog.routes.find((route) => route.modelId === input.modelId)!;
  return {
    id,
    workspaceId,
    status: 'succeeded',
    input,
    routeId: selectedRoute.id,
    deploymentId: selectedRoute.deploymentId,
    upstreamId: null,
    outputs: [
      {
        url: 'https://owned.example/private/fixture-output.png',
        mediaType: 'image/png',
        fidelity: 'unverified',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    ],
    error: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    reservedMicros: input.billing === 'byok' ? 0 : 10000,
    settledMicros: input.billing === 'byok' ? 0 : 10000,
    attemptCount: 1,
    deliveryStatus: 'available',
  };
}

async function gateway(
  page: Page,
  options: { authenticated?: boolean; timeoutFirst?: boolean; frozenSnapshot?: boolean } = {},
) {
  const quotes: GenerateInput[] = [];
  const submissions: { input: GenerateInput; key: string | undefined }[] = [];
  const reads: string[] = [];
  const lookups: (string | undefined)[] = [];
  let session = { ...authorizedSession, authenticated: options.authenticated ?? true };
  let delayedQuote: { release: () => void; entered: Promise<void> } | undefined;
  let quoteGate: Promise<void> | undefined;
  let quoteEntered: (() => void) | undefined;
  let submissionGate: Promise<void> | undefined;
  let submissionEntered: (() => void) | undefined;
  await page.route('**/api/session', async (route) => {
    if (route.request().method() === 'DELETE') session = { ...session, authenticated: false };
    await route.fulfill({ json: session });
  });
  await page.route('**/api/quotes', async (route) => {
    const input = route.request().postDataJSON() as GenerateInput;
    quotes.push(input);
    quoteEntered?.();
    if (quoteGate) await quoteGate;
    await route.fulfill({
      json: quote(input, { executableRouteIds: catalog.routes.map((entry) => entry.id) }),
    });
  });
  await page.route('**/api/generations**', async (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as GenerateInput;
      submissions.push({ input, key: route.request().headers()['idempotency-key'] });
      submissionEntered?.();
      if (submissionGate) await submissionGate;
      if (options.timeoutFirst && submissions.length === 1) {
        await route.fulfill({
          status: 503,
          json: {
            error: 'Synthetic submission timeout. Acceptance is unknown; retry the saved request.',
          },
        });
      } else {
        const snapshot: GenerateInput = options.frozenSnapshot
          ? {
              ...input,
              input: { ...input.input, firstFrame: { assetKey: 'inputs/frozen-first-frame.png' } },
              routing: { ...input.routing, endpointRegions: ['ap-southeast-1'] },
            }
          : input;
        await route.fulfill({
          json: job(
            snapshot,
            session.workspaceId,
            submissions.length > 1 ? 'fixture-job-b' : 'fixture-job-a',
          ),
        });
      }
    } else {
      const url = route.request().url();
      reads.push(url);
      const lookup = url.endsWith('/api/generations/lookup');
      const key = route.request().headers()['idempotency-key'];
      if (lookup) lookups.push(key);
      const last = lookup
        ? submissions.find((entry) => entry.key === key)?.input
        : submissions.at(-1)?.input;
      await route.fulfill({
        status: last ? 200 : 404,
        json: last ? job(last, session.workspaceId) : { error: 'No fixture job.' },
      });
    }
  });
  await page.route('https://owned.example/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZrJQAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  return {
    quotes,
    submissions,
    reads,
    lookups,
    switchIdentity(identity: string, workspaceId = 'fixture-workspace-b') {
      session = { ...authorizedSession, workspaceId, recoveryScope: identity };
    },
    delaySubmission() {
      let release!: () => void;
      submissionGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        submissionEntered = resolve;
      });
      return { release, entered };
    },
    delayQuote() {
      let release!: () => void;
      quoteGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        quoteEntered = resolve;
      });
      delayedQuote = { release, entered };
      return delayedQuote;
    },
  };
}

async function jsonEditor(page: Page) {
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  return page.getByRole('textbox', { name: 'Canonical request JSON', exact: true });
}

async function applyJson(page: Page, request: GenerateInput) {
  const editor = await jsonEditor(page);
  await editor.fill(JSON.stringify(request, null, 2));
  await page.getByRole('button', { name: 'Apply JSON', exact: true }).click();
}

async function exportedRequest(page: Page): Promise<GenerateInput> {
  const instructions = page.getByRole('region', { name: 'API and agent instructions' });
  const copy = instructions.getByRole('button', { name: 'Copy request JSON', exact: true });
  if (!(await copy.count()))
    await instructions.getByRole('button', { name: 'Use the API', exact: true }).click();
  const content = await copy.locator('..').locator('code').innerText();
  return JSON.parse(content) as GenerateInput;
}

const videoRequest: GenerateInput = {
  modelId,
  operation: 'image-to-video',
  input: {
    firstFrame: { url: 'https://assets.example/first.png' },
    lastFrame: { url: 'https://assets.example/last.png' },
    resolution: '720p',
    duration: 5,
    aspectRatio: '16:9',
    seed: 42,
    audio: false,
    watermark: false,
  },
  routeId,
  billing: 'managed',
  maxCostMicros: 2000000,
};

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`${viewport.name}: canonical JSON/form parity keeps explicit model options and regional pin`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const stub = await gateway(page);
    await page.goto(playground);
    await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
    await applyJson(page, videoRequest);
    await page.getByRole('button', { name: 'Form', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Operation', exact: true })).toHaveValue(
      'image-to-video',
    );
    await expect(page.getByLabel('Provider route', { exact: true })).toHaveValue(routeId);
    const exported = await exportedRequest(page);
    expect(exported).toEqual(videoRequest);
    await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
    await expect.poll(() => stub.quotes.length).toBe(1);
    expect(stub.quotes[0]).toEqual(exported);
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
    expect(stub.submissions).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.screenshot({
      path: test.info().outputPath(`canonical-parity-${viewport.name}.png`),
      fullPage: true,
    });
  });
}

test('invalid JSON import is atomic and valid advanced image settings survive form edits', async ({
  page,
}) => {
  const stub = await gateway(page);
  await page.goto(imagePlayground);
  const request: GenerateInput = {
    modelId: 'openai/gpt-image-2',
    operation: 'text-to-image',
    input: {
      prompt: 'A private paper garden.',
      resolution: '1K',
      aspectRatio: '1:1',
      quality: 'high',
      count: 3,
      outputFormat: 'png',
      background: 'transparent',
    },
    billing: 'managed',
    maxCostMicros: 1500000,
  };
  await applyJson(page, request);
  const editor = await jsonEditor(page);
  await editor.fill('{ "modelId": "openai/gpt-image-2", "input":');
  await page.getByRole('button', { name: 'Apply JSON', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Generation workspace' }).getByRole('alert'),
  ).toContainText(/JSON|valid|parse|unexpected/i);
  await page.getByRole('button', { name: 'Form', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
    request.input.prompt!,
  );
  await expect(page.getByRole('button', { name: 'Get a quote', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await page.getByRole('button', { name: 'Discard JSON edits', exact: true }).click();
  await page.getByRole('button', { name: 'Form', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('A revised private paper garden.');
  const exported = await exportedRequest(page);
  expect(exported).toEqual({
    ...request,
    input: { ...request.input, prompt: 'A revised private paper garden.' },
  });
  expect(stub.submissions).toEqual([]);
});

test('an old quote response cannot authorize changed input', async ({ page }) => {
  const stub = await gateway(page);
  await page.goto(playground);
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('The first private prompt.');
  const delayed = stub.delayQuote();
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await delayed.entered;
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('A different private prompt.');
  delayed.release();
  await expect(page.getByRole('button', { name: 'Get a quote', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
  await expect(page.getByText(/^Quote details/)).toHaveCount(0);
  expect(stub.submissions).toEqual([]);
});

test('submission timeout and reload retain the immutable idempotency key', async ({ page }) => {
  const stub = await gateway(page, { timeoutFirst: true });
  await page.goto(playground);
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('The same private request survives a timeout.');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Generation workspace' }).getByRole('alert'),
  ).toContainText('Synthetic submission timeout');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
    'The same private request survives a timeout.',
  );
  await page.getByRole('button', { name: 'Recover same request', exact: true }).click();
  await expect(page.getByText('fixture-job-a', { exact: true })).toBeVisible();
  expect(stub.submissions).toHaveLength(1);
  expect(stub.submissions[0]!.key).toBeTruthy();
  expect(stub.lookups).toEqual([stub.submissions[0]!.key]);
});

test('logout clears private inputs and outputs and a different identity cannot restore them', async ({
  page,
}) => {
  const stub = await gateway(page);
  await page.goto(playground);
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('Workspace A private idea.');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('fixture-job-a', { exact: true })).toBeVisible();
  await expect(page.getByAltText('Generated output', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('fixture-job-a', { exact: true })).toHaveCount(0);
  await expect(page.getByAltText('Generated output', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('');
  stub.switchIdentity('fixture-identity-b');
  await page.reload();
  await expect(page.getByText('Connected to', { exact: false })).toContainText(
    'fixture-workspace-b',
  );
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('');
  await expect(page.getByText('fixture-job-a', { exact: true })).toHaveCount(0);
});

test('unattributed model-only browser keys are retired without restoring private data', async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'opengen:draft:alibaba/wan-3.0',
      JSON.stringify({ prompt: 'Unsafe legacy private prompt.' }),
    );
    sessionStorage.setItem('media-router:job:alibaba/wan-3.0', 'foreign-old-job');
    sessionStorage.setItem(
      'media-router:submission:alibaba/wan-3.0',
      JSON.stringify({ key: 'foreign-key', fingerprint: '{}' }),
    );
  });
  const stub = await gateway(page);
  await page.goto(playground);
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await expect(page.getByText('Connected to', { exact: false })).toContainText(
    'fixture-workspace-a',
  );
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('');
  expect(
    await page.evaluate(() => [
      sessionStorage.getItem('opengen:draft:alibaba/wan-3.0'),
      sessionStorage.getItem('media-router:job:alibaba/wan-3.0'),
      sessionStorage.getItem('media-router:submission:alibaba/wan-3.0'),
    ]),
  ).toEqual([null, null, null]);
  expect(stub.reads).toEqual([]);
  expect(stub.submissions).toEqual([]);
});

test('late submission response cannot restore private output after logout', async ({ page }) => {
  const stub = await gateway(page);
  await page.goto(playground);
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('A private pending request.');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  const delayed = stub.delaySubmission();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await delayed.entered;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const received = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/generations') && response.request().method() === 'POST',
  );
  delayed.release();
  await received;
  await expect(page.getByText('fixture-job-a', { exact: true })).toHaveCount(0);
  await expect(page.getByAltText('Generated output', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('');
  expect(stub.submissions).toHaveLength(1);
});

test('another authorized identity in the same workspace cannot restore a private tab draft', async ({
  page,
}) => {
  const stub = await gateway(page);
  await page.goto(playground);
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('Private to the original browser identity.');
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(sessionStorage).some(
          (key) =>
            key.startsWith('opengen.playground.v1:') &&
            sessionStorage.getItem(key)?.includes('Private to the original browser identity.'),
        ),
      ),
    )
    .toBe(true);
  stub.switchIdentity('fixture-identity-b', authorizedSession.workspaceId);
  await page.reload();
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('');
  expect(stub.submissions).toEqual([]);
  expect(stub.reads).toEqual([]);
});

test('copying existing job settings restores a form without another submission', async ({
  page,
}) => {
  const stub = await gateway(page);
  await page.goto(playground);
  await applyJson(page, videoRequest);
  await page.getByRole('button', { name: 'Form', exact: true }).click();
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('fixture-job-a', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy settings to form', exact: true }).click();
  await expect(
    page.getByText('Job settings copied to this draft. Get a fresh quote before generating.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(await exportedRequest(page)).toEqual(videoRequest);
  expect(stub.submissions).toHaveLength(1);
});

test('a private result survives a new draft and a paid retry requires a fresh quote', async ({
  page,
}) => {
  const stub = await gateway(page, { frozenSnapshot: true });
  await page.goto(playground);
  await applyJson(page, videoRequest);
  await page.getByRole('button', { name: 'Form', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await prompt.fill('Original private render.');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('fixture-job-a', { exact: true })).toBeVisible();

  await prompt.fill('Edited private draft.');
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Response JSON', exact: true }).click();
  const response = page.getByLabel('Private response JSON', { exact: true });
  await expect(response).toContainText('Original private render.');
  await expect(response).not.toContainText('owned.example');
  await expect(response).not.toContainText('Edited private draft.');

  await page.getByRole('button', { name: 'Prepare a new attempt', exact: true }).click();
  await expect(prompt).toHaveValue('Original private render.');
  const generate = page.getByRole('button', { name: 'Generate new attempt', exact: true });
  await expect(generate).toBeDisabled();
  expect(stub.submissions).toHaveLength(1);
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(page.getByText('fixture-job-b', { exact: true })).toBeVisible();
  expect(stub.quotes).toHaveLength(2);
  expect(stub.submissions).toHaveLength(2);
  expect(stub.submissions[1]?.input).toMatchObject({
    input: {
      prompt: 'Original private render.',
      firstFrame: { assetKey: 'inputs/frozen-first-frame.png' },
    },
    routing: { endpointRegions: ['ap-southeast-1'] },
  });
  expect(stub.submissions[1]?.key).not.toBe(stub.submissions[0]?.key);
});

test('unknown image pricing cannot enable managed or capped BYOK generation', async ({ page }) => {
  const stub = await gateway(page);
  await page.goto(imagePlayground);
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('A synthetic unknown-price image.');
  const generate = page.getByRole('button', { name: 'Generate', exact: true });
  const quoteButton = page.getByRole('button', { name: 'Get a quote', exact: true });
  await quoteButton.click();
  await expect.poll(() => stub.quotes.length).toBe(1);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Request price is not qualified; comparison only.' }),
  ).toBeVisible();
  await expect(generate).toBeDisabled();
  expect(stub.quotes[0]).toMatchObject({ billing: 'managed', maxCostMicros: 2000000 });

  await page.getByRole('combobox', { name: 'Pay with', exact: true }).selectOption('byok');
  await expect(generate).toBeDisabled();
  await quoteButton.click();
  await expect.poll(() => stub.quotes.length).toBe(2);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Request price is not qualified; comparison only.' }),
  ).toBeVisible();
  await expect(generate).toBeDisabled();
  expect(stub.quotes[1]).toMatchObject({ billing: 'byok', maxCostMicros: 2000000 });

  await page.getByRole('spinbutton', { name: 'Maximum spend, USD', exact: true }).fill('');
  await expect(generate).toBeDisabled(); // A meaningful edit invalidates the old quote.
  await quoteButton.click();
  await expect.poll(() => stub.quotes.length).toBe(3);
  await expect(generate).toBeEnabled();
  expect(stub.quotes[2]?.billing).toBe('byok');
  expect(stub.quotes[2]).not.toHaveProperty('maxCostMicros');
  expect(stub.submissions).toEqual([]);
});

async function submitImageFixture(page: Page) {
  await page.goto(imagePlayground);
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('A private studio still life.');
  // GPT Image 2 has no qualified managed tariff. This synthetic gateway
  // explicitly models a configured provider account, with its unknown external
  // exposure accepted by removing the optional cap before quoting.
  await page.getByRole('combobox', { name: 'Pay with', exact: true }).selectOption('byok');
  await page.getByRole('spinbutton', { name: 'Maximum spend, USD', exact: true }).fill('');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('fixture-job-a', { exact: true })).toBeVisible();
  const reuseRole = page.getByRole('combobox', { name: 'Reuse output as', exact: true });
  await expect(reuseRole).toBeVisible();
  await reuseRole.selectOption({ label: 'image-edit · image reference' });
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`${viewport.name}: owned output reuse registers an input with private lineage without regenerating`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const stub = await gateway(page);
    const registrations: { body: unknown; key: string | undefined }[] = [];
    await page.route('**/api/assets/reuse', async (route) => {
      registrations.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      await route.fulfill({
        json: {
          assetKey: 'inputs/fixture-reused.png',
          state: 'ready',
          mediaType: 'image/png',
          expiresAt: null,
          deletionPending: false,
        },
      });
    });
    await submitImageFixture(page);
    await page.getByRole('button', { name: 'Use output as input', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Operation', exact: true })).toHaveValue(
      'image-edit',
    );
    const reuseConfirmation = page
      .getByRole('status')
      .filter({ hasText: 'Private parent job fixture-job-a, output 1.' });
    await expect(reuseConfirmation).toBeVisible();
    await expect(reuseConfirmation).toContainText(
      'Settings restored; review and quote before generating.',
    );
    const request = await exportedRequest(page);
    expect(request.input.references).toEqual([
      { type: 'image', asset: { assetKey: 'inputs/fixture-reused.png' } },
    ]);
    expect(JSON.stringify(request.input)).not.toContain('owned.example');
    expect(JSON.stringify(request.input)).not.toContain('storageKey');
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.body).toEqual({ sourceJobId: 'fixture-job-a', outputIndex: 0 });
    expect(registrations[0]!.key).toMatch(/^browser-reuse-[a-f0-9]{64}$/);
    expect(stub.submissions).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.screenshot({
      path: test.info().outputPath(`owned-reuse-${viewport.name}.png`),
      fullPage: true,
    });
  });
}

for (const state of ['expired', 'deleted'] as const) {
  test(`${state} owned reuse leaves the original request intact`, async ({ page }) => {
    const stub = await gateway(page);
    await page.route('**/api/assets/reuse', (route) =>
      route.fulfill({
        json: {
          assetKey: 'inputs/unusable.png',
          state,
          mediaType: 'image/png',
          expiresAt: state === 'expired' ? '2020-01-01T00:00:00.000Z' : null,
          deletionPending: state === 'deleted',
        },
      }),
    );
    await submitImageFixture(page);
    const original = await exportedRequest(page);
    await page.getByRole('button', { name: 'Use output as input', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Generation workspace' }).getByRole('alert'),
    ).toContainText(`Owned input is ${state}`);
    expect(await exportedRequest(page)).toEqual(original);
    await expect(page.getByRole('combobox', { name: 'Operation', exact: true })).toHaveValue(
      'text-to-image',
    );
    expect(stub.submissions).toHaveLength(1);
  });
}

test('same-operation owned reuse retains a pinned route that conflicts with draft region filters', async ({
  page,
}) => {
  const stub = await gateway(page);
  const registrations: unknown[] = [];
  await page.route('**/api/assets/reuse', (route) => {
    registrations.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        assetKey: 'inputs/fixture-pinned-frame.png',
        state: 'ready',
        mediaType: 'image/png',
        expiresAt: null,
        deletionPending: false,
      },
    });
  });
  await page.goto(playground);
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await applyJson(page, videoRequest);
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('fixture-job-a', { exact: true })).toBeVisible();

  const routing = { endpointRegions: ['eu-central-1'], fallback: false };
  await applyJson(page, { ...videoRequest, routing });
  await page
    .getByRole('combobox', { name: 'Reuse output as', exact: true })
    .selectOption({ label: 'image-to-video · first frame' });
  await page.getByRole('button', { name: 'Use output as input', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'First frame owned input key', exact: true }),
  ).toHaveValue('inputs/fixture-pinned-frame.png');
  await expect(page.getByRole('combobox', { name: 'Provider route', exact: true })).toHaveValue(
    routeId,
  );
  expect(await exportedRequest(page)).toMatchObject({
    modelId,
    operation: 'image-to-video',
    routeId,
    routing,
    input: { firstFrame: { assetKey: 'inputs/fixture-pinned-frame.png' } },
  });
  expect(registrations).toEqual([{ sourceJobId: 'fixture-job-a', outputIndex: 0 }]);
  expect(stub.submissions).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
});

test('foreign output reuse fails without replacing the current request or submitting work', async ({
  page,
}) => {
  const stub = await gateway(page);
  await page.route('**/api/assets/reuse', (route) =>
    route.fulfill({
      status: 403,
      json: { error: 'Owned output is unavailable in this workspace.' },
    }),
  );
  await submitImageFixture(page);
  const original = await exportedRequest(page);
  await page.getByRole('button', { name: 'Use output as input', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Generation workspace' }).getByRole('alert'),
  ).toContainText('Owned output is unavailable in this workspace.');
  expect(await exportedRequest(page)).toEqual(original);
  expect(stub.submissions).toHaveLength(1);
});

test('a private GPT Image output can prepare a Wan first-frame draft', async ({ page }) => {
  const stub = await gateway(page);
  await page.route('**/api/assets/reuse', (route) =>
    route.fulfill({
      json: {
        assetKey: 'inputs/fixture-wan-frame.png',
        state: 'ready',
        mediaType: 'image/png',
        expiresAt: null,
        deletionPending: false,
      },
    }),
  );
  await submitImageFixture(page);
  const routing: GenerateInput['routing'] = {
    providerIds: ['alibaba'],
    deploymentIds: ['alibaba-model-studio-ap-southeast-1'],
    endpointRegions: ['ap-southeast-1'],
    processingScopes: ['international'],
    fidelity: 'any',
    fallback: false,
  };
  await applyJson(page, { ...(await exportedRequest(page)), routing });
  await page
    .getByRole('combobox', { name: 'Destination model', exact: true })
    .selectOption(modelId);
  await page
    .getByRole('combobox', { name: 'Reuse output as', exact: true })
    .selectOption({ label: 'image-to-video · first frame' });
  await page
    .getByRole('combobox', { name: 'Destination provider route', exact: true })
    .selectOption(routeId);
  await page.getByRole('button', { name: 'Use output as input', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Operation', exact: true })).toHaveValue(
    'image-to-video',
  );
  await expect(
    page.getByRole('textbox', { name: 'First frame owned input key', exact: true }),
  ).toHaveValue('inputs/fixture-wan-frame.png');
  await expect(page.getByText('fixture-job-a', { exact: true })).toBeVisible();
  expect(await exportedRequest(page)).toMatchObject({
    modelId,
    operation: 'image-to-video',
    routeId,
    routing,
    input: { firstFrame: { assetKey: 'inputs/fixture-wan-frame.png' } },
  });
  expect(page.url()).not.toContain('fixture-wan-frame');
  expect(stub.submissions).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
});

test('cross-model reuse cannot remove draft processing or fidelity requirements', async ({
  page,
}) => {
  const stub = await gateway(page);
  let registrations = 0;
  await page.route('**/api/assets/reuse', (route) => {
    registrations++;
    return route.fulfill({ status: 500, json: { error: 'Registration should remain disabled.' } });
  });
  await submitImageFixture(page);
  const defaultDraft = await exportedRequest(page);
  await page
    .getByRole('combobox', { name: 'Destination model', exact: true })
    .selectOption(modelId);
  await page
    .getByRole('combobox', { name: 'Reuse output as', exact: true })
    .selectOption({ label: 'image-to-video · first frame' });
  await expect(
    page.getByRole('button', { name: 'Use output as input', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('No destination route satisfies', { exact: false })).toBeVisible();
  expect(await exportedRequest(page)).toEqual(defaultDraft);
  const routing: GenerateInput['routing'] = {
    endpointRegions: ['ap-southeast-1'],
    processingRegions: ['ap-southeast-1'],
    processingScopes: ['international'],
    fidelity: 'native',
    fallback: false,
  };
  const original = { ...defaultDraft, routing };
  await applyJson(page, original);
  await page
    .getByRole('combobox', { name: 'Destination model', exact: true })
    .selectOption(modelId);
  await page
    .getByRole('combobox', { name: 'Reuse output as', exact: true })
    .selectOption({ label: 'image-to-video · first frame' });
  await expect(
    page.getByRole('button', { name: 'Use output as input', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('No destination route satisfies', { exact: false })).toBeVisible();
  expect(await exportedRequest(page)).toEqual(original);
  expect(registrations).toBe(0);
  expect(stub.submissions).toHaveLength(1);
});

test('phone uploads and pasted images append ordered, named private references', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stub = await gateway(page);
  let uploadCount = 0;
  await page.route('**/api/assets', (route) => {
    const key = `inputs/fixture-reference-${++uploadCount}.png`;
    return route.fulfill({
      json: { key, uploadUrl: `https://upload.example/${key}`, headers: {} },
    });
  });
  await page.route('https://upload.example/**', (route) => route.fulfill({ status: 200 }));
  await page.route('**/api/assets/complete', (route) =>
    route.fulfill({
      json: {
        state: 'ready',
        assetKey: route.request().postDataJSON().key,
        expiresAt: null,
        deletionPending: false,
      },
    }),
  );
  await page.goto('/playground?model=openai%2Fgpt-image-2&operation=image-edit');
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('Edit these private references.');
  const upload = page.getByLabel('Upload new reference image', { exact: true });
  await upload.setInputFiles({
    name: 'first-reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from('fixture'),
  });
  await expect(page.getByText('first-reference.png', { exact: true })).toBeVisible();
  await upload.evaluate((input) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File(['fixture'], 'pasted-reference.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
  });
  await expect(page.getByText('pasted-reference.png', { exact: true })).toBeVisible();
  expect((await exportedRequest(page)).input.references).toEqual([
    { type: 'image', asset: { assetKey: 'inputs/fixture-reference-1.png' } },
    { type: 'image', asset: { assetKey: 'inputs/fixture-reference-2.png' } },
  ]);
  expect(stub.submissions).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
