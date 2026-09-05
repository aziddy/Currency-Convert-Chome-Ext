import { backgroundRequest, CHANNEL, validPreferences, type ContentRequest, type EffectiveRate, type PageStatus, type Preferences, type Settings } from '../shared/types';
import { ConversionEngine } from './engine';

// Programmatic injection and the registered auto script can meet on the same page.
const guard = '__usdCadPriceConverterV1';
const isolatedWindow = window as unknown as Record<string, unknown>;
if (!isolatedWindow[guard]) {
  isolatedWindow[guard] = true;
  let generation = 0;
  let paused = false;
  let wanted = false;
  let settings: Settings | null = null;
  let status: PageStatus = { active: false, automatic: false, count: 0, ambiguous: 0, detectedSource: null, preferences: null, rate: null, error: null };
  const engine = new ConversionEngine(document, scan => { status = { ...status, ...scan }; });

  async function apply(preferences: Preferences, automatic: boolean): Promise<PageStatus> {
    if (!validPreferences(preferences)) throw new Error('Invalid conversion preferences.');
    const current = ++generation;
    wanted = true;
    paused = false;
    status = { ...status, preferences, automatic, error: null };
    try {
      const rate = await backgroundRequest<EffectiveRate>({ type: 'GET_RATE' });
      if (current !== generation) return status;
      status = { ...status, ...engine.apply(preferences, rate), rate, active: true, error: null };
    } catch (error) {
      if (current !== generation) return status;
      engine.restore();
      status = { ...status, active: false, count: 0, error: error instanceof Error ? error.message : 'Conversion failed.' };
    }
    return status;
  }

  function restore(): PageStatus {
    generation++;
    wanted = false;
    paused = true;
    status = { ...status, ...engine.restore(), active: false, error: null };
    return status;
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.channel !== CHANNEL || !['APPLY', 'RESTORE', 'STATUS'].includes(message.type)) return;
    const request = message as ContentRequest;
    if (request.type === 'STATUS') { respond({ ok: true, value: { ...status, ...engine.status() } }); return; }
    if (request.type === 'RESTORE') { respond({ ok: true, value: restore() }); return; }
    void apply(request.preferences, request.automatic).then(
      value => respond({ ok: true, value }),
      error => respond({ ok: false, error: error instanceof Error ? error.message : 'Conversion failed.' }),
    );
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      const before = settings;
      settings = changes.settings.newValue as Settings;
      const site = settings?.sites?.[location.hostname];
      if (before?.sites?.[location.hostname] && !site && status.automatic) { restore(); return; }
      if (!paused && site && (status.automatic || !wanted)) { void apply(site, true); return; }
      if (wanted && status.preferences && before?.customRate !== settings?.customRate) void apply(status.preferences, status.automatic);
    }
    if (changes.rateCache && wanted && status.rate && status.preferences && settings?.customRate == null) void apply(status.preferences, status.automatic);
  });

  const initialGeneration = generation;
  void backgroundRequest<Settings>({ type: 'GET_SETTINGS' }).then(value => {
    settings = value;
    const site = settings.sites[location.hostname];
    if (site && generation === initialGeneration && !paused) void apply(site, true);
  }).catch(error => { status.error = error instanceof Error ? error.message : 'Reload the page to reconnect the extension.'; });
}
