import {
  CHANNEL, DEFAULT_SETTINGS, isPositiveRate, sitePattern, validPreferences,
  type BackgroundRequest, type Reply, type Settings,
} from '../shared/types';
import { RateService } from './rates';
import { clearSelectionError, convertContextSelection, registerSelectionMenu } from './context-menu';

async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  const settings = stored.settings as Partial<Settings> | undefined;
  const sites: Settings['sites'] = {};
  for (const [host, preference] of Object.entries(settings?.sites ?? {})) {
    try { if (validPreferences(preference)) { sitePattern(host); sites[host] = preference; } } catch { /* Ignore invalid saved entries. */ }
  }
  return {
    preferences: validPreferences(settings?.preferences) ? settings.preferences : { ...DEFAULT_SETTINGS.preferences },
    sites,
    customRate: isPositiveRate(settings?.customRate) ? settings.customRate : null,
  };
}

const rates = new RateService({
  read: async () => (await chrome.storage.local.get('rateCache')).rateCache,
  write: async (rateCache) => { await chrome.storage.local.set({ rateCache }); },
});

let settingsQueue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const next = settingsQueue.then(operation, operation);
  settingsQueue = next.catch(() => undefined);
  return next;
}

async function reconcile(settings: Settings): Promise<void> {
  let changed = false;
  const matches: string[] = [];
  for (const host of Object.keys(settings.sites)) {
    const pattern = sitePattern(host);
    if (await chrome.permissions.contains({ origins: [pattern] })) matches.push(pattern);
    else { delete settings.sites[host]; changed = true; }
  }
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['auto-sites'] });
  if (matches.length) {
    const script: chrome.scripting.RegisteredContentScript = {
      id: 'auto-sites', matches, js: ['content.js'], css: ['content.css'], runAt: 'document_idle',
      allFrames: false, persistAcrossSessions: true,
    };
    if (scripts.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  } else if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: ['auto-sites'] });
  if (changed) await chrome.storage.local.set({ settings });
}

async function handle(request: BackgroundRequest): Promise<unknown> {
  if (request.type === 'GET_SETTINGS') { await settingsQueue; return readSettings(); }
  if (request.type === 'GET_RATE') {
    await settingsQueue;
    return rates.get((await readSettings()).customRate, request.refresh === true);
  }
  return serial(async () => {
    const settings = await readSettings();
    if (request.type === 'SAVE_PREFERENCES') {
      if (!validPreferences(request.preferences)) throw new Error('Choose valid currencies and a display mode.');
      if (request.hostname && Object.hasOwn(settings.sites, request.hostname)) settings.sites[request.hostname] = request.preferences;
      else settings.preferences = request.preferences;
    } else if (request.type === 'SET_CUSTOM_RATE') {
      if (request.rate !== null && !isPositiveRate(request.rate)) throw new Error('Enter a rate greater than zero.');
      settings.customRate = request.rate;
    } else if (request.type === 'SET_SITE') {
      const pattern = sitePattern(request.hostname);
      if (request.enabled) {
        if (!validPreferences(request.preferences)) throw new Error('Invalid site preferences.');
        if (!await chrome.permissions.contains({ origins: [pattern] })) throw new Error('Website access was not granted. You can still use Convert page.');
        settings.sites[request.hostname] = request.preferences;
      } else delete settings.sites[request.hostname];
    }
    await chrome.storage.local.set({ settings });
    if (request.type === 'SET_SITE') {
      await reconcile(settings);
      if (!request.enabled) await chrome.permissions.remove({ origins: [sitePattern(request.hostname)] });
    }
    return settings;
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.channel !== CHANNEL || !['GET_SETTINGS', 'GET_RATE', 'SAVE_PREFERENCES', 'SET_SITE', 'SET_CUSTOM_RATE'].includes(message.type)) return;
  // Page scripts can request conversion data; preference changes come from our UI.
  if (!['GET_SETTINGS', 'GET_RATE'].includes(message.type) &&
      !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    respond({ ok: false, error: 'This request must come from the extension popup.' });
    return;
  }
  void handle(message).then(
    (value) => respond({ ok: true, value } satisfies Reply<unknown>),
    (error) => respond({ ok: false, error: error instanceof Error ? error.message : 'The extension could not complete this action.' } satisfies Reply<never>),
  );
  return true;
});

const syncSites = () => { void serial(async () => reconcile(await readSettings())).catch(console.error); };
chrome.runtime.onInstalled.addListener(syncSites);
chrome.runtime.onStartup.addListener(syncSites);
chrome.permissions.onRemoved.addListener(syncSites);
const syncMenu = () => { void registerSelectionMenu().catch(console.error); };
chrome.runtime.onInstalled.addListener(syncMenu);
chrome.runtime.onStartup.addListener(syncMenu);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void convertContextSelection(info, tab, async () => { await settingsQueue; return readSettings(); }).catch(console.error);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') void clearSelectionError(tabId).catch(() => undefined);
});
chrome.tabs.onRemoved.addListener(tabId => {
  void clearSelectionError(tabId).catch(() => undefined);
});
