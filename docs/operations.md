# Operations

Monitor Worker request metrics and D1 errors through Workers Logs. Metrics include request ID, route, status, elapsed time, byte count, and aggregate counts; bearer tokens, complete upload JSON, player identifiers, and coordinates are not logged.

The daily retention trigger deletes price history and sold events older than 90 days in bounded chunks. It never deletes current listings. Before extending retention, reassess D1 free read/write/storage quotas and export long-lived data to R2 JSONL/CSV.

A source can be disabled independently. All shop, session, listing, and reconciliation queries include the authenticated source boundary; there is no global close-shop operation.
