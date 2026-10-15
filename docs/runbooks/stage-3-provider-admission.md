# Stage3 provider admission

OpenAI is the only implemented provider in Stage3. Other adapters and local-model qualification are future work, not launch requirements. Text payload must pass Privacy Gateway; unavailable/denied routes refuse safely. Local deterministic checks do not guarantee detection of all personal or sensitive data. Audio requires separate explicit policy/consent before sending the recording itself; early probe excludes audio.

Synthetic probe53: fixed12 regressions,≤12dispatches,≤USD2 aggregate,≤12000input/2000output tokens/request, no retries/model switches. Freeze model/prompt/schema/cases/pricing and worst-case cost before calls. Read existing project secrets file in memory only; no credential value in commands/logs/reports/Git, no new key. Missing key/profile/price evidence blocks dispatch. Reuse is explicitly owner authorised.

Runtime remains default-off. Synthetic feasibility is not production approval or final quality evidence. Final independent H control and audio permission/evidence remain separate Stage3 acceptance requirements.
