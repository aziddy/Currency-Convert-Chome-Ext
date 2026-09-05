import { CHANNEL, selectionErrorKey, websiteHostname, type ContentRequest, type PageStatus, type Reply, type Settings } from '../shared/types';

export const SELECTION_MENU_ID = 'convert-selected-amount';

export async function registerSelectionMenu(): Promise<void> {
  // Callback forms preserve compatibility with Chrome 120.
  await new Promise<void>((resolve, reject) => chrome.contextMenus.removeAll(() => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve();
  }));
  await new Promise<void>((resolve, reject) => chrome.contextMenus.create({
    id: SELECTION_MENU_ID, title: 'Convert selected amount', contexts: ['selection'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  }, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve();
  }));
}

export async function clearSelectionError(tabId: number): Promise<void> {
  await chrome.storage.session.remove(selectionErrorKey(tabId));
  await chrome.action.setBadgeText({ tabId, text: '' });
}

async function toContent(tabId: number, request: ContentRequest): Promise<PageStatus> {
  const reply = await chrome.tabs.sendMessage(tabId, { channel: CHANNEL, ...request }, { frameId: 0 }) as Reply<PageStatus>;
  if (!reply?.ok) throw new Error(reply?.error ?? 'Reload the page and select the amount again.');
  return reply.value;
}

async function ensureContent(tabId: number): Promise<void> {
  try { await toContent(tabId, { type: 'STATUS' }); }
  catch {
    await chrome.scripting.insertCSS({ target: { tabId, frameIds: [0] }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
  }
}

export async function convertContextSelection(info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab | undefined,
  readSettings: () => Promise<Settings>): Promise<void> {
  if (info.menuItemId !== SELECTION_MENU_ID || tab?.id == null) return;
  const tabId = tab.id;
  let contentReady = false;
  try {
    const hostname = websiteHostname(info.pageUrl ?? tab.url);
    if (!hostname) throw new Error('Selection conversion is unavailable on this page. Open an ordinary website.');
    if (info.frameId && info.frameId !== 0) throw new Error('Selection conversion does not support frames. Select text in the main page.');
    await ensureContent(tabId);
    contentReady = true;
    if (info.editable) throw new Error('Select displayed page text. Inputs and editable fields are left unchanged.');
    if (!info.selectionText?.trim()) throw new Error('Select one number or one USD/CAD price to convert.');
    const settings = await readSettings();
    await toContent(tabId, { type: 'CONVERT_SELECTION', selectionText: info.selectionText,
      preferences: settings.sites[hostname] ?? settings.preferences });
    await clearSelectionError(tabId);
  } catch (error) {
    const message = contentReady || !websiteHostname(info.pageUrl ?? tab.url) || Boolean(info.frameId)
      ? (error instanceof Error ? error.message : 'Selection conversion failed.')
      : 'Chrome could not access this page. Reload it and retry; protected pages and PDFs cannot be converted.';
    if (contentReady) {
      try { await toContent(tabId, { type: 'SELECTION_ERROR', error: message }); } catch { /* The page may have navigated. */ }
    }
    await chrome.storage.session.set({ [selectionErrorKey(tabId)]: message });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#985227' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
  }
}
