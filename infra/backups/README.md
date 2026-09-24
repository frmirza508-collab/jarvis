# Backups
License data lives in PostgreSQL. Minimum policy:
- Nightly `pg_dump --format=custom "$DATABASE_URL" > jarvis-$(date +%F).dump`, encrypted, stored off-site, 30-day retention.
- Test restores monthly: `pg_restore --clean --if-exists -d "$RESTORE_URL" jarvis-YYYY-MM-DD.dump`.
- The `audit_events`, `payments` and `webhook_events` tables are append-mostly; keep them for your statutory retention period.
Desktop user data (`%APPDATA%\JARVIS`) is local to each user; recommend Windows File History/OneDrive backup of `Documents\JARVIS`.
