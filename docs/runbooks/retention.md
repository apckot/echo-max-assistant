# Technical retention

Scheduler runs a bounded batch once per minute. `RetentionService.run(100)` deletes up to100 closed dead rows in each queue and journals for up to100 terminal outbound messages (at most12 phases per message). Counts contain no identifiers or content. Concurrent cleanup uses SKIP LOCKED; restore fence blocks cleanup.

Dead work remains until an operator closes its incident with `SELECT public.close_technical_incident('conversation'|'delivery', internal_uuid)` using the scheduler role. Cleanup eligibility begins strictly after30 days from closure. Reopening work clears closure. Closing is idempotent and does not authorize removal of user content.

All phases of delivery attempts are removed together, strictly after90 days from the latest phase, only for terminal outbound with no runnable delivery work. Active and uncertain-in-flight attempts remain for certainty recovery. Direct runtime DELETE and UPDATE of attempts remain prohibited.

Inbound events, receipts and outbound payloads remain for active or stopped accounts. Stopping a bot is not privacy erasure. Application log rotation (30days), backup rotation (35days) and future media lifecycle belong to deployment/provider tooling, not this PostgreSQL job. Backup tooling is deferred to iterations31–32.
