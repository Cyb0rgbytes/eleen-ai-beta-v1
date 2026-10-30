# EleenAI Studio: M0 test results

**Date:** 2026-10-31

What the pre-build tests found, and what each result changes in the plan.

## Results

| Question | Result | Decision |
|---|---|---|
| Does the fal key work? | Yes. One job on `minimax/h3-max-turbo/text-to-video`, 5 s at 480P, completed in 35 s (29 s of inference). Request id `01a18f10-92e4-7473-806c-52767b811462` | Proven against the real API |
| Can fal go through AI Gateway? | Not as set up today. The gateway answered 401 (code 2009) to a request carrying only the fal key, so it requires its own token, which the Worker doesn't hold | Call `queue.fal.run` directly |
| Can a non-session token reach paid routes? | No. `authenticateRequest` defaults to session tokens (`@clerk/backend`), and the repo never sets `acceptsToken` | No extra check needed |
| Does `X-Fal-Webhook-User-Id` match our account? | Not tested. It needs a public webhook URL, so it waits for the first deploy of the webhook route | Check before M3 ships |

## What this changes

- **Spend control:** AI Gateway won't see fal traffic, so its spend limit doesn't apply to it. The limits are the daily reservation in `src/lib/spend.ts` and the prepaid fal balance.
- **Logging:** cost per job has to be recorded in `media_jobs`.
- **Client:** models don't share a schema, so `src/media/fal.ts` must go generic. H3 Max Turbo requires `prompt_expansion_mode`, offers 480P, 768P and 1080P, and defaults to 768P, while plain H3 defaults to 2K.

## Pricing

fal's listed rates can be promotional. H3 Max Turbo per second:

| Period | 480P | 768P | 1080P |
|---|---|---|---|
| To 2026-10-31 | $0.01625 | $0.026 | $0.052 |
| 2026-11-01 to 2026-11-15 | $0.0175 | $0.028 | $0.056 |
| From 2026-11-16 (standard) | $0.025 | $0.04 | $0.08 |

Credits must be set from the standard rate, never a promotional one. Output can run up to about 0.7 s longer than requested, so check whether that time is billed.
