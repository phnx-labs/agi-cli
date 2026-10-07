### Fixed

- `agents projects prs --repo … --number …` no longer fails when the shared
  GraphQL budget is spent. The review verdict is GraphQL-only, so it reads
  null and `ciError` says the review status is unavailable; the head and checks
  still come from REST. Any other error still fails the read.
