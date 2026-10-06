# Checkpoint35 cumulative independent review

2026-10-06 retention correction: the same cumulative reviewer performed only the user-authorized scoped rereview of the retention service/store and scheduler clock-skew regression. **No findings.** PostgreSQL time is selected inside the same SQL operation; fixed-clock injection, explicit cutoffs and the SQL future guard remain intact. Supplied evidence: related 6/6 tests, typecheck and architecture guard passed. Controlled +60s skew is confirmed; exact historical gate clock values remain unknown. Reviewer ran no tests, gates, scans, edits or agents. No new audit of the block was performed.

One authorized read-only reviewer inspected55977f317458cdd282bd522648d05c56dc410ac1..ec64bbe50c90c39c68a115adba9dc70bb7dfba0f. It reused supplied targeted logs/reports, inspected source and performed two filename rejection probes. No edits, delegated agents, full gates or load/functional-suite reruns.

| Finding | Priority | Same-executor correction | Evidence |
|---|---|---|---|
|Post-base archived WAL recovery/RPO not proven|P1|Authenticated archived-WAL staging, explicit named recovery target/promotion; acknowledged post-base marker restoration; RPO based on source/recovered marker; reject cutoff older than restored data|physical drill GREEN; obsolete cutoff RED→GREEN in Review Focus|
|Archive success before durable encrypted publish|P1|fsync complete encrypted file before rename, fsync parent afterward; existing-file retry comparison/resync; manifest and backup-directory publication synced|backup4 + physical1 GREEN; static inspection|
|.history/.backup filenames rejected|P2|Allow PostgreSQL segment/timeline/backup names; traversal rejection and retry identity test|archive names RED→GREEN|
|Review Focus excludes unready-head regression|P2|Reuse ordered-head.test.ts in cumulative config|six suites40/40 + typecheck/architecture PASS|

Five mandatory risks: duplicate text/callback covered; unready-head/terminal continuation covered after selector fix; stale worker generation covered; processing-commit durability/uncertain timeout covered; snapshot old-outbound quarantine covered and extended through actual archived WAL recovery.

Scoped confirmation uses the same reviewer and only these corrections/affected boundaries. Confirmation result will be appended after it returns. Real MAX canary, deployed storage geography/continuous WAL and monthly monitoring remain explicitly disclosed deployment blockers, not local review findings or success claims.

One intermediate focused run had39/40 with an existing ingress503 at restart; affected case subsequently1/1 and final selected suite40/40 passed. The executor improved failure diagnostics only, did not add HTTP retries or expand production DB deadlines. Evidence is preserved; the single full gate has not yet run.

Scoped confirmation returned: all four findings ADDRESSED in03fb24b461472e5d925e545ac2046509502ee742; no remaining correctness issue in affected areas. Reviewer reused supplied evidence and ran no tests/gates/scans. Physical archived-WAL marker RPO0ms/RTO12043ms; final Review Focus40/40 plus static checks. Later smoke-artifact preparation is test setup only: it explicitly builds the CLI before local process smoke because npm verify tests precede its final build; targeted smoke4PASS/1image-onlySKIP and static checks pass. No additional reviewer was launched.


Full-gate symlink-entrypoint repair1300def was also scoped-confirmed by the same reviewer: canonical argv, fail-closed artifact existence and real symlink regressions, recorded9/9 plus staticPASS. No new reviewer/tests/gates were launched by it. Subsequent same-clone physical drill waited for actual target promotion in test-only e351079; that one affected test and static checks passed. Cumulative review does not replace the failed full gate or real canary; checkpoint remains blocked.
