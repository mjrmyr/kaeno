# Core only

Kaeno is a small durable conversation host. It does not ship WORK, Telegram, Kubernetes, artifacts, skill repositories, remote execution, or deployment automation.

## The boundary

- **pi-durable:** tasks, documents, transactions, scheduling, tools, execution environments and storage.
- **Threads:** external thread keys map to persistent conversations.
- **Turns:** idempotent input admission, provenance, stop/reset fences, generic activity results, reply cursors and delivery claims.
- **Authority:** assistant tools default to mutating; result turns may invoke only explicitly declared read tools. Mutation handlers must recheck the origin fence inside their actual admission transaction.
- **Application:** explicitly install extensions, open storage, inspect recovery requirements, configure idle conversations, start services and resume.

There is one runtime, no hot loader, no service locator, and no plugin marketplace. Native extensions are trusted process code.

## Extension mechanism

`openKaeno` accepts native pi-durable definitions plus a small set of host integration points:

- `durable`: tools, tasks, documents referenced by tasks, sections, hooks and wrappers using pi-durable directly.
- `readOnlyTools`: assistant tools allowed on result turns. All other tools default to mutating.
- `environment`: a native execution-environment provider. A later Kubernetes extension can supply this together with its own tasks and resource management. Only one provider is selected.
- `delivery`: a named channel adapter for durable replies and optional typing indicators.
- `start(core, signal)`: start a channel listener or reconciliation service and return an asynchronous cleanup function. Signals stop ingress first, then Harness closes to quiesce durable invocations while extension clients remain available. Resource cleanup runs in reverse order afterwards and must not access the closed harness.

Extensions receive the native harness, thread directory and turn coordinator. A channel can commit its external cursor together with `turns.admitUserTurn(tx, ...)`; no transaction facade or second database is necessary. An extension owns any resource documents, provisioning, retries and cleanup its tasks need. The core does not contain Kubernetes policy.

A service's `start` must return after startup, not wait for its long-running loop. It should retain that loop and return a cleanup that joins it after the abort signal. Observe shutdown promptly; cleanup runs after the harness closes, so do not require durable task completion or new database operations to stop the service. If `start` throws before returning cleanup, it must release its own partially acquired resources. Do not enable native task scheduling or accept input before startup compatibility inspection.

## Durability, not compatibility scaffolding

Definitions are fixed until restart. Persisted kinds and versions are contracts; retain compatible handlers, drain, or migrate deliberately. Startup refuses missing/incompatible task definitions or missing saved tool/extension references before normal scheduling. `Harness.open` itself reconciles recovery state and is not read-only.

The core-only cut intentionally removes the previous product and its configuration. **It is not an automatic migration of an old WORK/Telegram database.** Core turn/control definitions are now version 2 without an implicit migration from the removed product payloads. Missing or incompatible old definitions must remain an actionable startup failure, not be silently discarded. Keep the previous release and its data backup for old workloads; use a fresh database for this minimal runtime.

Stop/reset fence old input before it can mutate state. A stop durably requests cancellation of background activities; their native abort handlers own cleanup. Reset preserves independently running activities but does not inject old results into fresh context. Suppression precedes cancellation. Results are data authority, not user authority.

Task admission and effect authorization belong in one native commit. External effects do not: use provider idempotency when available and expose uncertain outcomes rather than blindly retrying unsafe actions. A claimed reply may complete after reset and may duplicate on recovery. Closing Kaeno does not mean cancelling durable background tasks.

Before upgrading, stop ingress, join services, close storage and take a consistent SQLite backup plus referenced extension files. Do not blindly copy a live SQLite file; WAL and active writers matter. Restoring old code alone is not rollback after incompatible state changes, and restoring a backup cannot undo external effects.

## Adding capabilities later

Write one ordinary native extension, supply its tools/tasks and optional environment/delivery/service hooks, and pass it to `openKaeno`. Keep extension-owned state and cleanup with that extension. No core edit is needed to register these capabilities. Integration tests exercise this public mechanism without implementing a real cluster or chat service.

Kaeno can author extensions in a branch. Accepting native code into the running process is an owner-controlled release decision, whether manual or automated. Generated code and passing tests do not create isolation. A separately restricted executor may be added if a real use case requires running code the owner explicitly distrusts.
