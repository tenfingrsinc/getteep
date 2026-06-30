# Chrome Web Store Disclosure Guide

Last reviewed: 2026-06-14

Use this document when completing the Chrome Web Store listing and Privacy Practices questionnaire. Recheck every answer against the release artifact before submission.

## Product description

Teep is a beta browser extension that adds creator-tipping controls to supported posts on X. The current release runs on Arc testnet and uses test funds with no real-world monetary value.

## Single purpose

Enable a signed-in user to identify a creator on a supported X post, choose an amount, submit a testnet tip, and view related Teep account activity.

## Data categories

- Personally identifiable information: email address, X handle, connected wallet addresses, and creator profile information.
- Financial and payment information: testnet balances, tip amounts, transaction hashes, withdrawals, referrals, and receipts. The current release does not process real card or bank payments.
- Authentication information: authentication and provider-session state managed through Privy and stored as required to keep the user signed in.
- Website content: the current supported X post URL, post identifier, creator handle, and visible context needed to attach Teep controls and prepare the requested tip.
- User activity: interactions with Teep controls, transaction state, preferences, errors, and security events.
- Web history: not collected. The extension is limited to supported X and Twitter pages and does not build a browsing-history profile.
- Personal communications, health information, and precise location: not collected for Teep functionality.

## Uses

Collected data is used for product functionality, authentication, wallet and transaction operations, duplicate and fraud prevention, receipts and activity history, troubleshooting, support, and legal compliance.

Teep does not:

- sell user data;
- use user data for advertising;
- use user data for creditworthiness or lending decisions;
- transfer user data for purposes unrelated to Teep's single purpose.

## Service providers

- Privy: authentication and embedded-wallet services.
- Configured Arc smart-wallet, bundler, and paymaster infrastructure.
- Arc RPC and blockchain-indexing infrastructure.
- X: supported-page context and creator verification.
- Circle testnet faucet: only when the user chooses to request test funds.

## Required listing links

- Privacy policy: `https://getteep.xyz/privacy`
- Terms: `https://getteep.xyz/terms`
- Support: `https://getteep.xyz/support`
- Account deletion: `https://getteep.xyz/support#account-deletion`

Confirm the final production domain before submission.

## Reviewer notes

- State prominently that the release is a testnet beta.
- State that test funds have no real-world value.
- Do not describe testnet balances as earnings, cash, or withdrawable bank funds.
- Explain that access to X pages is used only to identify the current post and creator and to display Teep controls.
- Keep the questionnaire, manifest description, screenshots, first-run notice, privacy policy, and store copy consistent.
