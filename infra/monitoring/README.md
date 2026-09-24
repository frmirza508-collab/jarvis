# Monitoring

- Health: `GET /health` on the license API (checks the database). Wire it to your uptime monitor.
- Alert on: 5xx rate, `webhook.failed` / `webhook.rejected` audit events, spikes of `license.activate_failed`, subscription reconciler errors in logs.
- Useful queries: `SELECT status, count(*) FROM subscriptions GROUP BY 1;` · `SELECT * FROM webhook_events WHERE status='failed' ORDER BY received_at DESC;`
