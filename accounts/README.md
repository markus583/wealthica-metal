# Manual Accounts for Wealthica

A mobile-friendly Power-Up for active manual cash/bank accounts. One entry records a transaction and explicitly updates Wealthica's separate account valuation. Existing imported history is left untouched. No historical reconstruction or automatic bank scraping.

## Open

Hosted path: `/accounts/` in this repository's GitHub Pages site. The root metals Power-Up is unchanged.

- Direct public visit: an interactive demo with fictional balances, held in memory. Nothing is sent to Wealthica.
- Live use: install/open [Wealthica Developer Add-on](https://app.wealthica.com/addons/details?id=wealthica/wealthica-dev-addon), Configure → Add-on URL → this page's HTTPS URL → Load.
- A phone browser can display the same responsive interface. Wealthica's native mobile app may not expose Developer Add-on; availability is controlled by Wealthica.

## First live use

1. Create a disposable **manual bank/cash account** named `Power-Up Test` in Wealthica, not an Other Asset or connected institution. A zero or small fictional starting balance is fine.
2. Open Setup, refresh accounts, select the test account, confirm it is disposable, and run the connection test.
3. The test saves a 1-unit expense, verifies its native-currency amount and the reduced account balance, edits it to 0.50, verifies again, then soft-deletes the transaction and restores the exact original balance. EUR/CAD/CHF/USD/GBP test accounts are supported.
4. Live account entry unlocks only after these reads/writes pass. If interrupted, Check & finish resolves the current operation; Continue connection test resumes the remaining phases. Nothing resumes automatically on opening.
5. Set each real account's actual current balance in Setup. This establishes a forward-only starting point. Prior imports are retained as records and are not summed into this balance again.

## Entry behavior

- Expense / income: native-currency amount with a negative / positive cash effect.
- Manual-to-manual transfer: two linked transaction records; both balances update. One PUT for accounts in the same institution. Different currencies require actual credited/debited amounts; no guessed FX. Include any fee in total source debit (fees are not separately categorized in this version).
- External transfer: only the selected manual side changes. Never writes to connected CIBC/IBKR accounts or duplicates their synced transactions.
- Edit/delete: only this Power-Up's marked entries can be changed. Transfer legs change together. The original date and account are fixed; delete and recreate a mistaken entry to change them.
- Statement balance check: explicitly sets the current balance without inventing an expense or income. Entries already included in that statement balance become locked against later balance adjustments from this tool. They remain visible and exportable.
- Categories: optional Wealthica category IDs loaded from its API. If categories cannot load, entry remains usable without them.

## Financial API and recovery

The official vendored Wealthica SDK at `../vendor/addon.min.js` communicates through the signed-in parent dashboard. This page does not request or embed API keys, credentials or tokens. GET reads user/institutions/categories/transactions; POST creates marked transactions; PUT updates those transactions or manual institutions. Balance writes contain documented account fields, including `currency_value`, and preserve all sibling account entries in the institution.

Every operation is previewed, rechecked against a fresh account snapshot, durably journaled in Wealthica add-on preferences before writes, and read back after each write. Arithmetic uses integer minor units. A pending operation blocks new entries. Create steps carry unique markers; an uncertain POST is searched by marker rather than blindly retried. A definitive 400/401/403/404/422 rejection is recorded as rejected. An operation can be discarded only if all steps remain pending/rejected; partial saves need recovery or explicit reconciliation in Wealthica.

An unknown POST that never appears will remain paused. The app cannot safely prove that a server will never commit a delayed request, so it will not repost or silently discard it. Download the recovery record before resolving an unfinishable operation manually. Conflicting external balance/transaction edits also stop recovery. No automatic rollback hides partial writes.

Wealthica does **not** expose an atomic transaction-and-balance write or compare-and-swap version. This app uses fresh comparisons and a same-browser Web Lock to reduce conflicts; it cannot guarantee isolation across devices, other add-ons, native forms or independent bank edits. Use one tab/device at a time. Sibling metadata and account list are checked before/after each balance write. If the live API handles manual account values differently from its docs, the connection test fails and real entry stays locked.

Settings, checkpoints and the single pending recovery journal share the Developer Add-on preference namespace with other custom pages and preserve their keys. Do not keep multiple custom pages writing those preferences at once. Add-on preferences are stored unencrypted by Wealthica, like other add-on configuration; they are not a secure vault. The page sends no analytics or direct external network requests (`connect-src 'none'`). Public source/demo contains no personal account IDs, balances or exports. `noindex` discourages search indexing; it is not access control.

Eligible accounts: active, unignored institutions with `manual: true`, fiat `cash` / `chequing` / `savings` accounts, usable `currency_value`, and no securities positions. Connected portfolios, credit cards, loans, crypto assets and Other Assets are excluded. Account data missing these fields is left untouched. Existing account types may require adjustment in Wealthica before they can be managed here.

## Validation

Run `node --test accounts/tests/core.test.mjs` from the repository root. Tests cover money parsing, transaction/balance operations, transfers, amendments, reconciliation boundaries, stale snapshots, storage failures, lost POST/PUT acknowledgements, partial transfers, and connected-account isolation.

For browser integration checks, install Playwright and its Chromium browser as development tools, then run `node accounts/tests/browser.test.cjs`. It checks mobile entry/edit/delete, foreign-currency transfers, 320–1280px layouts, the live-mode gate through a simulated parent bridge, interrupted-save recovery and settings across reload. Screenshots default to `/tmp/wealthica-manual-account-checks`; optional `MANUAL_ACCOUNTS_SCREENSHOTS` / `MANUAL_ACCOUNTS_CHROME` variables override the destination and browser executable. This does not access real accounts.

The financial workflow is tested with a simulated API. Your authenticated Wealthica session and its write permissions cannot be tested from the public demo. The first-use live test is the required proof before using real accounts.

API references checked 2026-10-04:
- https://wealthica.com/docs/api/
- https://github.com/wealthica/wealthica.js

No build or server is needed. GitHub Pages serves generic static files; account data stays in Wealthica. New payments still require manual entry (bank CSV import is not implemented in this version).
