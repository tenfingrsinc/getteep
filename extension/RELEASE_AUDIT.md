# Teep Chrome Extension Release Audit

Audit date: 2026-06-13

Status: **Not ready for Chrome Web Store submission**

Scope: extension security, transaction safety, privacy, permissions, UX/accessibility, build/release operations, and store submission readiness.

## Release Blockers

### EXT-SEC-001 - Diagnostic wallet tools ship in the production bundle

- Severity: High
- Resolution: **Fixed in source on 2026-06-13; production artifact verification passed.**
- Locations:
  - `extension/webpack.config.js:72-78`
  - `extension/public/wallet-lab.html`
  - `extension/public/wallet-lab-sign.html`
  - `extension/src/background/index.ts:145-157`
- Evidence: Webpack always builds `wallet-lab` and `wallet-lab-sign`, and the public directory is copied wholesale. These pages expose message signing, transaction sending, smart-wallet diagnostics, and a separate `TIP_REQUEST_LAB` path.
- Impact: Store users receive privileged development surfaces that are not part of Teep's single public purpose. They increase the transaction attack surface, bundle size, review risk, and chance of accidental use.
- Required fix:
  - Exclude wallet-lab entries, HTML files, and `TIP_REQUEST_LAB` from production builds.
  - Keep them behind an explicit development-only build flag.
  - Add a release assertion that rejects any output containing `wallet-lab` or `TIP_REQUEST_LAB`.

### EXT-SEC-002 - Duplicate transaction protection is not durable

- Severity: High
- Resolution: **Fixed in source on 2026-06-14; typecheck and production build passed.**
- Locations:
  - `extension/src/background/index.ts:79-103`
  - `extension/src/background/index.ts:292-301`
  - `extension/src/background/index.ts:399-418`
- Evidence: Active tip requests are tracked only in an in-memory `Map`, with a two-minute TTL. Manifest V3 service workers can be suspended and restarted at any time, which clears this map.
- Impact: Repeated clicks, a slow approval, extension worker suspension, or reopening the signer can create multiple transaction requests for the same post and amount.
- Required fix:
  - Persist an idempotency record in `chrome.storage.session` or `chrome.storage.local`.
  - Give each intent a stable request ID and atomic state: `created`, `signing`, `submitted`, `confirmed`, `failed`, or `cancelled`.
  - Have the backend and/or contract-facing submission path reject duplicate intent IDs where practical.
  - Do not expire a submitted request merely because two minutes elapsed.

### EXT-SEC-003 - The signer trusts mutable stored transaction calldata

- Severity: High
- Resolution: **Fixed in source on 2026-06-14; strict typecheck and production artifact verification passed.**
- Locations:
  - `extension/src/background/index.ts`
  - `extension/src/popup/SignTipApp.tsx`
  - `extension/src/utils/tipIntent.ts`
  - `extension/src/content/TipButton.tsx`
- Evidence: The signer reads `approveData.to/data` and `tipData.to/data` from extension storage and sends them without decoding or verifying the destinations and arguments.
- Impact: A compromised extension page, accidental diagnostic path, dependency issue, or future messaging bug could replace the transaction destination or approval spender before signing.
- Required fix:
  - Verify `approveData.to === CONFIG.USDC_ADDRESS`.
  - Decode approval calldata and verify spender, amount, and selector.
  - Verify `tipData.to === CONFIG.TIP_CONTRACT_ADDRESS`.
  - Decode tip calldata and verify content ID, creator ID, and amount against the displayed intent.
  - Reject stale, malformed, or already-consumed request IDs.
- Implemented controls:
  - Restrict `chrome.storage.local` to trusted extension contexts and relay transaction results to content scripts through the background worker.
  - Require the durable intent to be in the `signing` state with the matching attempt ID, account, and configured chain.
  - Verify selectors and decode both calls with the canonical ABIs.
  - Require exact approval spender/amount and exact tip content ID/creator ID/amount.
  - Re-encode calls from the durable intent and submit those verified calls instead of forwarding stored calldata.

### EXT-OPS-001 - No reproducible, clean production artifact

- Severity: High
- Resolution: **Fixed in source on 2026-06-15. Final artifact verification remains intentionally blocked until production URLs are supplied and EXT-OPS-002 icons are added.**
- Locations:
  - `extension/webpack.config.js:67-163`
  - `extension/package.json:5-12`
  - `extension/dist/`
- Evidence:
  - A production build with release-like URLs did not complete within three minutes.
  - The existing `dist` is stale development output containing localhost permissions, source maps, and wallet-lab files.
  - The production compiler uses `transpileOnly: true`.
  - There is no release script that performs type-check, clean build, artifact inspection, and ZIP creation.
- Impact: The wrong artifact could be uploaded, including development permissions, source maps, internal tools, or stale code.
- Required fix:
  - Add `typecheck`, `build:release`, `verify:release`, and `package:release` scripts.
  - Build into a fresh temporary directory, never reuse `dist`.
  - Fail when source maps, localhost strings, debug flags, wallet-lab files, or unexpected hosts are present.
  - Produce a deterministic ZIP with `manifest.json` at its root.
- Implemented controls:
  - `npm run release --workspace=extension` now runs strict typechecking, encoding and dependency gates, an isolated production build, artifact verification, and deterministic ZIP packaging.
  - Release output is built only in `extension/release/build`; the local development `dist` directory is never reused.
  - The release build ignores the local `.env`, requires explicit production API/web/Privy values, and rejects local URLs.
  - Verification rejects missing required assets, source maps, local URLs, diagnostic pages/markers, private-key material, unexpected permissions, and host permissions that differ from the build context.
  - Packaging writes a stable root-level archive and SHA-256 checksum.

### EXT-OPS-002 - Manifest references icon files absent from the source package

- Severity: High
- Locations:
  - `extension/public/manifest.json:39-42`
  - `extension/public/`
- Evidence: The manifest references `icon16.png`, `icon48.png`, and `icon128.png`, but the current public directory contains only `logo.svg`, manifest/HTML files, and wallet-lab HTML files.
- Impact: A clean build will produce an invalid or visibly broken extension package.
- Required fix: Add and visually verify all referenced PNG icons, including transparent padding and legibility at 16 px.

### EXT-COMPLIANCE-001 - Store claims and privacy disclosures are incomplete for the current beta

- Severity: High
- Resolution: **Fixed in source on 2026-06-14; strict web and extension typechecks passed. The Chrome Web Store questionnaire must still be completed manually at submission using `extension/STORE_DISCLOSURES.md`.**
- Locations:
  - `extension/public/manifest.json:5`
  - `extension/src/popup/App.tsx`
  - `web/src/pages/Privacy.tsx`
  - `web/src/pages/Support.tsx`
  - `web/src/pages/Terms.tsx`
  - `extension/STORE_DISCLOSURES.md`
- Evidence:
  - The manifest says users can “Tip anyone and earn tips on X instantly.”
  - The product currently runs on Arc testnet and uses test funds.
  - The privacy policy does not specifically identify extension browsing access on X, locally stored extension data, Privy, RPC/paymaster providers, or the precise purpose and handling of each data category.
- Impact: Users and Chrome reviewers may interpret the listing as a live-money financial product and may not receive the disclosure required for sensitive financial and authentication data.
- Required fix:
  - State clearly in the listing and first-run experience that this release is beta/testnet and funds have no real-world value, if that remains true at publication.
  - Add extension-specific privacy disclosures and identify service-provider categories.
  - Complete the Chrome Web Store privacy questionnaire consistently with actual collection and use.
  - Publish reachable Privacy, Terms, Support, and account/data-deletion instructions.
- Implemented controls:
  - The manifest and first-run popup identify Teep as an Arc testnet beta using funds with no real-world value.
  - Privacy disclosures now cover supported-page access, account and transaction data, extension storage, provider categories, retention, and public blockchain limits.
  - Terms and Support use matching testnet language and no longer imply current card, bank, or real-money cash-out support.
  - A reachable account-deletion process is published at `/support#account-deletion`.
  - `extension/STORE_DISCLOSURES.md` provides the data-category and single-purpose answers needed for the manual store submission.

## Important Before Submission

### EXT-SEC-004 - Popup is unnecessarily web-accessible

- Status: Resolved on June 14, 2026.
- Severity: Medium
- Location: `extension/public/manifest.json:44-49`
- Evidence: `popup.html` is exposed to all X and Twitter pages through `web_accessible_resources`.
- Impact: It makes a privileged extension page embeddable/reachable from the host page without a demonstrated product need.
- Fix: Remove this declaration unless a concrete content-script flow requires it. If a resource must be exposed, expose only that narrow static resource.
- Verification: `popup.html` is used only as the action popup and an extension-owned signing window. `web_accessible_resources` is absent from the production manifest.

### EXT-SEC-005 - Extension network policy is overly broad

- Status: Resolved on June 14, 2026.
- Severity: Medium
- Location: `extension/webpack.config.js:60-62`
- Evidence: Production CSP permits connections to every HTTPS and WSS origin.
- Impact: Any future injection or compromised dependency has a much wider exfiltration surface.
- Fix: Enumerate Teep API, RPC, Privy, and required wallet infrastructure origins. Document any wildcard that cannot be removed.
- Verification: Production `connect-src` is limited to the Teep API, Arc RPC, Privy, Privy's runtime RPC hosts, and Kernel bundler/paymaster hosts. Provider wildcards remain only where those services allocate tenant-specific subdomains.

### EXT-PERM-001 - `tabs` permission needs removal or written justification

- Status: Resolved on June 14, 2026.
- Severity: Medium
- Locations:
  - `extension/public/manifest.json:6-9`
  - `extension/src/background/index.ts:112-127`
- Evidence: Most tab creation does not require the `tabs` permission. The current likely reason is reading OAuth callback URLs/titles.
- Impact: Broader permission warnings and additional Chrome review scrutiny.
- Fix: Test whether API host permissions plus a narrower callback approach remove the need for `tabs`. Otherwise document the exact user-facing purpose in the store submission.
- Verification: The OAuth callback remains observable through its explicit API host permission, while tab creation, message delivery, and removal do not require the broad `tabs` permission. The packaged manifest now requests only `storage`.

### EXT-TX-001 - Success is shown before explicit receipt confirmation

- Status: Resolved on June 14, 2026.
- Severity: Medium
- Location: `extension/src/popup/SignTipApp.tsx:408-456`
- Evidence: The UI records success and updates local history immediately after `sendTransaction` returns a hash. There is no explicit public-client receipt wait in this path.
- Impact: A submitted but reverted, replaced, or delayed transaction can appear successful and update X/local history prematurely.
- Fix: Confirm the provider's exact return guarantee. If it is submission-only, wait for a successful receipt before showing final success and writing definitive activity.
- Verification: A returned hash moves the durable intent to `submitted`. Final UI success, local activity, metadata, and X updates occur only after a successful receipt. Delayed receipts remain pending and are reconciled later.

### EXT-TX-002 - Custom amount parsing uses floating-point arithmetic

- Status: Resolved on June 14, 2026.
- Severity: Medium
- Locations:
  - `extension/src/content/TipButton.tsx:162-175`
  - `extension/src/content/TipButton.tsx:265-304`
- Evidence: The UI uses `parseFloat` and `Math.floor(amount * 1_000_000)`.
- Impact: Excess decimal places and binary floating-point rounding can produce a value different from what the user expects.
- Fix: Accept a strict decimal format with at most six decimal places and convert with `parseUnits` from the original string. Add a product maximum and clear validation.
- Verification: Tip amounts remain decimal strings until strict six-decimal validation and `parseUnits` conversion. The extension enforces a $0.01 minimum and $10,000 test-USDC maximum.

### EXT-SEC-006 - Runtime messages lack schema and sender validation

- Status: Resolved on June 14, 2026.
- Severity: Medium
- Location: `extension/src/background/index.ts:129-237`
- Evidence: The background worker switches directly on `message.type` and trusts nested payload fields.
- Impact: Malformed internal messages can reach balance, wallet, claim-wallet, and transaction preparation paths.
- Fix: Define typed runtime message schemas, validate payloads at runtime, and restrict transaction messages to expected extension/content-script senders.
- Verification: The background worker separates extension-page and supported-content-script senders, rejects unknown message types, and validates addresses, hashes, request identities, creator handles, amounts, and completion states before dispatch.

### EXT-UX-001 - Injected tip dialog is not keyboard-accessible

- Status: Resolved on June 14, 2026.
- Severity: Medium
- Locations:
  - `extension/src/content/TipButton.tsx:353-454`
  - `extension/src/content/TipButton.tsx:505-520`
- Evidence: The modal lacks `role="dialog"`, `aria-modal`, focus placement/trapping, Escape handling, and restored focus. Interactive controls globally remove outlines without replacement.
- Impact: Keyboard and assistive-technology users can lose context or be unable to operate the flow reliably.
- Fix: Implement standard dialog semantics, focus-visible styles, Escape close, focus trap, and live-region errors.
- Verification: The dialog exposes modal semantics and labels, moves and traps focus, supports Escape, restores focus, provides visible keyboard focus, and announces validation and transaction errors.

### EXT-UX-002 - Currency wording is inconsistent

- Status: Resolved on June 14, 2026.
- Severity: Medium
- Locations:
  - `extension/src/content/TipButton.tsx:442`
  - `extension/src/content/TipButton.tsx:477`
- Evidence: The injected UI calls the asset “USD,” while the transaction uses USDC on Arc testnet.
- Impact: Financial ambiguity and avoidable user confusion.
- Fix: Use plain-language but accurate wording, such as “$5 in test USDC,” or a globally explained “$5 tip” during beta.

- Verification: The injected tipping flow consistently describes the asset as test USDC.

### EXT-OPS-003 - Dependency audit could not complete

- Severity: Medium
- Status: **Release gate implemented on 2026-06-15; machine/CI certificate trust remains unresolved.**
- Evidence: `npm audit --omit=dev --workspace=extension` failed both inside and outside the sandbox because npm TLS certificate verification failed.
- Impact: Known runtime dependency vulnerabilities have not been ruled out.
- Fix: Repair the machine/CI CA trust chain and make a high-severity runtime dependency audit a release gate.
- Current state: `audit:runtime` is now part of the extension release command and cannot be skipped by that pipeline. On this workstation npm still fails with `unable to verify the first certificate`; TLS verification has not been disabled.

### EXT-OPS-004 - Source encoding defects can reach visible UI

- Severity: Low
- Status: **Resolved on June 15, 2026.**
- Locations:
  - `extension/public/popup.html:26`
  - Multiple extension comments and strings
- Evidence: The loading text currently renders as `Loadingâ€¦`; similar mojibake exists elsewhere.
- Impact: Poor first impression and inconsistent text rendering.
- Fix: Normalize source files to UTF-8 and add a release scan for common mojibake sequences.
- Verification: Visible popup text and retained popup source copies were normalized, and `verify:encoding` now scans extension source/public files for common mojibake sequences as a required release gate.

## Positive Findings

- Manifest V3 is used.
- Production builds disable source maps in Webpack configuration.
- TypeScript strict checking currently passes when run separately.
- No private keys or wallet secrets were found in extension source or local storage handling.
- The normal tip path constructs contract calls internally rather than accepting arbitrary transaction calldata from X page content.
- Approvals are generated for the exact tip amount rather than unlimited allowance.
- Production environment guards reject localhost API/web URLs and enabled debug flags.
- User-facing links generally use `noopener noreferrer`.
- The popup includes a testnet notice, although the notice must also appear in store copy and first-run disclosure.

## Required Release Pipeline

1. Run strict TypeScript checking.
2. Run unit tests for amount parsing, message validation, transaction decoding, request state transitions, and duplicate requests.
3. Run integration tests for login, funding, tip approval, tip without approval, cancellation, retry, worker restart, failed/reverted transaction, X verification, and logout.
4. Build from an empty output directory using explicit production environment variables.
5. Inspect the generated manifest and reject unexpected permissions/hosts.
6. Reject source maps, localhost strings, diagnostics, test pages, and secrets.
7. Run dependency and secret scans.
8. Load the unpacked production artifact in a clean Chrome profile and complete the full flow.
9. Create the store ZIP from the verified directory only.
10. Save the artifact hash and release configuration for rollback/reproduction.

## Store Submission Checklist

- [ ] Single-purpose description matches the extension's actual behavior.
- [ ] 16, 48, and 128 px extension icons render correctly.
- [ ] Store screenshots accurately show the current production UI.
- [ ] Privacy policy is public and extension-specific.
- [ ] Support URL and monitored support email are active.
- [ ] Permission and host-permission justifications are written.
- [ ] Testnet/beta status is prominent and unambiguous.
- [ ] Reviewer test instructions and a funded test account/path are prepared.
- [ ] No diagnostic pages or debug features are included.
- [ ] Clean production build, typecheck, tests, and dependency audit pass.
- [ ] Transaction idempotency and calldata validation are implemented and tested.
- [ ] Keyboard navigation and screen-reader dialog behavior are verified.

## Release Recommendation

Do not upload the current `extension/dist` folder. Resolve all High findings, complete a clean release build, and then perform a short second audit against the final ZIP. Medium findings related to transaction correctness, accessibility, permissions, and dependency scanning should also be completed before a public launch.
