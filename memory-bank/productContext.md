# [MEMORY BANK: ACTIVE] productContext - Markov Discord

Date: 2025-09-25

Project: Markov Discord — lightweight Markov-chain based Discord responder

Summary:
- This project builds and serves Markov chains derived from Discord message data to generate bot responses with low latency and high throughput.

Problem statement:
- Current response generation and training paths can be CPU- and I/O-bound, causing high latency and slow bulk imports.

Goals & success metrics:
- End-to-end response latency: target < 500ms (95th percentile).
- Training throughput: target 1,000,000 messages/hour on dev hardware.
- Memory during training: keep max heap < 2GB on 16GB host.

Primary users:
- Bot maintainers and operators who run training and rollouts.
- End-users in Discord guilds who interact with the bot.

Key usage scenarios:
- Real-time response generation for user messages in active channels.
- Bulk training/imports from historical message archives.
- Canary rollouts to validate performance before global enablement.

Constraints & assumptions:
- Runs primarily on single-node hosts with 16GB RAM (dev).
- Uses SQLite as primary storage unless replaced per optimization plan.
- Backwards compatibility required for serialization across releases.

Dependencies & related docs:
- [`memory-bank/optimization-plan.md`](memory-bank/optimization-plan.md:1)
- [`memory-bank/performance-analysis.md`](memory-bank/performance-analysis.md:1)
- [`memory-bank/activeContext.md`](memory-bank/activeContext.md:1)

Implementation priorities (short):
- Persist precomputed chains, alias sampling, worker threads, LRU cache.
- See detailed tasks in the optimization plan linked above.

Operational notes:
- Feature flags and toggles live in [`config/config.json`](config/config.json:1).
- Instrument metrics (latency histograms, cache hit ratio, DB durations).

Stakeholders & owners:
- Owner: repository maintainer (designate as needed).

Open questions:
- Confirm canary guild and traffic profile for 24h test.

Next actions:
- Create `src/markov-store.ts`, `src/workers/markov-worker.ts`, bench scripts, and update config toggles (see [`memory-bank/optimization-plan.md`](memory-bank/optimization-plan.md:1)).

End.