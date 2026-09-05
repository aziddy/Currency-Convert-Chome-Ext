import {
  backgroundRequest, CHANNEL, DEFAULT_SETTINGS, isPositiveRate, otherCurrency, selectionErrorKey, sitePattern, websiteHostname,
  type ContentRequest, type Currency, type DisplayMode, type EffectiveRate, type PageStatus, type Preferences, type Reply, type Settings,
} from '../shared/types';
import { createNotesEditor } from './notes';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
// Notes stay available even when tab access, conversion settings, or exchange rates fail.
const notesEditor = createNotesEditor({
  textarea: element<HTMLTextAreaElement>('notes'), status: element('notes-save-status'),
  retry: element<HTMLButtonElement>('notes-retry'),
});
window.addEventListener('pagehide', () => notesEditor.dispose(), { once: true });
const source = element<HTMLSelectElement>('source');
const target = element<HTMLSelectElement>('target');
const detect = element<HTMLInputElement>('detect');
const siteToggle = element<HTMLInputElement>('auto-site');
const convert = element<HTMLButtonElement>('convert');
const restore = element<HTMLButtonElement>('restore');
const refresh = element<HTMLButtonElement>('refresh');
const customToggle = element<HTMLInputElement>('custom-enabled');
const customInput = element<HTMLInputElement>('custom-rate');
const statusText = element<HTMLParagraphElement>('status');
let settings: Settings = structuredClone(DEFAULT_SETTINGS);
let tabId: number | null = null;
let hostname: string | null = null;
let pageStatus: PageStatus | null = null;
let rate: EffectiveRate | null = null;
let busy = false;
let refreshing = false;
let preferencesQueue: Promise<void> = Promise.resolve();

function preferences(): Preferences {
  return { source: source.value as Currency, target: target.value as Currency, sourceMode: detect.checked ? 'auto' : 'manual', display: document.querySelector<HTMLInputElement>('input[name=display]:checked')!.value as DisplayMode };
}

function showPreferences(value: Preferences): void {
  source.value = value.source; target.value = value.target; detect.checked = value.sourceMode === 'auto';
  document.querySelector<HTMLInputElement>(`input[name=display][value="${value.display}"]`)!.checked = true;
  updateHints();
}

function updateHints(): void {
  source.disabled = detect.checked;
  element<HTMLButtonElement>('swap').disabled = detect.checked;
  element('source-hint').textContent = detect.checked
    ? 'Uses currency labels and metadata. Skips uncertain $ prices.'
    : `Unlabeled $ prices are treated as ${source.value}.`;
  const mode = preferences().display;
  element('display-hint').textContent = mode === 'replace' ? 'Hover or focus a converted price to see the original.' : mode === 'beside'
    ? 'Keep original prices, with a smaller conversion beside them.' : 'Hover or keyboard-focus a price to reveal its conversion.';
}

function message(text: string, kind = 'info'): void { statusText.textContent = text; statusText.dataset.kind = kind; }
function errorMessage(error: unknown): void { message(error instanceof Error ? error.message : 'Something went wrong. Try again.', 'error'); }

function updateButtons(): void {
  convert.disabled = busy || !hostname || tabId === null;
  restore.disabled = busy || !(pageStatus?.active || pageStatus?.selectionCount);
  siteToggle.disabled = busy || !hostname;
  refresh.disabled = refreshing || customToggle.checked;
}

function showRate(value: EffectiveRate): void {
  rate = value;
  element('rate-value').textContent = `1 USD = ${value.usdToCad.toLocaleString('en-CA', { maximumFractionDigits: 6 })} CAD`;
  element('rate-info').textContent = value.source === 'custom' ? 'Your custom rate · used in both directions' :
    `${value.stale ? 'Offline · cached rate' : 'Daily reference rate'} · ${value.date} · Frankfurter`;
}

function showPageStatus(value: PageStatus): void {
  pageStatus = value;
  if (value.active && value.rate) showRate(value.rate);
  const selections = value.selectionCount ? `${value.selectionCount} selected ${value.selectionCount === 1 ? 'amount' : 'amounts'} converted.` : '';
  if (value.error) message(value.error, 'error');
  else if (value.active) {
    const count = `${value.count} ${value.count === 1 ? 'price' : 'prices'} ${value.preferences?.display === 'hover' ? 'ready on hover' : 'converted'}.`;
    const detected = value.preferences?.sourceMode === 'auto' && value.detectedSource ? ` Detected ${value.detectedSource}.` : '';
    const ambiguous = value.ambiguous ? ` ${value.ambiguous} uncertain $ ${value.ambiguous === 1 ? 'price skipped' : 'prices skipped'}; choose a source manually to convert ${value.ambiguous === 1 ? 'it' : 'them'}.` : '';
    const empty = !value.count && !value.ambiguous ? ' No prices need conversion to the selected currency.' : '';
    message(count + detected + ambiguous + empty + (selections ? ` ${selections}` : '') + (value.rate?.stale ? ' Using a cached rate.' : ''), value.ambiguous || value.rate?.stale ? 'warning' : 'info');
  } else if (selections) message(`${selections} Restore originals to undo.`, 'info');
  updateButtons();
}

async function toPage(request: ContentRequest): Promise<PageStatus> {
  if (tabId === null) throw new Error('Open a website to convert prices.');
  const result = await chrome.tabs.sendMessage(tabId, { channel: CHANNEL, ...request }, { frameId: 0 }) as Reply<PageStatus>;
  if (!result?.ok) throw new Error(result?.error ?? 'Reload the page and try again.');
  return result.value;
}

async function ensureContent(): Promise<void> {
  if (!hostname || tabId === null) throw new Error('Chrome does not allow conversion on this page. Open an ordinary website.');
  try { await toPage({ type: 'STATUS' }); }
  catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch { throw new Error('Chrome could not access this page. Reload it, then open the extension from the toolbar.'); }
  }
}

async function refreshRate(force = false): Promise<void> {
  refreshing = true; updateButtons();
  try { showRate(await backgroundRequest<EffectiveRate>({ type: 'GET_RATE', refresh: force })); }
  catch (error) { element('rate-value').textContent = 'Exchange rate unavailable'; element('rate-info').textContent = 'Refresh to retry, or use your own rate.'; errorMessage(error); }
  finally { refreshing = false; updateButtons(); }
}

function savePreferences(): void {
  updateHints();
  const next = preferences();
  preferencesQueue = preferencesQueue.catch(() => undefined).then(async () => {
    settings = await backgroundRequest<Settings>({ type: 'SAVE_PREFERENCES', preferences: next, hostname });
    if (pageStatus?.active) showPageStatus(await toPage({ type: 'APPLY', preferences: next, automatic: siteToggle.checked }));
  }).catch(errorMessage);
}

async function convertPage(): Promise<void> {
  busy = true; updateButtons(); message('Finding prices…');
  try {
    await preferencesQueue;
    await ensureContent();
    showPageStatus(await toPage({ type: 'APPLY', preferences: preferences(), automatic: siteToggle.checked }));
  } catch (error) { errorMessage(error); }
  finally { busy = false; updateButtons(); }
}

source.addEventListener('change', () => { target.value = otherCurrency(source.value as Currency); savePreferences(); });
target.addEventListener('change', () => { source.value = otherCurrency(target.value as Currency); savePreferences(); });
detect.addEventListener('change', savePreferences);
document.querySelectorAll<HTMLInputElement>('input[name=display]').forEach(input => input.addEventListener('change', savePreferences));
element('swap').addEventListener('click', () => { [source.value, target.value] = [target.value, source.value]; savePreferences(); });
convert.addEventListener('click', () => { void convertPage(); });
restore.addEventListener('click', async () => {
  busy = true; updateButtons();
  try { showPageStatus(await toPage({ type: 'RESTORE' })); message('Original prices restored. Paused until conversion or navigation.'); }
  catch (error) { errorMessage(error); }
  finally { busy = false; updateButtons(); }
});
refresh.addEventListener('click', () => { void refreshRate(true); });

siteToggle.addEventListener('change', async () => {
  if (!hostname) return;
  const enabled = siteToggle.checked;
  busy = true; updateButtons();
  message(enabled ? 'Allow website access in Chrome to enable automatic conversion…' : 'Turning off automatic conversion…');
  try {
    // Keep the request directly in the user's click gesture, before any other await.
    if (enabled && !await chrome.permissions.request({ origins: [sitePattern(hostname)] })) {
      siteToggle.checked = false;
      message('Website access was not granted. You can still use Convert page.', 'warning');
      return;
    }
    await preferencesQueue;
    settings = await backgroundRequest<Settings>({ type: 'SET_SITE', hostname, enabled, preferences: preferences() });
    if (enabled) { await ensureContent(); showPageStatus(await toPage({ type: 'APPLY', preferences: preferences(), automatic: true })); }
    else {
      try { showPageStatus(await toPage({ type: 'STOP_PAGE' })); } catch { pageStatus = null; }
      message('Automatic conversion is off for this site.');
    }
  } catch (error) { siteToggle.checked = Boolean(settings.sites[hostname]); errorMessage(error); }
  finally { busy = false; updateButtons(); }
});

async function saveCustomRate(enabled: boolean): Promise<void> {
  const custom = enabled ? Number(customInput.value) : null;
  if (enabled && !isPositiveRate(custom)) {
    customToggle.checked = settings.customRate !== null;
    element('custom-feedback').textContent = 'Enter a rate greater than zero, then Save.';
    customInput.focus();
    return;
  }
  try {
    settings = await backgroundRequest<Settings>({ type: 'SET_CUSTOM_RATE', rate: custom });
    customToggle.checked = enabled;
    element('custom-feedback').textContent = enabled ? 'Saved. Using this rate in both directions.' : 'Using the daily reference rate.';
    await refreshRate();
    if (pageStatus?.active) showPageStatus(await toPage({ type: 'APPLY', preferences: preferences(), automatic: siteToggle.checked }));
  } catch (error) { errorMessage(error); }
  updateButtons();
}
customToggle.addEventListener('change', () => { void saveCustomRate(customToggle.checked); });
element<HTMLFormElement>('custom-form').addEventListener('submit', event => { event.preventDefault(); void saveCustomRate(true); });

async function initialize(): Promise<void> {
  try {
    const [saved, tabs] = await Promise.all([
      backgroundRequest<Settings>({ type: 'GET_SETTINGS' }),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    settings = saved;
    const tab = tabs[0];
    tabId = tab?.id ?? null; hostname = websiteHostname(tab?.url);
    showPreferences((hostname && settings.sites[hostname]) || settings.preferences);
    siteToggle.checked = Boolean(hostname && settings.sites[hostname]);
    customToggle.checked = settings.customRate !== null;
    if (settings.customRate !== null) { customInput.value = String(settings.customRate); element<HTMLDetailsElement>('custom-details').open = true; }
    element('site-name').textContent = hostname ?? 'Unavailable on this page';
    message(hostname ? 'Ready when you are. Convert the prices on this page.' : 'Open an ordinary website. Chrome protects internal pages, the Web Store, and PDF viewers.', hostname ? 'info' : 'warning');
    if (hostname) {
      try {
        const current = await toPage({ type: 'STATUS' });
        if (current.preferences) showPreferences(current.preferences);
        showPageStatus(current);
      } catch { /* Manual mode has not injected a script yet. */ }
    }
    updateButtons();
    await refreshRate();
    if (!customInput.value && rate) customInput.value = String(rate.usdToCad);
    if (tabId !== null) {
      const key = selectionErrorKey(tabId);
      const savedError = (await chrome.storage.session.get(key))[key];
      if (typeof savedError === 'string') {
        message(savedError, 'error');
        await chrome.storage.session.remove(key);
        await chrome.action.setBadgeText({ tabId, text: '' });
      }
    }
  } catch (error) { errorMessage(error); }
}

// The popup lives only while open; this also reports prices added by infinite scroll.
const poll = setInterval(() => {
  if (busy || !hostname || !(pageStatus?.active || pageStatus?.selectionCount)) return;
  void toPage({ type: 'STATUS' }).then(showPageStatus).catch(() => {
    pageStatus = null; updateButtons(); message('The page changed. Open the extension again to convert it.');
  });
}, 1000);
window.addEventListener('pagehide', () => clearInterval(poll), { once: true });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings?.newValue) return;
  settings = changes.settings.newValue as Settings;
  siteToggle.checked = Boolean(hostname && settings.sites[hostname]);
  customToggle.checked = settings.customRate !== null;
  updateButtons();
});
void initialize();
