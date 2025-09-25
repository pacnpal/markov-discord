# [MEMORY BANK: ACTIVE] Optimization Plan - Further Performance Work

Date: 2025-09-25
Purpose: Reduce response latency and improve training throughput beyond existing optimizations.
Context: builds on [`memory-bank/performance-analysis.md`](memory-bank/performance-analysis.md:1) and implemented changes in [`src/train.ts`](src/train.ts:1) and [`src/index.ts`](src/index.ts:1).

Goals:
- Target: end-to-end response generation < 500ms for typical queries.
- Training throughput: process 1M messages/hour on dev hardware.
- Memory: keep max heap < 2GB during training on 16GB host.

Measurement & Profiling (first actions)
1. Capture baseline metrics:
   - Run workload A (100k messages) and record CPU, memory, latency histograms.
   - Tools: Node clinic/Flame, --prof, and pprof.
2. Add short-term tracing: export traces for top code paths in [`src/index.ts`](src/index.ts:1) and [`src/train.ts`](src/train.ts:1).
3. Create benchmark scripts: `bench/trace.sh` and `bench/load_test.ts` (synthetic).

High Priority (implement immediately)
1. Persist precomputed Markov chains per channel/guild:
   - Add a serialized chain store: `src/markov-store.ts` (new).
   - On training, update chain incrementally instead of rebuilding.
   - Benefit: response generation becomes O(1) for chain lookup.
2. Use optimized sampling structures (Alias method):
   - Replace repeated weighted selection with alias tables built per prefix.
   - File changes: [`src/index.ts`](src/index.ts:1), [`src/markov-store.ts`](src/markov-store.ts:1).
3. Offload CPU-bound work to Worker Threads:
   - Move chain-building and heavy sampling into Node `worker_threads`.
   - Add a worker pool (4 threads default) with backpressure.
   - Files: [`src/train.ts`](src/train.ts:1), [`src/workers/markov-worker.ts`](src/workers/markov-worker.ts:1).
4. Use in-memory LRU cache for active chains:
   - Keep hot channels' chains in RAM; evict least-recently-used.
   - Implement TTL and memory cap.

Medium Priority
1. Optimize SQLite for runtime:
   - Use WAL mode and PRAGMA journal_mode = WAL; set synchronous = NORMAL.
   - Use prepared statements and transactions for bulk writes.
   - Temporarily disable non-essential indexes during major bulk imports.
   - File: [`src/migration/1704067200000-AddPerformanceIndexes.ts`](src/migration/1704067200000-AddPerformanceIndexes.ts:1).
2. Move heavy random-access data into a K/V store:
   - Consider LevelDB/LMDB or RocksDB for prefix->suffix lists for faster reads.
3. Incremental training API:
   - Add an HTTP or IPC to submit new messages and update chain incrementally.

Low Priority / Long term
1. Reimplement core hot loops in Rust via Neon or FFI for max throughput.
2. Shard storage by guild and run independent workers per shard.
3. Replace SQLite with a server DB (Postgres) only if concurrency demands it.

Implementation steps (concrete)
1. Add profiling scripts + run baseline (1-2 days).
2. Implement `src/markov-store.ts` with serialization and alias table builder (1-2 days).
3. Wire worker pool and move chain building into workers (1-2 days).
4. Add LRU cache around store and integrate with response path (0.5-1 day).
5. Apply SQLite runtime tuning and test bulk import patterns (0.5 day).
6. Add metrics & dashboards (Prometheus + Grafana or simple histograms) (1 day).
7. Run load tests and iterate on bottlenecks (1-3 days).

Benchmarks to run
- Baseline: 100k messages, measure 95th percentile response latency.
- After chain-store: expect >5x faster generation.
- After workers + alias: expect ~10x faster generation in CPU-heavy scenarios.

Rollout & Validation
- Feature-flag new chain-store and worker pool behind config toggles in [`config/config.json`](config/config.json:1).
- Canary rollout to single guild for 24h with load test traffic.
- Compare metrics and only enable globally after verifying thresholds.

Observability & Metrics
- Instrument: response latency histogram, chain-build time, cache hit ratio, DB query durations.
- Log slow queries > 50ms with context.
- Add alerts for cache thrashing and worker queue saturation.

Risks & Mitigations
- Serialization format changes: include versioning and migration utilities.
- Worker crashes: add supervisor and restart/backoff.
- Memory blowup from caching: enforce strict memory caps and stats.

Next actions for Code mode
- Create `src/markov-store.ts`, `src/workers/markov-worker.ts`, add bench scripts, and update `config/config.json` toggles.
- I will implement the highest-priority changes in Code mode when you approve.

End.