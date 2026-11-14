# Billing service rules

- Every timestamp this service stores or returns is a UTC ISO-8601 string
  made by `nowIso()` from `lib/time.js`. Never store epoch numbers or call
  `Date.now()` / `new Date()` directly in `services/billing/src/`: the
  ledger export and the reconciliation job parse these fields as ISO strings.
