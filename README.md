# Wealthica Metals Power-Up

A static browser Power-Up for two physical bullion holdings: gold in fine troy ounces and silver in fine grams. Fetches EUR metal prices and automatically updates selected Wealthica assets using your saved settings when opened, and hourly while open and visible.

## Publish on GitHub Pages

1. Create a repository such as `wealthica-metals`. Public repositories support free GitHub Pages hosting.
2. Upload the **contents** of this folder to the repository root, including the `vendor` folder. `index.html` must be at the repository root.
3. In **Settings → Pages**, choose **Deploy from a branch**, branch **main**, folder **/(root)**, then **Save**.
4. Copy the HTTPS URL shown by GitHub after deployment succeeds.
5. Inside Wealthica, install/open the [Developer Add-on](https://app.wealthica.com/addons/details?id=wealthica/wealthica-dev-addon), open **Configure**, paste the URL into **Add-on URL**, and press **Load**.

The site needs no build, server, domain purchase, login, or API keys. Do not upload private account exports or put account credentials into these files.

## First use

1. Create separate EUR valuable assets in Wealthica for Physical Gold and Physical Silver if they do not already exist. Set purchase cost only from your actual records; this tool does not set or modify it.
2. Open the Power-Up and enter your quantities. Use **fine-metal content**, not the gross weight of an alloy coin. One troy ounce is exactly 31.1034768 grams.
3. Choose the matching EUR asset for each metal. Assets are never matched silently by name, created, or deleted.
4. A **0% resale deduction** values metal at the feed price. Optionally enter your own dealer resale deduction. This is a model, not a live coin/bar dealer quote; do not infer precise sale proceeds.
5. Press **Refresh prices & preview** to check your quantities and selected targets before saving.
6. Press **Save settings** once. This stores your configuration in Wealthica and applies the values. Subsequent openings update automatically without pressing **Update Wealthica**. Updates change only `market_value` and are verified by reading back the assets.

Prices refresh on opening and hourly while the page is open and visible. Automatic writes require quantities and targets to match the saved configuration; unsaved edits are previewed only. Unchanged values cause no automatic writes. There is no background daily job while the page is closed. Quotes are cached in memory for 30 seconds. The price timestamps are displayed; quotes older than 96 hours (allowing weekends/holidays) and previews older than 5 minutes cannot be written. A change above 50% pauses automatic updates and requires checking the corresponding box before a manual update. If one update fails or cannot be verified, further automatic writes pause for that session and the page lists any completed writes; there is no automatic rollback or retry. Check the assets before manually retrying. Browser suspension, authentication expiry and price-service failures can prevent updates.

## Data and dependencies

- Prices: `https://api.gold-api.com/price/XAU/EUR` and `/price/XAG/EUR`, in EUR per fine troy ounce. Gold API documents free unauthenticated, CORS-enabled real-time endpoints. Only these public price requests leave the browser; they contain no holding quantities or Wealthica asset IDs.
- Wealthica: official `@wealthica/wealthica.js` **1.0.11** browser SDK, vendored locally with its MIT license. This version is used by Wealthica's published example. It communicates with the parent Wealthica dashboard; the page does not ask for credentials.
- Configuration: stored through `addon.saveData`, under `metalsTrackerV1`. No configuration is hardcoded in the public source or persisted to browser localStorage.
- Writes: `PUT assets/{id}` with `{ market_value: <EUR number> }`, after both selected assets have been freshly checked for currency, identity and changes since preview.

## Validation and limits

Run `node --experimental-vm-modules --test tests/*.test.mjs`. Tests cover saved-settings automatic updates on opening, first-use/standalone isolation, unsaved edits, unchanged values, paused retries, unit conversion, invalid feeds, stale previews, target validation, concurrent changes, market-value-only writes and partial failures.

The public price feeds were fetched successfully during development. The financial API flow is tested with a simulated Wealthica parent, not your authenticated Wealthica account. Actual Developer Add-on availability, permissions and writes must be confirmed in your signed-in account after loading the hosted URL. Price service uptime and future API changes are external dependencies.

References checked 2026-10-04:
- https://github.com/wealthica/wealthica.js
- https://wealthica.com/docs/api/
- https://gold-api.com/docs
- https://gold-api.com/llms.txt
- https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
