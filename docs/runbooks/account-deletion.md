# Account privacy erasure

Use the trusted scheduler capability through `DeleteAccount` with an internal `userId`, a fresh random `operationId`, actor category `operator|self_service`, and closed reason `privacy_request`. Never derive the operation ID from a MAX identifier. Authorization of a user's request happens upstream; no public HTTP deletion route is exposed here.

Call `preview(request)` first: read-only counts, no identity/body export. `apply(request)` commits the durable admission barrier with `begin`, then attempts `finish` in a separate transaction. Begin marks the user deleting, stops accounts/conversations, cancels pending outbound and invalidates unadmitted queue leases. Incoming events for the deleting identity are rejected. Finish deletes journals, queues, payloads, receipts and identity rows in FK order. Ordinary scheduler DELETE is denied. Repeat the same request/operation token for idempotent recovery; never reuse a token for another request.

An already admitted send cannot be recalled. Finish returns `waiting` while any outbound is sending; the normal delivery recovery resolves a crashed attempt to uncertain without resending. Scheduler resumes up to10 pending deletions per5s pass. Live sender certainty can finish after the barrier; no new admission is authorized. Unresolved sending blocks physical erasure until recovered. Database deadlines roll back the physical-delete transaction, preserving the durable deleting barrier for retry; large accounts may require operator investigation.

Completed audit contains only a random operation UUID, closed actor/reason codes, counts and times; user_id is nulled and no external ID, payload, hash or target mapping is retained. A subsequent MAX interaction after completed erasure can create a fresh identity. Permanent suppression would require retaining an external identity tombstone and is outside this privacy contract.

Stage1 has no downloaded media objects. Encrypted backup rotation removes historical data within35days; restore reconciliation and backup tooling are iterations31–32, not claimed by this checkpoint.
