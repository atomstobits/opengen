import { expect, test } from '@playwright/test';

const comparisonEnabled = Boolean(process.env.OPENGEN_HERO_MEDIA_BASE_URL);

test.describe('split comparison homepage hero', () => {
  test.skip(!comparisonEnabled, 'Requires OPENGEN_HERO_MEDIA_BASE_URL to be configured.');

  test('renders agent-first hero over split video with price badges, compact prompt and lazy modal', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const modalVideoRequests: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.endsWith('/seedance-2.5.mp4') || url.endsWith('/kling-4.0.mp4')) {
        modalVideoRequests.push(url);
      }
    });

    await page.goto('/');

    const hero = page.locator('.hero');
    await expect(hero.getByRole('heading', { level: 1 })).toHaveText(
      'Image & video models.One open gateway.',
    );
    await expect(hero.getByRole('region', { name: 'Give this to your agent' })).toBeVisible();
    await expect(page.getByRole('button', { name: /pause/i })).toHaveCount(0);

    // Model + cheapest price + discount badges link directly to canonical series pages.
    const leftBadge = hero.getByTestId('hero-badge-left');
    const rightBadge = hero.getByTestId('hero-badge-right');
    await expect(leftBadge).toContainText('Seedance 2.5');
    await expect(leftBadge).toContainText('$0.569/s');
    await expect(leftBadge).toContainText('-51%');
    await expect(leftBadge).toHaveAttribute('href', '/bytedance/seedance-2.5');
    await expect(rightBadge).toContainText('Kling 4.0');
    await expect(rightBadge).toContainText('$0.188/s');
    await expect(rightBadge).toContainText('-20%');
    await expect(rightBadge).toHaveAttribute('href', '/kling/kling-4.0');

    // Compact prompt capsule has no model labels or video playlist, and zero modal videos loaded yet.
    const dock = hero.getByTestId('hero-prompt-dock');
    await expect(dock).toBeVisible();
    await expect(dock).not.toContainText('Seedance');
    await expect(dock).not.toContainText('Kling');
    await expect(dock.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
    expect(modalVideoRequests).toEqual([]);

    // Clicking Generate opens the lazy comparison modal with both videos and homepage actions.
    await dock.getByRole('button', { name: 'Generate', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Shared Input' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('video')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: 'Audio: Muted' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
    const inputImg = dialog.locator('.hero-modal-input-grid img');
    await expect(inputImg).toBeVisible();
    await expect
      .poll(() => inputImg.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await expect(dialog.getByRole('link', { name: 'CLI setup' })).toHaveAttribute(
      'href',
      '/agents/cli',
    );
    await expect(dialog.getByRole('link', { name: 'API setup' })).toHaveAttribute(
      'href',
      '/docs#http-examples',
    );
    await expect(dialog.getByRole('link', { name: 'Continue in browser' })).toHaveAttribute(
      'href',
      '/playground?model=bytedance%2Fseedance-2.5&operation=reference-to-video',
    );

    // Cycle audio and close cleanly via Escape.
    await dialog.getByRole('button', { name: 'Audio: Muted' }).click();
    await expect(dialog.getByRole('button', { name: 'Audio: Seedance 2.5' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Clicking the prompt text trigger opens the exact same modal.
    await dock.getByRole('button', { name: 'Inspect shared input and comparison videos' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close comparison' }).click();
    await expect(dialog).toHaveCount(0);

    // Modal video fetches occurred only after user interaction.
    expect(modalVideoRequests.length).toBeGreaterThanOrEqual(2);
  });

  test.describe('phone viewport', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('stays inside viewport, skips background autoplay video and keeps Explore models reachable', async ({
      page,
    }) => {
      await page.goto('/');
      const overflow = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      expect(overflow.width).toBeLessThanOrEqual(overflow.viewport);
      await expect(page.locator('.hero-media-split video')).toHaveCount(0);
      await expect(page.locator('.hero').getByTestId('hero-prompt-dock')).toBeVisible();
      await page
        .locator('.hero')
        .getByRole('link', { name: 'Explore models', exact: true })
        .click();
      await expect(page).toHaveURL(/\/models$/);
    });
  });
});
