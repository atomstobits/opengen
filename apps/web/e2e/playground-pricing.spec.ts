import { expect, test, type Page } from '@playwright/test';
import { catalog, quote } from '@media-router/catalog';
import type { GenerateInput, Job } from '@media-router/contracts';
import { playgroundHref } from '../app/links';

const wanRouteId = 'alibaba/ap-southeast-1/wan-3.0';
const imageModelId = 'openai/gpt-image-2';
const wanModelId = 'alibaba/wan-3.0';
const cookbookInput =
  'https://raw.githubusercontent.com/openai/openai-cookbook/d310dfa05d20fb653caa9c1c4b89ac1a4aeeeae4/images/output_images/billboard_gpt-image-2.png';

async function stubGateway(page: Page) {
  const submissions: GenerateInput[] = [];
  const quotes: GenerateInput[] = [];
  let quoteFailure = false;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        workspaceId: 'fixture-workspace',
        recoveryScope: 'fixture-identity',
        scopes: ['read', 'generate'],
      },
    }),
  );
  await page.route('**/api/quotes', (route) => {
    if (quoteFailure)
      return route.fulfill({ status: 503, json: { error: 'Fixture quote gateway unavailable.' } });
    const input = route.request().postDataJSON() as GenerateInput;
    quotes.push(input);
    return route.fulfill({
      json: quote(input, { executableRouteIds: catalog.routes.map((entry) => entry.id) }),
    });
  });
  await page.route('**/api/generations', (route) => {
    expect(route.request().method()).toBe('POST');
    const input = route.request().postDataJSON() as GenerateInput;
    submissions.push(input);
    const selected = catalog.routes.find((entry) => entry.id === input.routeId)!;
    const result: Job = {
      id: 'fixture-approved-job',
      workspaceId: 'fixture-workspace',
      status: 'succeeded',
      input,
      routeId: selected.id,
      deploymentId: selected.deploymentId,
      upstreamId: null,
      outputs: [],
      error: null,
      createdAt: '2026-11-06T00:00:00Z',
      updatedAt: '2026-11-06T00:00:00Z',
      reservedMicros: 100_000,
      settledMicros: 100_000,
      attemptCount: 1,
      deliveryStatus: 'available',
    };
    return route.fulfill({ json: result });
  });
  return {
    submissions,
    quotes,
    failQuote: () => {
      quoteFailure = true;
    },
  };
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`${viewport.name}: Wan pricing, quote approval, private result and public setup link`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const gateway = await stubGateway(page);
    await page.goto(playgroundHref(wanModelId, wanRouteId, 'image-to-video'));
    await expect(page.getByRole('combobox', { name: 'Operation' })).toHaveValue('image-to-video');
    const pricing = page.getByRole('region', { name: 'Wan 3.0 pricing' });
    const quoteButton = page.getByRole('button', { name: 'Get a quote', exact: true });
    const generate = page.getByRole('button', { name: 'Generate', exact: true });
    if (viewport.name === 'phone') {
      await expect(quoteButton).toBeInViewport();
      await expect(generate).toBeInViewport();
      await expect(page.getByRole('link', { name: 'Result', exact: true })).toBeInViewport();
    }
    await expect(pricing).toContainText('$0.10 USD / output second · 720p');
    await expect(pricing).toContainText('Alibaba Cloud · Model Studio · SG');
    await expect(pricing.getByRole('link', { name: 'Price source ↗' })).toHaveAttribute(
      'href',
      /wan3-0-video/,
    );
    await expect(generate).toBeDisabled();

    const example = page
      .locator('details')
      .filter({ hasText: 'Animate a roadside billboard scene' });
    await example.locator('summary').click();
    await expect(example.locator('summary')).toContainText('Input example');
    await expect(example.getByRole('img')).toHaveCount(1);
    await expect(example.getByRole('img')).toHaveAttribute(
      'src',
      '/playground-examples/billboard-sunset.webp',
    );
    await expect(example.getByText('Published result', { exact: true })).toHaveCount(0);
    await expect(example.locator('video')).toHaveCount(0);
    await page.getByRole('button', { name: 'Use example in draft' }).click();
    await expect(page.getByRole('textbox', { name: 'First frame URL', exact: false })).toHaveValue(
      cookbookInput,
    );
    await expect(page.getByRole('combobox', { name: 'Duration', exact: true })).toHaveValue('2');
    await expect(page.getByRole('combobox', { name: 'Resolution', exact: true })).toHaveValue(
      '480p',
    );
    await expect(page.getByRole('combobox', { name: 'Aspect ratio', exact: true })).toHaveValue('');
    await expect(pricing).toContainText('$0.05 USD / output second · 480p');
    expect(gateway.quotes).toEqual([]);
    expect(gateway.submissions).toEqual([]);
    await expect(generate).toBeDisabled();
    await example.locator('summary').click();
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
    await prompt.fill('Private fixture prompt');
    await page
      .getByRole('textbox', { name: 'First frame URL', exact: false })
      .fill('https://media.example/reference.png');
    await expect(page).toHaveURL(playgroundHref(wanModelId, wanRouteId, 'image-to-video'));
    await expect(quoteButton).toBeEnabled();
    await pricing.focus();
    for (let step = 0; step < 8; step++) {
      await page.keyboard.press('Tab');
      if (await quoteButton.evaluate((element) => element === document.activeElement)) break;
    }
    await expect(quoteButton).toBeFocused();
    await expect(quoteButton).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
    await expect(pricing).toContainText('Quoted route');
    await expect(pricing).toContainText('Credit hold at submission');
    await expect(pricing).toContainText('$0.10');
    expect(gateway.quotes).toHaveLength(1);
    expect(gateway.quotes[0]!.input).toMatchObject({
      duration: 2,
      resolution: '480p',
      count: 1,
      aspectRatio: 'source',
    });
    await expect(generate).toBeEnabled();
    expect(gateway.submissions).toEqual([]);
    await pricing.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`wan-pricing-${viewport.name}.png`) });
    await generate.click();
    const result = page.locator('#playground-result');
    if (viewport.name === 'phone') {
      const resultLink = page.getByRole('link', { name: 'Result · succeeded' });
      await expect(resultLink).toBeInViewport();
      await resultLink.click();
      await expect(result).toBeFocused();
    }
    await expect(result).toContainText('$0.10');
    await prompt.fill('Changed private draft');
    await expect(generate).toBeDisabled();
    await expect(result).toContainText('$0.10');
    expect(gateway.submissions).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  });

  test(`${viewport.name}: GPT Image 2 edit distinguishes the published tariff from unknown request pricing`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const gateway = await stubGateway(page);
    await page.goto(playgroundHref(imageModelId, undefined, 'image-edit'));
    await expect(page.getByRole('combobox', { name: 'Operation' })).toHaveValue('image-edit');
    const pricing = page.getByRole('region', { name: 'GPT Image 2 pricing' });
    const quoteButton = page.getByRole('button', { name: 'Get a quote', exact: true });
    await expect(pricing).toContainText('≈$0.047–$0.0527 USD / output image · 1K');
    await expect(page.getByRole('combobox', { name: 'Endpoint region' })).toHaveCount(0);
    await expect(page.getByLabel('Provider route', { exact: true }).locator('option')).toHaveText([
      'Automatic routing',
      'OpenAI',
      'fal',
      'Pika',
      'Replicate',
      'Runway',
    ]);
    await pricing.locator('summary', { hasText: 'View 5 regional route prices' }).click();
    await expect(pricing).toContainText('≈$0.0527 USD / output image · 1K');
    await expect(pricing).not.toContainText(/not disclosed/i);
    await expect(
      pricing.locator('li', { hasText: 'OpenAI' }).getByRole('link', { name: 'Price source ↗' }),
    ).toHaveAttribute('href', /image-generation-models/);
    const example = page
      .locator('details')
      .filter({ hasText: 'Change the season in a billboard scene' });
    await example.locator('summary').click();
    await expect(example.getByText('Published result', { exact: true })).toBeVisible();
    const images = example.getByRole('img');
    await expect(images).toHaveCount(2);
    await expect(images.nth(0)).toHaveAttribute(
      'src',
      '/playground-examples/billboard-sunset.webp',
    );
    await expect(images.nth(1)).toHaveAttribute(
      'src',
      '/playground-examples/billboard-winter.webp',
    );
    await page.getByRole('button', { name: 'Use example in draft' }).click();
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
      'Make it look like a winter evening with snowfall.',
    );
    await expect(page.getByRole('textbox', { name: 'Reference 1 URL', exact: false })).toHaveValue(
      cookbookInput,
    );
    await quoteButton.click();
    await expect(pricing).toContainText('Unavailable');
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
    await pricing.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`gpt-edit-pricing-${viewport.name}.png`) });
    gateway.failQuote();
    await quoteButton.click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Fixture quote gateway unavailable.' }),
    ).toBeVisible();
    expect(gateway.submissions).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  });
}

test('a region setup link restores operation and narrows routing without a pinned provider', async ({
  page,
}) => {
  await stubGateway(page);
  const href = playgroundHref(wanModelId, undefined, 'image-to-video', 'eu-central-1');
  await page.goto(href);
  await expect(page.getByRole('combobox', { name: 'Operation' })).toHaveValue('image-to-video');
  await expect(page.getByRole('combobox', { name: 'Endpoint region' })).toHaveValue('eu-central-1');
  await expect(page.getByRole('combobox', { name: 'Provider route' })).toHaveValue('auto');
  await expect(page.getByRole('region', { name: 'Wan 3.0 pricing' })).toContainText(
    'Alibaba Cloud · Model Studio · DE',
  );
  await page.reload();
  await expect(page).toHaveURL(href);
  await expect(page.getByRole('combobox', { name: 'Endpoint region' })).toHaveValue('eu-central-1');
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  const changed = await page.evaluate(() => {
    let changed = 0;
    for (const key of Object.keys(sessionStorage)) {
      if (!key.endsWith(':draft')) continue;
      const record = JSON.parse(sessionStorage.getItem(key)!);
      record.value.routing = {
        ...record.value.routing,
        providerIds: ['fal'],
        deploymentIds: ['fal-undisclosed'],
      };
      sessionStorage.setItem(key, JSON.stringify(record));
      changed++;
    }
    return changed;
  });
  expect(changed).toBeGreaterThan(0);
  await page.reload();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const restored = JSON.parse(await page.getByLabel('Canonical request JSON').inputValue());
  expect(restored.routing.endpointRegions).toEqual(['eu-central-1']);
  expect(restored.routing.providerIds).toBeUndefined();
  expect(restored.routing.deploymentIds).toBeUndefined();
});

test('published pricing follows the current model provider exception in both directions', async ({
  page,
}) => {
  const gateway = await stubGateway(page);
  await page.goto(playgroundHref(wanModelId, undefined, 'text-to-video'));
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Canonical request JSON', exact: true });
  const apply = page.getByRole('button', { name: 'Apply JSON', exact: true });
  const pricing = page.getByRole('region', { name: 'Wan 3.0 pricing' });
  const request: GenerateInput = {
    modelId: wanModelId,
    operation: 'text-to-video',
    input: { prompt: 'A synthetic routing restriction fixture.', resolution: '720p', duration: 5 },
    routing: {
      endpointRegions: ['ap-southeast-1'],
      providerIds: ['openai'],
      modelProviderExceptions: [{ modelId: wanModelId, providerIds: ['alibaba'] }],
    },
    billing: 'managed',
    maxCostMicros: 2_000_000,
  };
  await editor.fill(JSON.stringify(request, null, 2));
  await apply.click();
  await expect(page.getByRole('combobox', { name: 'Provider route' })).toHaveValue('auto');
  await expect(pricing).toContainText('Alibaba Cloud · Model Studio · SG');
  await expect(pricing).toContainText('$0.10 USD / output second · 720p');
  await expect(pricing.getByRole('link', { name: 'Price source ↗' })).toHaveAttribute(
    'href',
    /wan3-0-video/,
  );

  request.routing = {
    endpointRegions: ['ap-southeast-1'],
    providerIds: ['alibaba'],
    modelProviderExceptions: [{ modelId: wanModelId, providerIds: ['openai'] }],
  };
  await editor.fill(JSON.stringify(request, null, 2));
  await apply.click();
  await expect(pricing).toContainText('Price unavailable for these settings');
  await expect(pricing).not.toContainText('Alibaba Cloud · Model Studio · SG');
  await expect(pricing.getByRole('link', { name: 'Price source ↗' })).toHaveCount(0);

  request.routing = {
    endpointRegions: ['ap-southeast-1'],
    providerIds: ['alibaba'],
    modelProviderExceptions: [{ modelId: imageModelId, providerIds: ['openai'] }],
  };
  await editor.fill(JSON.stringify(request, null, 2));
  await apply.click();
  await expect(pricing).toContainText('Alibaba Cloud · Model Studio · SG');
  await expect(pricing).toContainText('$0.10 USD / output second · 720p');
  await expect(pricing.getByRole('link', { name: 'Price source ↗' })).toHaveAttribute(
    'href',
    /wan3-0-video/,
  );
  expect(gateway.submissions).toEqual([]);
});

test('a pinned route cannot show a published price when its provider is excluded', async ({
  page,
}) => {
  const gateway = await stubGateway(page);
  await page.goto(playgroundHref(wanModelId, wanRouteId, 'text-to-video'));
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
  const pricing = page.getByRole('region', { name: 'Wan 3.0 pricing' });
  await expect(pricing).toContainText('$0.10 USD / output second · 720p');
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const request: GenerateInput = {
    modelId: wanModelId,
    operation: 'text-to-video',
    routeId: wanRouteId,
    input: { prompt: 'A synthetic pinned route fixture.', resolution: '720p', duration: 5 },
    routing: {
      providerIds: ['alibaba'],
      modelProviderExceptions: [{ modelId: wanModelId, providerIds: ['openai'] }],
    },
    billing: 'managed',
    maxCostMicros: 2_000_000,
  };
  await page
    .getByRole('textbox', { name: 'Canonical request JSON', exact: true })
    .fill(JSON.stringify(request, null, 2));
  await page.getByRole('button', { name: 'Apply JSON', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Provider route' })).toHaveValue(wanRouteId);
  await expect(pricing).toContainText('Price unavailable for these settings');
  await expect(pricing).not.toContainText('USD / output second');
  await expect(pricing.getByRole('link', { name: 'Price source ↗' })).toHaveCount(0);
  await expect(pricing.locator('summary', { hasText: 'regional route prices' })).toHaveCount(0);

  request.routing = { providerIds: ['alibaba'], endpointRegions: ['eu-central-1'] };
  await page
    .getByRole('textbox', { name: 'Canonical request JSON', exact: true })
    .fill(JSON.stringify(request, null, 2));
  await page.getByRole('button', { name: 'Apply JSON', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Provider route' })).toHaveValue(wanRouteId);
  await expect(pricing).toContainText('Price unavailable for these settings');
  await expect(pricing).not.toContainText('USD / output second');
  await expect(pricing.getByRole('link', { name: 'Price source ↗' })).toHaveCount(0);
  await expect(pricing.locator('summary', { hasText: 'regional route prices' })).toHaveCount(0);
  expect(gateway.submissions).toEqual([]);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`${viewport.name}: default playground places Prompt above Cost & Readiness with starter chips and honest flagship examples`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const gateway = await stubGateway(page);
    await page.goto('/playground');
    await expect(page.getByLabel('Choose generation model')).toHaveValue(imageModelId);
    await expect(page.getByRole('combobox', { name: 'Operation' })).toHaveValue('text-to-image');

    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
    const pricing = page.getByRole('region', { name: 'GPT Image 2 pricing' });
    const quoteButton = page.getByRole('button', { name: 'Get a quote', exact: true });
    await expect(quoteButton).toBeDisabled();

    const promptBox = await prompt.boundingBox();
    const pricingBox = await pricing.boundingBox();
    expect(promptBox).not.toBeNull();
    expect(pricingBox).not.toBeNull();
    expect(promptBox!.y).toBeLessThan(pricingBox!.y);

    const starterGroup = page.getByRole('group', { name: 'Starter prompts' });
    await starterGroup.getByRole('button', { name: 'Ceramic studio', exact: true }).click();
    await expect(prompt).toHaveValue(/stoneware teapot/i);
    await expect(quoteButton).toBeEnabled();
    expect(gateway.quotes).toEqual([]);
    expect(gateway.submissions).toEqual([]);

    const imageExample = page
      .locator('details')
      .filter({ hasText: 'Architectural stoneware studio still life' });
    await imageExample.locator('summary').click();
    await expect(imageExample.locator('summary')).toContainText('Starter example');
    await expect(imageExample.getByRole('img')).toHaveCount(0);
    await expect(imageExample.locator('video')).toHaveCount(0);
    await imageExample.getByRole('button', { name: 'Use example in draft' }).click();
    await expect(prompt).toHaveValue(/travertine plinth/i);
    await expect(quoteButton).toBeEnabled();
    expect(gateway.submissions).toEqual([]);

    for (const target of [
      {
        modelId: 'bytedance/seedream-5.0-pro',
        title: 'Sunlit glass botanical conservatory',
        expectedPrompt: /botanical conservatory/i,
      },
      {
        modelId: 'bytedance/seedance-2.5',
        title: 'Misty coastal cliff road at sunrise',
        expectedPrompt: /coastal cliff road/i,
      },
      {
        modelId: 'kling/kling-4.0',
        title: 'Lantern-lit stone alley after rain',
        expectedPrompt: /lantern-lit stone alley/i,
      },
    ]) {
      await page.getByLabel('Choose generation model').selectOption(target.modelId);
      const disclosure = page.locator('details').filter({ hasText: target.title });
      await disclosure.locator('summary').click();
      await expect(disclosure.getByRole('img')).toHaveCount(0);
      await expect(disclosure.locator('video')).toHaveCount(0);
      await disclosure.getByRole('button', { name: 'Use example in draft' }).click();
      await expect(prompt).toHaveValue(target.expectedPrompt);
      await expect(quoteButton).toBeEnabled();
    }

    expect(gateway.submissions).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
  });
}

test('inline Add-Credit callout appears on $0.00 balance and after 402 insufficient_balance', async ({
  page,
}) => {
  let availableMicros = 0;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        workspaceId: 'fixture-workspace',
        recoveryScope: 'fixture-identity',
        scopes: ['read', 'generate'],
      },
    }),
  );
  await page.route('**/api/balance', (route) =>
    route.fulfill({ json: { availableMicros, reservedMicros: 0 } }),
  );
  await page.route('**/api/quotes', (route) => {
    const input = route.request().postDataJSON() as GenerateInput;
    return route.fulfill({
      json: quote(input, { executableRouteIds: catalog.routes.map((entry) => entry.id) }),
    });
  });
  await page.route('**/api/generations', (route) =>
    route.fulfill({
      status: 402,
      json: {
        error: {
          code: 'insufficient_balance',
          message: 'Workspace balance is insufficient for this reservation.',
        },
      },
    }),
  );

  await page.goto('/playground');
  const creditCallout = page.getByTestId('playground-credit-callout');
  await expect(creditCallout).toBeVisible();
  await expect(creditCallout).toContainText('$0.00 available credit');
  await expect(
    creditCallout.getByRole('link', { name: 'Add workspace credit →', exact: true }),
  ).toHaveAttribute('href', '/billing');

  await page.getByRole('combobox', { name: 'Pay with', exact: true }).selectOption('byok');
  await expect(creditCallout).toHaveCount(0);

  availableMicros = 25_000;
  await page.reload();
  await expect(creditCallout).toHaveCount(0);
  await page
    .getByRole('group', { name: 'Starter prompts' })
    .getByRole('button', { name: 'Ceramic studio', exact: true })
    .click();
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(creditCallout).toBeVisible();
  await expect(creditCallout).toContainText('Insufficient workspace credit');
  await expect(
    creditCallout.getByRole('link', { name: 'Add workspace credit →', exact: true }),
  ).toHaveAttribute('href', '/billing');
});

test('signed-out sign-in CTA passes returnTo and restores the sanitized draft once without cross-identity leakage', async ({
  page,
}) => {
  let session: Record<string, unknown> = {
    authenticated: false,
    oidcEnabled: true,
  };
  await page.route('**/api/session', (route) => {
    if (route.request().method() === 'DELETE') {
      session = { authenticated: false, oidcEnabled: true };
    }
    return route.fulfill({ json: session });
  });

  const targetHref = '/playground?model=openai%2Fgpt-image-2&operation=text-to-image';
  const expectedLoginHref = `/auth/login?returnTo=${encodeURIComponent(targetHref)}`;
  await page.goto(targetHref);
  const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await prompt.fill('Signed-out stoneware draft that should survive login.');

  await expect(
    page
      .getByTestId('playground-signin-callout')
      .getByRole('link', { name: /Sign in to generate/ }),
  ).toHaveAttribute('href', expectedLoginHref);
  await expect(
    page.locator('#playground-account').getByRole('link', { name: 'Sign in or create account' }),
  ).toHaveAttribute('href', expectedLoginHref);

  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('opengen.playground.v1:signin-handoff')))
    .toContain('Signed-out stoneware draft that should survive login.');

  const storageDump = await page.evaluate(() => JSON.stringify(sessionStorage));
  expect(storageDump).not.toContain('og_sk_');
  expect(storageDump).not.toContain('Bearer');

  session = {
    authenticated: true,
    workspaceId: 'fixture-workspace-a',
    recoveryScope: 'fixture-identity-a',
    scopes: ['read', 'generate'],
    oidcEnabled: true,
  };
  await page.goto(targetHref);
  await expect(prompt).toHaveValue('Signed-out stoneware draft that should survive login.');
  await expect(
    page.getByRole('status').filter({ hasText: 'restored after sign-in' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('opengen.playground.v1:signin-handoff')),
  ).toBeNull();

  await page
    .locator('#playground-account')
    .getByRole('button', { name: 'Sign out', exact: true })
    .click();
  await expect(prompt).toHaveValue('');
  session = {
    authenticated: true,
    workspaceId: 'fixture-workspace-b',
    recoveryScope: 'fixture-identity-b',
    scopes: ['read', 'generate'],
    oidcEnabled: true,
  };
  await page.reload();
  await expect(prompt).toHaveValue('');
});
