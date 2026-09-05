import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertContextSelection, registerSelectionMenu, SELECTION_MENU_ID } from '../../src/background/context-menu';
import { DEFAULT_SETTINGS, selectionErrorKey } from '../../src/shared/types';

const tab = { id: 7, url: 'https://shop.example.com/product' } as chrome.tabs.Tab;
const click: chrome.contextMenus.OnClickData = { menuItemId: SELECTION_MENU_ID, editable: false, selectionText: '100', pageUrl: tab.url, frameId: 0 };
const settings = vi.fn(async () => structuredClone(DEFAULT_SETTINGS));
const api = {
  runtime: { lastError: undefined as { message: string } | undefined },
  contextMenus: { removeAll: vi.fn((callback: () => void) => callback()), create: vi.fn((_props: unknown, callback: () => void) => callback()) },
  tabs: { sendMessage: vi.fn(async (_id: number, _request: unknown, _options: unknown) => ({ ok: true, value: {} })) },
  scripting: { insertCSS: vi.fn(async () => {}), executeScript: vi.fn(async () => []) },
  storage: { session: { set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
  action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
};
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('chrome', api); api.runtime.lastError = undefined; });
afterEach(() => vi.unstubAllGlobals());

describe('selection context menu', () => {
  it('registers a selection-only item without duplicate IDs', async () => {
    await registerSelectionMenu(); await registerSelectionMenu();
    expect(api.contextMenus.removeAll).toHaveBeenCalledTimes(2);
    expect(api.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({
      id: SELECTION_MENU_ID, title: 'Convert selected amount', contexts: ['selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }), expect.any(Function));
  });
  it('surfaces menu registration errors', async () => {
    api.runtime.lastError = { message: 'cannot create menu' };
    await expect(registerSelectionMenu()).rejects.toThrow('cannot create menu');
  });
  it('injects into an untouched main page and uses global preferences', async () => {
    api.tabs.sendMessage.mockRejectedValueOnce(new Error('no content script'));
    await convertContextSelection(click, tab, settings);
    expect(api.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7, frameIds: [0] }, files: ['content.js'] });
    expect(api.tabs.sendMessage).toHaveBeenLastCalledWith(7, expect.objectContaining({
      type: 'CONVERT_SELECTION', selectionText: '100', preferences: DEFAULT_SETTINGS.preferences,
    }), { frameId: 0 });
    expect(api.storage.session.remove).toHaveBeenCalledWith(selectionErrorKey(7));
    expect(api.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 7, text: '' });
  });
  it('uses exact-hostname settings instead of global preferences', async () => {
    const preference = { ...DEFAULT_SETTINGS.preferences, source: 'CAD' as const, target: 'USD' as const };
    const read = async () => ({ ...DEFAULT_SETTINGS, sites: { 'shop.example.com': preference } });
    await convertContextSelection(click, tab, read);
    expect(api.tabs.sendMessage).toHaveBeenLastCalledWith(7, expect.objectContaining({ preferences: preference }), { frameId: 0 });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...click, editable: true }, 'Inputs'],
    [{ ...click, frameId: 4 }, 'frames'],
    [{ ...click, pageUrl: 'chrome://settings' }, 'unavailable'],
  ])('reports unsupported contexts without converting', async (info, error) => {
    await convertContextSelection(info as chrome.contextMenus.OnClickData, tab, settings);
    expect(api.tabs.sendMessage.mock.calls.some(([, request]) => (request as { type: string }).type === 'CONVERT_SELECTION')).toBe(false);
    expect(api.storage.session.set).toHaveBeenCalledWith({ [selectionErrorKey(7)]: expect.stringContaining(error as string) });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '!' });
  });
  it('provides a popup fallback when Chrome blocks injection', async () => {
    api.tabs.sendMessage.mockRejectedValueOnce(new Error('no content script'));
    api.scripting.executeScript.mockRejectedValueOnce(new Error('cannot access page'));
    await convertContextSelection(click, tab, settings);
    expect(api.storage.session.set).toHaveBeenCalledWith({ [selectionErrorKey(7)]: expect.stringContaining('Chrome could not access') });
  });
  it('ignores unrelated menu events and missing tabs', async () => {
    await convertContextSelection({ ...click, menuItemId: 'other' }, tab, settings);
    await convertContextSelection(click, undefined, settings);
    expect(api.tabs.sendMessage).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
  });
});
