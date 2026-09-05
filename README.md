# Price Converter · USD & CAD

A Chrome extension that converts prices in the page you are browsing. It runs locally, uses daily exchange rates, and can remember different preferences for different websites.

## Install in Chrome

The generated **`dist/` folder is the extension**. If it is already present, start at step 2.

1. With Node.js 22.12 or newer installed, run:

   ```sh
   npm ci
   npm run build
   ```

2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select this project's **`dist`** folder.
4. Pin **Price Converter** from Chrome's extensions menu.
5. Open a website, click the extension, and select **Convert page**.

After rebuilding, click the extension's reload button on `chrome://extensions` and reload any pages where an older version was running. Keep `dist/` in place while the extension is installed.

## How it works

The defaults are **USD → CAD**, **Replace**, **manual source selection**, and **click to convert**.

| Setting | Behavior |
| --- | --- |
| Replace | Replaces detected price text. Hover or keyboard-focus it for the original. |
| Beside | Keeps the original and adds a smaller converted amount beside it. |
| On hover | Keeps the visible price unchanged. Hover or keyboard-focus it for the conversion. |
| Detect source currency | Uses explicit currency labels and structured currency metadata. Ambiguous dollar signs are skipped. |
| Always convert this site | Requests access to this hostname and remembers its currencies, detection setting, and display mode. |
| Restore originals | Restores the current page and pauses it until another conversion or a full navigation/reload. |

Converted amounts have an approximation marker and an explicit currency code. Mode, direction, and rate changes recalculate from original prices, so conversions do not compound. Newly loaded products and updated prices are processed while conversion is active.

In manual mode, a bare `$` follows the selected source currency. Explicit labels such as `USD`, `US$`, `CAD`, `CA$`, and `C$` always take precedence for that individual price. Prices already in the target currency and recognized unsupported currencies are left unchanged. The swap button reverses manual source and target; in detection mode, choose the target directly.

Automatic detection first uses currency metadata associated with the price, then page metadata (including JSON-LD), then consistent explicit page price labels. Missing, conflicting, or unsupported currency metadata does not become a guess about a bare dollar sign. The site's country, browser language, and domain suffix are not treated as proof of its currency.

Site preferences cover the exact hostname on HTTP and HTTPS, including all paths and ports. `www.example.com` and `shop.example.com` are separate sites. Disabling site automation restores its active automatic conversions across open tabs and removes the optional access grant. A permission revoked in Chrome also stops automation. Settings for other sites remain independent.

## Convert a selected number

Select one number or USD/CAD price in displayed webpage text, right-click, and choose **Convert selected amount**. There is no need to open the popup or convert the rest of the page first.

The action uses this hostname's saved preferences, otherwise the global popup preferences, and the same daily or custom exchange rate. Explicit USD/CAD labels take precedence. In automatic-detection mode, reliable currency metadata or page labels are used; when the source is uncertain, this explicit action falls back to the saved source currency. An amount already in the target currency is left unchanged with an explanation.

Only the selected amount is replaced, using an explicit target code and approximation marker such as `≈ CAD 140.00`, regardless of the popup's display mode. A directly adjoining currency marker is included when it belongs to the same price, including simple split inline markup. Other text, prices, elements, and event listeners remain intact. Hover or keyboard-focus the conversion to inspect the original.

Selected conversions have a separate count in the popup. They retain the rate and direction used when clicked, even when page-conversion settings or rates change. **Restore originals** undoes both selected and whole-page conversions; turning off site automation only restores the automatic page conversions. Reloading the website also clears selections. If the website changes the converted text, its newer content takes precedence over saved undo data.

Select the complete amount: multiple amounts, partial digits, unsupported currencies, and unrelated text are rejected. Inputs, editable fields, code, hidden text, iframes, shadow DOM, PDFs, and Chrome-protected pages are not supported. Text that already contains a tracked conversion must be restored before converting it again. If a selection changes while a rate is being fetched, nothing is replaced. Errors appear in a dismissible page notice; if Chrome prevents page access, an **!** badge directs you to the popup for an explanation.

The menu appears only for text selections on HTTP/HTTPS pages and validates the amount when clicked. It adds the `contextMenus` permission and uses temporary `activeTab` access from the menu click, not always-on website access or a new settings toggle.

## Notes

The popup includes a plain-text **Notes** box below the conversion controls. It is one shared note for every website, with no separate Save button. Text, line breaks, and Unicode are preserved; clearing the box saves an empty note.

Edits are sent immediately to the background worker and saved in order. **Saving…** changes to **Saved** once the latest edit is stored. Closing the popup does not discard edits already submitted to the worker. Notes remain available offline and on Chrome-protected pages, independently of exchange-rate loading or conversion errors.

If saving fails, the draft stays visible: keep the popup open and click **Retry**. If loading fails, the box stays disabled until a retry succeeds so an existing note cannot be accidentally overwritten. Notes are stored locally in this Chrome profile, persist across browser restarts and extension reloads, and are removed if the extension is uninstalled. They are not synced to other devices or sent to the exchange-rate service.

## Exchange rates and privacy

Daily rates come from [Frankfurter's public API](https://frankfurter.dev/). The extension fetches one USD/CAD pair, caches it for 24 hours, and uses the reciprocal for CAD/USD. The popup shows the rate's publication date; **Refresh** requests a new rate. These are reference rates, not live quotes or guaranteed card/checkout rates.

If the service is unavailable, the last valid cached rate remains usable with a visible cached-rate indication. With no valid cache, prices stay unchanged until a request succeeds or you enter a custom rate. Requests time out after eight seconds.

Expand **Use your own exchange rate**, enter the number of CAD per **1 USD**, and click **Save**. This enables a global custom rate for both conversion directions and all sites. Disable **Custom rate** to return to daily rates. Custom mode does not request daily rates.

Page text, URLs, prices, preferences, and notes are not sent to the rate service. Settings, cached rates, and notes stay in `chrome.storage.local`; there is no account, analytics, or cloud sync. The only external request is for the exchange-rate pair, so the rate provider still sees ordinary network information such as the request's IP address. See [Frankfurter's documentation](https://frankfurter.dev/) for provider details.

The extension requires `activeTab`, `scripting`, `storage`, and `contextMenus`, plus access to the rate API. Persistent access to other websites is optional and requested only when enabling automation. No always-on content script runs across all websites. Context-menu error messages are temporarily stored per tab in `chrome.storage.session` and cleared when viewed, after a successful retry, or on navigation; selected text is not stored there.

## Supported content and limits

Supported: ordinary top-level webpage text, common English/French Canadian number formats, simple prices split across inline elements, price ranges expressed as separate amounts, and dynamically inserted or updated prices.

This version does not convert images, canvas, PDFs, iframes, shadow DOM, Chrome internal pages, or the Chrome Web Store. It skips hidden content, editable regions, form fields, scripts, styles, and code blocks. There are no retailer-specific adapters; unusually complex price markup (including some separate whole/cents layouts) may be skipped or require an adapter. Other dollar currencies are outside the supported pair: use manual source selection only on pages where the bare dollar signs actually mean USD or CAD.

Original elements and event listeners are retained, and restoration avoids replacing newer website text with old prices. Sites that continually reconstruct or interpret their own price markup may still be incompatible; use **Restore originals** and reload if needed. The extension does not rewrite form values or network checkout requests.

## Development and verification

```sh
npm run dev         # Watch TypeScript; reload the unpacked extension after updates
npm run check       # Type checking, unit/DOM tests, and production build
npm run demo        # Local test shop at http://127.0.0.1:4173
npx playwright install chromium
npm run test:e2e    # Build, then test the actual extension in isolated Chromium
```

`dev` watches TypeScript only. Re-run `build` after changing HTML, CSS, icons, or the manifest. The project has no runtime package dependencies; esbuild bundles the TypeScript entrypoints and generates PNG extension icons.

Browser tests use a temporary profile, deterministic cached and mocked API rates, a localhost fixture server, and Chrome's actual extension APIs. A fresh-install test exercises the background worker's native network request without a prefilled cache. They never use your regular Chrome profile. If Chromium is installed in a custom location, set `PLAYWRIGHT_BROWSERS_PATH` to that browser-cache directory when running the tests. Port 4173 must be available.

Tests cover parsing and formatting; ambiguous/structured currency detection; display modes and restoration; page updates and observer loops; rate caching, invalid data, timeouts, and custom overrides; and Chrome's popup, site permissions, hostname isolation, and background-worker lifecycle. Selection tests cover adjacent markers, partial/split-node replacements, independent undo, stale selections, excluded content, and coexistence with automation. Headless tests pre-approve the localhost hostname through Chrome's extension-management API, then exercise the extension's real optional-permission request, automation, and revocation. Permission denial is simulated at the prompt boundary. Selection browser tests grant fixture access from a test-only button in an extension tab and send the actual content messages; unit tests cover the native-menu handler. Native OS menu clicks and their `activeTab` grant need a manual smoke test in Chrome. Failed browser tests retain traces and screenshots under `test-results/`.

Notes tests cover ordered saves, immediate popup closure, multiline and Unicode text, clearing, cross-site sharing, storage failures and retries, access restrictions, and persistence across worker and full browser restarts. Browser checks also cover offline/protected-page use and popup layout.

Source layout: `src/background/` handles rates, notes storage, and site registration, `src/content/` handles detection and reversible rendering, `src/popup/` handles controls and the notes editor, and `src/shared/` defines the typed interfaces. Static extension assets are in `public/`; tests and demonstration pages are in `tests/`.

This release is intended for local unpacked installation. Chrome Web Store publication is not configured.
