# Railway Deployment

Teep is prepared for Railway as two services:

1. A full-stack web/API service from the repository root.
2. An X agent worker service from `x-agent/`.

The web/API service builds the backend and the Vite web app, runs compiled
database migrations, then starts the backend. The backend serves API routes and
the built `web/dist` shell, including crawler-visible public profile metadata.

The X agent service is a long-running worker. It listens for X commands, sends
eligible posts to the backend, and posts replies from the bot account.

## Web/API Railway Service

Create the main Railway service from this repository and keep the root directory
as the repository root.

Railway reads `railway.json`:

- Build command: `npm run railway:build`
- Pre-deploy command: `npm run backend:db:migrate:prod`
- Start command: `npm run start --workspace=backend`
- Health check: `/health/live`

Use `/health/live` for platform liveness. `/health` and `/health/ready` can
report degraded while the indexer catches up and should not be used as the
Railway restart trigger.

## Required Variables

Set these in Railway before the first production deploy.

Backend:

```env
NODE_ENV=production
TRUST_PROXY=true
PORT=3001
DATABASE_URL=${{Postgres.DATABASE_URL}}
CORS_ORIGIN=https://YOUR_RAILWAY_OR_CUSTOM_DOMAIN
WEB_APP_URL=https://YOUR_RAILWAY_OR_CUSTOM_DOMAIN
RECEIPT_BASE_URL=https://YOUR_RAILWAY_OR_CUSTOM_DOMAIN
WEB_DIST_DIR=web/dist
RPC_URL=https://rpc.testnet.arc.network
ARC_RPC_URL=https://rpc.testnet.arc.network
CHAIN=arcTestnet
CHAIN_ID=5042002
USDC_ADDRESS=0x3600000000000000000000000000000000000000
TIP_CONTRACT_ADDRESS=0xFAF11e9b2242927E996f0ff6a0239Da2B742893C
FACTORY_ADDRESS=0x7acd5485C975649626bF379710f57021C097115b
INDEXER_START_BLOCK=0
ATTESTATION_PRIVATE_KEY=...
PROTOCOL_TREASURY_ADDRESS=...
OPS_TOKEN=...
X_CLIENT_ID=...
X_CLIENT_SECRET=...
X_BEARER_TOKEN=...
X_REDIRECT_URI=https://YOUR_RAILWAY_OR_CUSTOM_DOMAIN/auth/x/callback
X_AGENT_TOKEN=...
X_BOT_USERNAME=teepagent
PRIVY_APP_ID=...
PRIVY_APP_SECRET=...
WITHDRAWAL_EMAIL_WEBHOOK_URL=...
```

Web build variables:

```env
VITE_API_URL=https://YOUR_RAILWAY_OR_CUSTOM_DOMAIN
VITE_WEB_APP_URL=https://YOUR_RAILWAY_OR_CUSTOM_DOMAIN
VITE_RECEIPT_BASE_URL=https://YOUR_RAILWAY_OR_CUSTOM_DOMAIN
VITE_CHROME_STORE_URL=https://chromewebstore.google.com/detail/teep/REAL_EXTENSION_ID
VITE_PRIVY_APP_ID=...
VITE_USDC_ADDRESS=0x3600000000000000000000000000000000000000
VITE_FACTORY_ADDRESS=0xB53E8919627BcE6845eEee399E27A023D23C0dD4
VITE_TIP_CONTRACT_ADDRESS=0xc4b18D3FB3aE76b37B6dfd69E5037c5865A47886
VITE_REFERRAL_REGISTRY_ADDRESS=0x967A2Bb3Ba05D1c0F3071C2c94C02950966c3655
VITE_FUNDING_ENV=arcTestnet
VITE_FAUCET_URL=https://faucet.circle.com
VITE_ENABLE_FIAT_ONRAMP=false
VITE_ENABLE_FIAT_OFFRAMP=false
VITE_TWITTER_URL=https://x.com/teepxyz
```

Keep these production safety flags unset or false:

```env
ENABLE_FAUCET=false
ALLOW_CLIENT_ACTIVITY_WRITES=false
ALLOW_INSECURE_RPC_TLS=false
ALLOW_INSECURE_AVATAR_TLS=false
ALLOW_INSECURE_OEMBED_TLS=false
ALLOW_UNSIGNED_REFERRAL_WRITES=false
ALLOW_UNSIGNED_ATTESTATION=false
ENABLE_DEFI_TRANSACTIONS=false
```

## Provider Callback URLs

After Railway gives the service a domain, update providers to use that exact
domain.

X OAuth:

```text
https://YOUR_RAILWAY_OR_CUSTOM_DOMAIN/auth/x/callback
```

Privy:

```text
https://YOUR_RAILWAY_OR_CUSTOM_DOMAIN
```

If a custom domain is added later, update `CORS_ORIGIN`, `WEB_APP_URL`,
`RECEIPT_BASE_URL`, `VITE_API_URL`, `VITE_WEB_APP_URL`,
`VITE_RECEIPT_BASE_URL`, and `X_REDIRECT_URI` together.

## Post-Deploy Checks

Run these checks after the first deploy:

1. Open `/health/live` and confirm `{"status":"ok"}`.
2. Open `/health` and confirm the database responds. It may be `degraded`
   while indexing catches up.
3. Open `/` and confirm the landing page loads from the backend-served
   `web/dist`.
4. Open `/creator/pipsandbills`, `/tx/<knownTxHash>`, and `/ops`.
5. Start an X OAuth connection and verify the callback returns to the same
   Railway/custom domain.
6. Confirm the X bot internal route is not public-facing without its token.

## Notes

- Do not split web and backend into two Railway services unless you also update
  every web build URL, CORS origin, receipt URL, and OAuth callback.
- Do not use `vite preview` for production. The backend serves the built web app.
- The Railway pre-deploy migration uses compiled JavaScript, so deployment does
  not depend on `ts-node`.

## X Agent Railway Service

Create a second Railway service from the same repository and set its root
directory to:

```text
x-agent
```

Railway reads `x-agent/railway.json`:

- Build command: `npm run build`
- Start command: `npm run start`
- No HTTP health check. This is a worker, not a web server.

Set these variables on the X agent service:

```env
NODE_ENV=production
TEEP_BACKEND_URL=https://YOUR_RAILWAY_OR_CUSTOM_DOMAIN
X_AGENT_TOKEN=...
X_BOT_USER_ID=...
X_BOT_USERNAME=teepagent
X_BEARER_TOKEN=...
X_BOT_ACCESS_TOKEN=...
X_POLL_INTERVAL_MS=45000
X_MENTIONS_PAGE_SIZE=20
X_USE_FILTERED_STREAM=false
```

`X_AGENT_TOKEN` must be the same value on both services:

- Backend service: `X_AGENT_TOKEN=...`
- X agent service: `X_AGENT_TOKEN=...`

Only the X agent service should receive `X_BOT_ACCESS_TOKEN`. Do not put the
bot posting token in the web app or extension environments.

For beta, start with polling:

```env
X_USE_FILTERED_STREAM=false
```

Only switch to filtered stream mode after the X API access tier and stream
limits are confirmed for the bot account.
