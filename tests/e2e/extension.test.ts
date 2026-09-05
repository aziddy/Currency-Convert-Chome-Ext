import { test, expect, chromium, type BrowserContext, type Page, type Worker, type CDPSession } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHANNEL, DEFAULT_SETTINGS, type ContentRequest, type PageStatus, type Reply } from '../../src/shared/types';

const extensionPath = path.resolve('dist');
let context: BrowserContext;
let worker: Worker;
let browserSession: CDPSession;
let profile: string;
let extensionId: string;
let shop: Page;
let popup: Page;

test.beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'price-converter-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      '--enable-unsafe-extension-debugging',
    ],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2]!;
  browserSession = await context.browser()!.newBrowserCDPSession();
  // Deterministic reference rate: browser tests never depend on today's rate/API availability.
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ rateCache: { usdToCad: 1.4, date: '2026-09-04', fetchedAt: Date.now() } });
  });
  shop = await context.newPage();
  await shop.goto('http://127.0.0.1:4173');
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && popup && !popup.isClosed()) {
    console.log('Popup status:', await popup.locator('#status').textContent());
    await popup.screenshot({ path: info.outputPath('popup-error.png'), fullPage: true });
  }
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function openPopup(supported = true): Promise<Page> {
  await shop.bringToFront();
  const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
  const targetInfo = targetInfos.find(info => info.url === shop.url());
  if (!targetInfo) throw new Error(`Could not locate the shopping tab: ${JSON.stringify(targetInfos)}`);
  // Trigger the real toolbar action to exercise Chrome's temporary activeTab grant.
  await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfo.targetId });
  const popupEvent = context.waitForEvent('page');
  await worker.evaluate(async id => { await chrome.tabs.create({ url: `chrome-extension://${id}/popup.html`, active: false }); }, extensionId);
  const view = await popupEvent;
  await view.waitForURL(`chrome-extension://${extensionId}/popup.html`);
  if (supported) await expect(view.locator('#convert')).toBeEnabled();
  else await expect(view.locator('#status')).toContainText('Open an ordinary website');
  await view.bringToFront();
  return view;
}

async function grantTestSiteAccess(): Promise<void> {
  // Grant through Chrome's own extension-management API in this temporary profile.
  // Headless Chromium cannot click the native optional-permission confirmation.
  const manager = await context.newPage();
  await manager.goto('chrome://extensions');
  await manager.evaluate(async id => {
    const api = (chrome as unknown as { developerPrivate: {
      addHostPermission(extensionId: string, host: string): Promise<void>;
    } }).developerPrivate;
    await api.addHostPermission(id, '*://127.0.0.1/*');
  }, extensionId);
  await manager.close();
}

async function prepareSelectionContent(): Promise<number> {
  // Native OS context-menu clicks are not exposed by headless CDP. Unit tests cover the
  // menu handler; here grant the fixture origin and exercise its real content-message path.
  // Grant from a test-only button in an extension tab, without invoking the toolbar action
  // or Convert page. The explicit click supplies Chrome's required permission gesture.
  await grantTestSiteAccess();
  const permissionView = await context.newPage();
  await permissionView.goto(`chrome-extension://${extensionId}/popup.html`);
  await permissionView.evaluate(() => {
    const button = document.createElement('button'); button.id = 'test-grant'; button.textContent = 'Grant fixture access';
    button.onclick = async () => {
      button.dataset.granted = String(await chrome.permissions.request({ origins: ['*://127.0.0.1/*'] }));
    };
    document.body.append(button);
  });
  await permissionView.locator('#test-grant').click();
  await expect(permissionView.locator('#test-grant')).toHaveAttribute('data-granted', 'true');
  await permissionView.close();
  await shop.bringToFront();
  return worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url)!;
    await chrome.scripting.insertCSS({ target: { tabId: tab.id! }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
    return tab.id!;
  }, shop.url());
}

async function selectAmount(selector: string, start?: number, end?: number): Promise<string> {
  return shop.locator(selector).evaluate((element, offsets) => {
    const range = document.createRange();
    if (offsets.start === undefined) range.selectNodeContents(element);
    else { range.setStart(element.firstChild!, offsets.start); range.setEnd(element.firstChild!, offsets.end!); }
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    return range.toString();
  }, { start, end });
}

async function selectionMessage(tabId: number, request: ContentRequest): Promise<Reply<PageStatus>> {
  return worker.evaluate(async ({ tabId, channel, request }) =>
    chrome.tabs.sendMessage(tabId, { channel, ...request }, { frameId: 0 }), { tabId, channel: CHANNEL, request });
}

test('selected amounts replace independently, preserve other prices, and restore through the popup', async () => {
  const tabId = await prepareSelectionContent();
  let reply = await selectionMessage(tabId, { type: 'CONVERT_SELECTION', selectionText: await selectAmount('#simple', 1, 6),
    preferences: { ...DEFAULT_SETTINGS.preferences, display: 'hover' } });
  expect(reply).toMatchObject({ ok: true, value: { active: false, count: 0, selectionCount: 1 } });
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+33\.60/);
  await expect(shop.locator('#split')).toHaveText('US$89.99');
  reply = await selectionMessage(tabId, { type: 'CONVERT_SELECTION', selectionText: await selectAmount('#split'),
    preferences: DEFAULT_SETTINGS.preferences });
  expect(reply).toMatchObject({ ok: true, value: { active: false, selectionCount: 2 } });
  await expect(shop.locator('#split')).toHaveText(/≈ CAD\s+125\.99/);
  await expect(shop.locator('#sentence')).toHaveText('Shipping is USD 5.00. Free above USD 100.00.');
  popup = await openPopup();
  await expect(popup.locator('#status')).toContainText('2 selected amounts converted');
  await expect(popup.locator('#restore')).toBeEnabled();
  await popup.locator('input[value=beside]').check();
  await popup.locator('#swap').click();
  await popup.locator('summary').click();
  await popup.locator('#custom-rate').fill('1.5');
  await popup.locator('#custom-form button').click();
  // Let the one-second status poll run; frozen selection rates must not overwrite the current rate UI.
  await popup.waitForTimeout(1100);
  await expect(popup.locator('#rate-value')).toHaveText('1 USD = 1.5 CAD');
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+33\.60/);
  await expect(shop.locator('#sentence')).toHaveText('Shipping is USD 5.00. Free above USD 100.00.');
  await popup.locator('#restore').click();
  await expect(shop.locator('#simple')).toHaveText('$24.00');
  await expect(shop.locator('#split')).toHaveText('US$89.99');
});

test('selection conversion fetches a first-use rate and protects against a changed selection', async () => {
  const tabId = await prepareSelectionContent();
  await worker.evaluate(() => chrome.storage.local.remove('rateCache'));
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  await context.route('https://api.frankfurter.dev/v2/rate/USD/CAD', async route => {
    requested(); await paused;
    await route.fulfill({ json: { base: 'USD', quote: 'CAD', date: '2026-09-04', rate: 1.5 } });
  });
  const result = selectionMessage(tabId, { type: 'CONVERT_SELECTION', selectionText: await selectAmount('#simple'),
    preferences: DEFAULT_SETTINGS.preferences });
  await started;
  await selectAmount('#split'); release();
  expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('selection changed') });
  await expect(shop.locator('#simple')).toHaveText('$24.00');
  expect(await selectionMessage(tabId, { type: 'CONVERT_SELECTION', selectionText: await selectAmount('#simple'),
    preferences: DEFAULT_SETTINGS.preferences })).toMatchObject({ ok: true, value: { selectionCount: 1 } });
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+36\.00/);
});

test('selection errors leave the page unchanged and display a dismissible notice', async () => {
  const tabId = await prepareSelectionContent();
  await worker.evaluate(() => chrome.storage.local.remove('rateCache'));
  await context.route('https://api.frankfurter.dev/v2/rate/USD/CAD', route => route.abort());
  const result = await selectionMessage(tabId, { type: 'CONVERT_SELECTION', selectionText: await selectAmount('#simple'),
    preferences: DEFAULT_SETTINGS.preferences });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Could not load an exchange rate') });
  await expect(shop.locator('#simple')).toHaveText('$24.00');
  // The menu handler forwards errors to this same notification message.
  if (!result.ok) await selectionMessage(tabId, { type: 'SELECTION_ERROR', error: result.error });
  await expect(shop.locator('[data-pc-notice]')).toContainText('Could not load an exchange rate');
  await shop.locator('[data-pc-notice] button').click();
  await expect(shop.locator('[data-pc-notice]')).toHaveCount(0);
});

test('selection undo survives a background worker restart', async () => {
  const checkMenu = () => worker.evaluate(() => new Promise<void>((resolve, reject) => {
    chrome.contextMenus.update('convert-selected-amount', { enabled: true }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve();
    });
  }));
  await checkMenu();
  const tabId = await prepareSelectionContent();
  expect(await selectionMessage(tabId, { type: 'CONVERT_SELECTION', selectionText: await selectAmount('#simple'),
    preferences: DEFAULT_SETTINGS.preferences })).toMatchObject({ ok: true });
  popup = await openPopup();
  const session = await context.newCDPSession(popup);
  await session.send('ServiceWorker.enable');
  await session.send('ServiceWorker.stopAllWorkers');
  await context.route('https://api.frankfurter.dev/v2/rate/USD/CAD', route => route.fulfill({
    json: { base: 'USD', quote: 'CAD', date: '2026-09-04', rate: 1.6 },
  }));
  await popup.locator('#refresh').click();
  await expect(popup.locator('#rate-value')).toHaveText('1 USD = 1.6 CAD');
  // Chromium may resume the existing worker target rather than emit a new target event.
  worker = context.serviceWorkers().find(value => value.url().includes(extensionId))!;
  await checkMenu();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+33\.60/);
  await popup.locator('#restore').click();
  await expect(shop.locator('#simple')).toHaveText('$24.00');
  await session.detach();
});

test('a fresh install fetches and caches a daily rate through the background worker', async () => {
  await worker.evaluate(() => chrome.storage.local.remove('rateCache'));
  let requests = 0;
  await context.route('https://api.frankfurter.dev/v2/rate/USD/CAD', async route => {
    requests++;
    expect(route.request().serviceWorker()).toBe(worker);
    await route.fulfill({
      json: { base: 'USD', quote: 'CAD', date: '2026-09-04', rate: 1.42 },
    });
  });
  popup = await openPopup();
  await expect(popup.locator('#rate-value')).toHaveText('1 USD = 1.42 CAD');
  expect(requests).toBe(1);
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('rateCache')).rateCache))
    .toEqual({ usdToCad: 1.42, date: '2026-09-04', fetchedAt: expect.any(Number) });
  await popup.locator('#convert').click();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+34\.08/);
  expect(requests).toBe(1);
});

test('manual conversion, all display modes, updates, reversal and restoration', async () => {
  popup = await openPopup();
  await expect(popup.locator('#source')).toHaveValue('USD');
  await expect(popup.locator('#target')).toHaveValue('CAD');
  await expect(popup.locator('#rate-value')).toHaveText('1 USD = 1.4 CAD');
  await popup.locator('body').screenshot({ path: 'test-results/popup-default.png' });
  await popup.locator('#convert').click();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+33\.60/);
  await expect(shop.locator('#canadian')).toHaveText('CAD 120.00');
  await expect(shop.locator('#foreign')).toHaveText('Australian store: AUD $35.00');
  await expect(popup.locator('#status')).toContainText('5 prices converted');

  await popup.locator('input[value=beside]').check();
  await expect(shop.locator('#simple')).toHaveText(/\$24\.00 \(≈ CAD\s+33\.60\)/);
  await popup.locator('input[value=hover]').check();
  await expect(shop.locator('#simple')).toHaveText('$24.00');
  await shop.locator('#simple').hover({ position: { x: 15, y: 12 } });
  await expect(shop.locator('[data-pc-tooltip]')).toBeVisible();
  await expect(shop.locator('[data-pc-tooltip]')).toContainText('33.60');
  await shop.keyboard.press('Escape');
  await expect(shop.locator('[data-pc-tooltip]')).toBeHidden();
  await shop.locator('#simple [data-pc-focus]').focus();
  await expect(shop.locator('[data-pc-tooltip]')).toBeVisible();

  await popup.locator('input[value=replace]').check();
  await shop.locator('#sale').click();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+25\.20/);
  await shop.locator('#add').click();
  await expect(shop.locator('.added-price')).toHaveText(/≈ CAD\s+91\.00/);
  await shop.locator('#cart').click();
  await expect(shop.locator('#click-count')).toHaveText('1');
  await expect(shop.locator('input')).toHaveValue('$50.00 — leave this alone');

  await popup.locator('#swap').click();
  await expect(shop.locator('#simple')).toHaveText(/≈ USD\s+12\.86/);
  await expect(shop.locator('#canadian')).toHaveText(/≈ USD\s+85\.71/);
  await popup.locator('#restore').click();
  await expect(shop.locator('#simple')).toHaveText('$18.00');
  await expect(shop.locator('#split')).toHaveText('US$89.99');
  await expect(shop.locator('[data-pc-badge]')).toHaveCount(0);
  await popup.locator('body').screenshot({ path: 'test-results/popup.png' });
});

test('per-site automation persists, is hostname-specific, and restores every open page when disabled', async () => {
  await grantTestSiteAccess();
  popup = await openPopup();
  await popup.locator('#auto-site').click();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+33\.60/);
  await popup.locator('input[value=beside]').check();
  await expect(shop.locator('#simple')).toContainText('(≈ CAD');
  await shop.reload();
  await expect(shop.locator('#simple')).toContainText('(≈ CAD');

  const second = await context.newPage(); await second.goto('http://127.0.0.1:4173');
  await expect(second.locator('#simple')).toContainText('(≈ CAD');
  const unrelated = await context.newPage(); await unrelated.goto('http://localhost:4173');
  await expect(unrelated.locator('#simple')).toHaveText('$24.00');
  const scripts = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  expect(scripts).toEqual([expect.objectContaining({ matches: ['*://127.0.0.1/*'], persistAcrossSessions: true })]);

  await popup.locator('#restore').click();
  await shop.locator('#sale').click();
  await expect(shop.locator('#simple')).toHaveText('$18.00');
  await expect(second.locator('#simple')).toContainText('(≈ CAD');
  await shop.reload();
  await expect(shop.locator('#simple')).toContainText('(≈ CAD');
  await popup.locator('#auto-site').uncheck();
  await expect(shop.locator('#simple')).toHaveText('$24.00');
  await expect(second.locator('#simple')).toHaveText('$24.00');
  await shop.reload(); await expect(shop.locator('#simple')).toHaveText('$24.00');
  expect(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
  expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ['*://127.0.0.1/*'] }))).toBe(false);
});

test('denied site permission retains manual conversion', async () => {
  popup = await openPopup();
  // Simulate Chrome's deny result; all other APIs and the activeTab grant are real.
  await popup.evaluate(() => { chrome.permissions.request = (async () => false) as typeof chrome.permissions.request; });
  await popup.locator('#auto-site').click();
  await expect(popup.locator('#auto-site')).not.toBeChecked();
  await expect(popup.locator('#status')).toContainText('not granted');
  await popup.locator('#convert').click();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+33\.60/);
  expect(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
});

test('permission revocation stops automation and removes stale settings', async () => {
  await grantTestSiteAccess();
  popup = await openPopup();
  await popup.locator('#auto-site').click();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+33\.60/);
  await worker.evaluate(() => chrome.permissions.remove({ origins: ['*://127.0.0.1/*'] }));
  await expect(shop.locator('#simple')).toHaveText('$24.00');
  await expect(popup.locator('#auto-site')).not.toBeChecked();
  expect(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
  await shop.reload(); await expect(shop.locator('#simple')).toHaveText('$24.00');
});

test('automatic detection skips uncertainty and handles French Canadian prices', async () => {
  await shop.goto('http://127.0.0.1:4173/ambiguous.html');
  popup = await openPopup();
  await popup.locator('#detect').check();
  await popup.locator('#convert').click();
  await expect(shop.locator('#bare')).toHaveText('$49.99');
  await expect(popup.locator('#status')).toContainText('1 uncertain $ price skipped');
  await popup.locator('#detect').uncheck();
  await expect(shop.locator('#bare')).toHaveText(/≈ CAD\s+69\.99/);
  await popup.close();
  await shop.goto('http://127.0.0.1:4173/french.html');
  popup = await openPopup();
  await popup.locator('#target').selectOption('USD');
  await popup.locator('#detect').check();
  await popup.locator('#convert').click();
  await expect(shop.locator('#french-price')).toHaveText(/≈\s+881,83\s+USD/);
  await expect(shop.locator('#bare')).toHaveText(/≈\s+35,71\s+USD/);
  await expect(shop.locator('#usd')).toHaveText('USD 25.00');
});

test('custom rates recalculate active conversions and return to daily rates', async () => {
  popup = await openPopup();
  await popup.locator('#convert').click();
  await popup.locator('summary').click();
  await popup.locator('#custom-rate').fill('0');
  await popup.locator('#custom-enabled').click();
  await expect(popup.locator('#custom-enabled')).not.toBeChecked();
  await expect(popup.locator('#custom-feedback')).toContainText('greater than zero');
  await popup.locator('#custom-rate').fill('1.5');
  await popup.locator('#custom-form button').click();
  await expect(popup.locator('#custom-enabled')).toBeChecked();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+36\.00/);
  await expect(popup.locator('#rate-info')).toContainText('Your custom rate');
  await popup.locator('#custom-enabled').uncheck();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+33\.60/);
});

test('saved automation works after the background worker stops and restarts', async () => {
  await grantTestSiteAccess();
  popup = await openPopup();
  await popup.locator('#auto-site').click();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+33\.60/);
  const session = await context.newCDPSession(popup);
  await session.send('ServiceWorker.enable');
  await session.send('ServiceWorker.stopAllWorkers');
  await shop.reload();
  await expect(shop.locator('#simple')).toHaveText(/≈ CAD\s+33\.60/);
  await popup.locator('#auto-site').uncheck();
  await expect(shop.locator('#simple')).toHaveText('$24.00');
  await session.detach();
});

test('protected Chrome pages show a clear unavailable state', async () => {
  await shop.goto('chrome://version');
  popup = await openPopup(false);
  await expect(popup.locator('#convert')).toBeDisabled();
  await expect(popup.locator('#auto-site')).toBeDisabled();
  await expect(popup.locator('#status')).toContainText('Chrome protects internal pages');
});
