import { expect, test, type Page } from '@playwright/test';
import { quote } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const evidenceDir = path.resolve(import.meta.dirname, '../../..', 'docs/evidence');

async function stubGateway(page: Page) {
  const quotes: GenerateInput[] = [];
  const submissions: string[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          Object.assign(window, { opengenCopiedText: text });
        },
      },
    });
  });
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { authenticated: false, oidcEnabled: false } }),
  );
  await page.route('**/api/quotes', async (route) => {
    const input = route.request().postDataJSON() as GenerateInput;
    quotes.push(input);
    await route.fulfill({ json: quote(input, { executableRouteIds: [] }) });
  });
  for (const endpoint of ['**/api/generations**', '**/v1/generations**']) {
    await page.route(endpoint, async (route) => {
      if (route.request().method() === 'POST') submissions.push(route.request().url());
      await route.fulfill({
        status: 503,
        json: { error: 'Generation is disabled in this read-only browser fixture.' },
      });
    });
  }
  return { quotes, submissions };
}

const instructionCode = (page: Page, copyLabel: string) =>
  page
    .getByRole('region', { name: 'API and agent instructions' })
    .getByRole('button', { name: copyLabel, exact: true })
    .locator('..')
    .locator('code');

async function copiedText(page: Page) {
  return page.evaluate(() => (window as Window & { opengenCopiedText?: string }).opengenCopiedText);
}

test('API instructions export the same pinned image-to-video request as the browser quote', async ({
  page,
}) => {
  const gateway = await stubGateway(page);
  await page.goto('/playground?model=alibaba%2Fwan-3.0&route=alibaba%2Fap-southeast-1%2Fwan-3.0');
  const instructions = page.getByRole('region', { name: 'API and agent instructions' });
  await expect(instructions.getByRole('button', { name: 'Copy request JSON' })).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Operation', exact: true })
    .selectOption('image-to-video');
  const prompt = "A producer's scene: $(touch /tmp/never-run); `id`\nKeep this as ordinary text.";
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt);
  await page
    .getByLabel('First frame URL', { exact: false })
    .fill('https://assets.example/frame.png');
  await page.getByRole('spinbutton', { name: 'Maximum spend, USD', exact: true }).fill('0.37');
  await instructions.getByRole('button', { name: 'Use the API', exact: true }).click();

  const requestCode = instructionCode(page, 'Copy request JSON');
  const exported = JSON.parse(await requestCode.innerText()) as GenerateInput;
  expect(exported).toMatchObject({
    modelId: 'alibaba/wan-3.0',
    operation: 'image-to-video',
    routeId: 'alibaba/ap-southeast-1/wan-3.0',
    billing: 'managed',
    maxCostMicros: 370000,
    input: { prompt, firstFrame: { url: 'https://assets.example/frame.png' } },
  });
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect.poll(() => gateway.quotes.length).toBe(1);
  expect(exported).toEqual(gateway.quotes[0]);

  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  const publicOrigin = new URL(canonical!).origin;
  const quoteCommand = await instructionCode(page, 'Copy quote command').innerText();
  await instructions
    .getByText('3. Submit when you’re ready, then check the job', { exact: true })
    .click();
  const generationCommand = await instructionCode(page, 'Copy generation command').innerText();
  const jobCommand = await instructionCode(page, 'Copy job command').innerText();
  expect(quoteCommand).toContain(`${publicOrigin}/v1/quotes`);
  expect(generationCommand).toContain(`${publicOrigin}/v1/generations`);
  expect(generationCommand).toContain('Idempotency-Key: ${OPENGEN_REQUEST_ID:?');
  expect(jobCommand).toContain(`${publicOrigin}/v1/generations/`);
  expect(jobCommand).toContain('OPENGEN_JOB_ID');
  for (const command of [quoteCommand, generationCommand, jobCommand]) {
    expect(command).toContain('Authorization: Bearer ${OPENGEN_API_KEY:?');
    expect(command).not.toContain('touch /tmp/never-run');
    expect(command).not.toContain('`id`');
    expect(command).not.toContain('MEDIA_ROUTER_API_URL');
  }
  expect(quoteCommand).toContain('--data-binary @request.json');
  expect(generationCommand).toContain('--data-binary @request.json');

  const updatedPrompt = `${prompt}\nA softer afternoon light.`;
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(updatedPrompt);
  await page.getByRole('spinbutton', { name: 'Maximum spend, USD', exact: true }).fill('0.42');
  const updatedJson = await requestCode.innerText();
  await instructions.getByRole('button', { name: 'Copy request JSON', exact: true }).click();
  await expect.poll(() => copiedText(page)).toBe(updatedJson);
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect.poll(() => gateway.quotes.length).toBe(2);
  expect(JSON.parse(updatedJson)).toEqual(gateway.quotes[1]);
  expect(gateway.quotes[1]).toMatchObject({
    input: { prompt: updatedPrompt },
    maxCostMicros: 420000,
  });
  expect(gateway.submissions).toEqual([]);
});

test('agent instructions carry the selected variant and request without API credentials', async ({
  page,
}) => {
  const gateway = await stubGateway(page);
  await page.goto('/playground?model=minimax%2Fh3-max&route=fal-undisclosed%2Ffal-h3-max');
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('A paper sailboat on a quiet lake.');
  const instructions = page.getByRole('region', { name: 'API and agent instructions' });
  await instructions.getByRole('button', { name: 'Use an agent', exact: true }).click();
  await expect(instructions.getByRole('link', { name: /connection guide/ })).toHaveAttribute(
    'href',
    '/agents',
  );
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  const publicOrigin = new URL(canonical!).origin;
  const address = await instructionCode(page, 'Copy MCP address').innerText();
  expect(address).toBe(`${publicOrigin}/mcp`);
  await instructions.getByRole('button', { name: 'Copy MCP address', exact: true }).click();
  await expect.poll(() => copiedText(page)).toBe(address);

  const brief = await instructionCode(page, 'Copy agent brief').innerText();
  expect(brief).toContain(`${publicOrigin}/llms.txt`);
  expect(brief).toContain(`${publicOrigin}/mcp`);
  expect(brief).toContain('authorized OpenGen workspace');
  expect(brief).toContain('ask before submitting a billable generation');
  expect(brief).not.toContain('OPENGEN_API_KEY');
  expect(brief).not.toContain('Authorization: Bearer');
  const request = JSON.parse(brief.slice(brief.indexOf('{'))) as GenerateInput;
  expect(request).toMatchObject({
    modelId: 'minimax/h3-max',
    routeId: 'fal-undisclosed/fal-h3-max',
    input: { prompt: 'A paper sailboat on a quiet lake.' },
  });
  await instructions.getByRole('button', { name: 'Copy agent brief', exact: true }).click();
  await expect.poll(() => copiedText(page)).toBe(brief);

  await page.getByLabel('Choose generation model').selectOption('openai/gpt-image-2.5-sunburst');
  await instructions.getByRole('button', { name: 'Use an agent', exact: true }).click();
  // A different exact model opens its own draft. Review the new model's required
  // input instead of expecting invalid or implicitly converted video settings to export.
  await expect(instructions).toContainText('requires a nonempty prompt');
  await expect(
    instructions.getByRole('button', { name: 'Copy agent brief', exact: true }),
  ).toHaveCount(0);
  const nextPrompt = 'A sunlit still life of a paper sailboat.';
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(nextPrompt);
  const nextBrief = await instructionCode(page, 'Copy agent brief').innerText();
  expect(nextBrief).not.toContain('minimax/h3-max');
  const nextRequest = JSON.parse(nextBrief.slice(nextBrief.indexOf('{'))) as GenerateInput;
  expect(nextRequest.modelId).toBe('openai/gpt-image-2.5-sunburst');
  expect(nextRequest.operation).toBe('text-to-image');
  expect(nextRequest.input.prompt).toBe(nextPrompt);
  expect(nextRequest.input).not.toHaveProperty('duration');
  expect(nextRequest.routeId).toBeUndefined();
  expect(gateway.submissions).toEqual([]);
});

test('phone users can switch API and agent instructions without losing their inputs', async ({
  page,
}) => {
  const gateway = await stubGateway(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/playground?model=bytedance%2Fseedance-2.0-fast');
  const prompt = `A studio portrait with a carefully composed backdrop. ${'x'.repeat(240)}`;
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt);
  await page.getByRole('spinbutton', { name: 'Maximum spend, USD', exact: true }).fill('1.25');
  const instructions = page.getByRole('region', { name: 'API and agent instructions' });
  await instructions.getByRole('button', { name: 'Use the API', exact: true }).click();
  const requestJson = await instructionCode(page, 'Copy request JSON').innerText();
  await instructions.getByRole('button', { name: 'Use an agent', exact: true }).click();
  const agentBrief = await instructionCode(page, 'Copy agent brief').innerText();
  expect(JSON.parse(agentBrief.slice(agentBrief.indexOf('{')))).toEqual(JSON.parse(requestJson));
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(prompt);
  await expect(
    page.getByRole('spinbutton', { name: 'Maximum spend, USD', exact: true }),
  ).toHaveValue('1.25');
  await expect(page.getByLabel('Choose generation model')).toHaveValue(
    'bytedance/seedance-2.0-fast',
  );
  await expect(page.getByLabel('Provider route', { exact: true })).toHaveValue('auto');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, 'playground-agent-instructions-phone.png'),
    fullPage: true,
  });

  await instructions.getByRole('button', { name: 'Use an agent', exact: true }).click();
  await expect(instructions.getByRole('button', { name: 'Copy agent brief' })).toHaveCount(0);
  await instructions.getByRole('button', { name: 'Use the API', exact: true }).click();
  await expect(instructionCode(page, 'Copy request JSON')).toHaveText(requestJson);
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(prompt);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({
    path: path.join(evidenceDir, 'playground-api-instructions-phone.png'),
    fullPage: true,
  });
  expect(gateway.submissions).toEqual([]);
});
