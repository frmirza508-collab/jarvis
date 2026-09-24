# Licensing & Subscriptions Guide

## Plans
| Code | Price | Period |
|---|---|---|
| `monthly` | PKR 4,000 | 1 calendar month |
| `yearly` | PKR 40,000 | 1 calendar year |

Prices live in the `plans` table (editable in Admin → Plans; changes apply to new payments and are audited).

## Flow
```
Customer pays ─► provider webhook (verified) or admin "Record payment"
            ─► subscription created/extended (server time)
            ─► license key issued (JRV-XXXXX-XXXXX-XXXXX-XXXXX, stored as SHA-256 hash)
Desktop: Account ► Activate key ─► POST /v1/licenses/activate {key, fingerprint, nonce}
            ─► server registers device (limit enforced) ─► Ed25519-signed entitlement token
            ─► desktop verifies signature, device, nonce ─► caches token (encrypted)
Every 6 h (and at start): POST /v1/licenses/validate ─► fresh token
```

## Subscription states
`active`, `past_due` (after period end, within grace), `canceled` (keeps access to period end if configured), `expired`, `suspended` (admin). A reconciler runs every minute on the server.

## Entitlement policy (Admin → Settings)
- **Grace hours** (default **0**): with 0, access ends exactly at period end.
- **Canceled keeps access until period end** (default on).
- **Default device limit** (default 2 per license).
- **Offline token validity** (default 72 h): how long the desktop may run without reaching the server.

## What happens on expiry
Premium execution (task orchestration, agent creation) is blocked with a clear message and a link to Account. The app still opens; settings, memory, history and the user's files remain intact. Paying again reactivates immediately on the next check (or "Check now").

## Anti-tamper
- Server signs with Ed25519 (private key only on the server). The desktop embeds the public key at build time; release builds ignore environment overrides.
- Tokens include server time; the desktop keeps a trusted-time anchor and a monotonic offline counter, so setting the clock back or freezing it cannot extend access.
- Each online check uses a fresh nonce echoed in the signed token (replay protection).
- Definitive server rejections (revoked, deactivated device, invalid key) clear the cached token immediately; network outages do not.

## Admin operations
Customers (create/disable), subscriptions (suspend, reactivate, extend N days, cancel), licenses (issue, revoke, reactivate, rotate key, device limit), devices (deactivate), payments (record manual payment, view webhook deliveries), audit log search, plans, settings.

## Payment providers
- **Manual bank transfer** — always available. Customer receives instructions + reference at checkout; admin records the payment.
- **Stripe** — set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; optional `STRIPE_PRICE_MONTHLY/YEARLY` for auto-renewing subscriptions. Webhook URL: `https://<api>/v1/webhooks/stripe`, events: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`. **Verify PKR availability for your Stripe account/country first.**
- **Signed gateway bridge** — for Pakistani gateways (JazzCash, Easypaisa, PayFast, bank IPGs, …). Build a small bridge that verifies the gateway's callback using the gateway's official documentation, then POSTs normalised events to `/v1/webhooks/gateway` signed with `GATEWAY_WEBHOOK_SECRET`:
  ```
  X-Jarvis-Timestamp: <unix seconds>
  X-Jarvis-Signature: sha256=<hex HMAC_SHA256(secret, "<timestamp>.<raw body>")>
  [{"providerEventId":"txn-123","type":"payment.succeeded","customerRef":"<user uuid>","planCode":"monthly","amount":4000,"currency":"PKR","occurredAt":"2026-09-24T10:00:00Z"}]
  ```

## Deployment
1. PostgreSQL 14+; create database and user.
2. `pnpm --filter @jarvis/license-api generate-keys` → store the private key in your secret manager; give the public key to the desktop build.
3. Set env (see `.env.example`), run `pnpm --filter @jarvis/license-api migrate`, then start (`node dist/main.js` or the Docker image in `infra/deployment`).
4. `ADMIN_PASSWORD=... pnpm --filter @jarvis/license-api create-admin admin@example.com "Admin"`.
5. Build the admin portal with `VITE_LICENSE_API_URL` and host it statically.
