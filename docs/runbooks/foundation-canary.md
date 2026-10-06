# Dedicated TEST MAX canary — prepared, not executed

Run `node ops/canary/preflight.mjs` first. Missing configuration returns exit2 and only variable names; it performs no network request. Required: dedicated TEST bot `MAX_BOT_TOKEN`, `MAX_WEBHOOK_SECRET`, `MAX_WEBHOOK_SECRET_VERSION`, reachable HTTPS `MAX_WEBHOOK_URL`, an explicitly safe test participant `MAX_CANARY_TEST_USER_ID`, and `MAX_CANARY_TEST_CONFIRMED=true`. Provision secrets locally in mode0600 env files/secret manager, never paste them into a report or commit. The test participant must own that account and authorize receiving test replies. Do not use production credentials or guess recipients. Environment currently has no token, receiver or endpoint; no bot creation or external deployment was performed.

Once provisioned, start isolated PostgreSQL17 with migrations/role credentials, the four Stage1 commands, private ops token, explicit production foundation echo opt-in and both restore fences off. Deploy the prepared nginx/TLS config to an approved test endpoint; verify readiness before subscription. Dedicated test bot owns its subscription set: scheduler may remove stale URLs, so this must not share production bot ownership.

Record only anonymous outcomes, elapsed times, code SHA and case labels:

1. Subscription: scheduler check shows healthy secret version/update types; verify provider subscription with the private token. Do not retain raw provider DTOs.
2. Real inbound: safe participant sends a short test text in MAX. Assert one inbound sequence, one receipt, one outbox and one confirmed provider reply within the observed bound.
3. Replay exact private webhook body through signed route; erase the private capture afterward. Counts/event IDs/sequence remain unchanged and no second provider reply occurs. Repeat for a real callback if a test button exists.
4. Stop/start the test bot as the participant: old pending replies are cancelled; a fresh post-start event is eligible. Subscription remains healthy.
5. Restart worker after processing commit but before delivery. Confirm durable outbox produces exactly one reply. Do not interrupt an admitted delivery and then blindly replay it; uncertain completion must remain terminal.
6. Real voice from safe participant: persist `capability_unavailable`, send the Stage1 explanation, never claim transcription.
7. Shut down test roles, remove test subscription only for this dedicated bot, erase test account and private webhook captures. Retain anonymous results only.

A local FakeMAX suite proves the code boundaries, but cannot substitute for this real-provider canary. Missing credentials/recipient/TLS deployment blocks Stage1 acceptance and publication as a successful checkpoint. Stop on this prepared checklist until the user provisions the test setup; do not create a bot or server automatically.
