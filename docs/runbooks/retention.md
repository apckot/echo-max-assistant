# Technical retention

Scheduler runs a bounded batch once per minute. `RetentionService.run(100)` deletes up to100 closed dead rows in each queue and journals for up to100 terminal outbound messages (at most12 phases per message). Counts contain no identifiers or content. Concurrent cleanup uses SKIP LOCKED; restore fence blocks cleanup.

Dead work remains until an operator closes its incident with `SELECT public.close_technical_incident('conversation'|'delivery', internal_uuid)` using the scheduler role. Cleanup eligibility begins strictly after30 days from closure. Reopening work clears closure. Closing is idempotent and does not authorize removal of user content.

All phases of delivery attempts are removed together, strictly after90 days from the latest phase, only for terminal outbound with no runnable delivery work. Active and uncertain-in-flight attempts remain for certainty recovery. Direct runtime DELETE and UPDATE of attempts remain prohibited.

Inbound events, receipts and outbound payloads remain for active or stopped accounts. Stopping a bot is not privacy erasure. Application log rotation (30days), backup rotation (35days) and future media lifecycle belong to deployment/provider tooling, not this PostgreSQL job. Backup tooling is deferred to iterations31–32.

Queue retirement preserves the last generation in internal parent-scoped metadata. New work restores that floor under a parent lock, so an old lease cannot become valid after recreation. Metadata contains internal IDs only and is cascaded away by account/outbound erasure. Cleanup probes at most100 parent rows per queue before taking work locks; the requested deletion limit remains1–100. Terminal not_sent journals obey the same90day boundary as other terminal certainty states.
