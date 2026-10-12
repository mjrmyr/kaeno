# Feature packages and enforcement

## Decisions

Two shapes were compared locally (no subagent runner was available): keeping one package per old file with
callback factories, or cohesive features with injected consumer-owned contracts. The second shape is used.
There are no compatibility re-export shims at the old implementation paths.

Stateful services are classes with positional dependencies. Substantial function configuration may use a named
object. Consumers declare narrow interfaces beside their implementation; providers satisfy them structurally,
without mandatory `implements`. `application/kaeno.ts` constructs and connects services, task definitions and
SDK adapters. Late startup wiring uses an initialized dependency holder, not definite-assignment assertions.

## Ownership

| Package             | Owns                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `config/`           | External configuration validation and template selection                                           |
| `skills/`           | Catalogue, filesystem artifacts, repository preparation and immutable cache publication            |
| `agents/`           | AgentFactory composition, conversation metadata, authorized delegation, adoption and logging       |
| `work/`             | Admission deduplication, durable work lifecycle, immutable replay blueprint and reporting contract |
| `sandboxes/`        | Durable capacity, Kubernetes adapter, trusted pod specification and sandbox lifecycle              |
| `execution/`        | Remote environment, wire codec, handles and sandbox daemon                                         |
| `turns/`            | Turn admission, provenance, causal report delivery, reset/stop fencing and notification retries    |
| `threads/`          | Channel-key directory, idle gating and consumer-owned CHAT configuration contract                  |
| `api/`, `telegram/` | Channel validation/transport and consumer-owned application operations                             |
| `durable/`          | Shared SDK identity, storage and lifecycle adapters, not business orchestration                    |
| `application/`      | Startup, concrete dependency construction and shutdown                                             |

Every feature has an explicitly listed `index.ts` API. Outsiders do not import implementation files. Types live
beside the responsibility they describe, not in a shared type bucket. Work consumes `WorkTemplateSource`, not
Config; AgentFactory consumes `AgentSkills`, not a concrete catalogue; channels consume operations, not concrete
service classes. API tracing consumes an injected SDK event source and stops observations, not conversations.

## Behavioral compatibility

SDK transactions, stored document/task names and versions remain unchanged. AgentFactory resolves configuration;
Agent owns authorization, adoption and lifecycle. The exact binding returned by configuration is persisted in the
caller's transaction. Existing children retain their settings and skills. Frozen schema-1 work uses saved resolved
role policy, images and cache claims rather than current config or executable policy calculations. Invalid or
missing snapshots fail closed. The checksum detects corruption; it is not authentication of storage.

Work admission deduplication, receipt-before-report acknowledgement, reset/stop fences, restart recovery and
sandbox leases remain integration-tested. WORK still has no coding tools or sandbox. Successful void remote
Results may omit `value`, matching the SDK wire contract. Blueprint validation checks the envelope before
serialization and verifies root existence, template identity and delegate availability.

## Tests

- Colocated `src/<feature>/*.test.ts`: unit tests exercise public APIs with injected/mocked SDK, storage, transport
  and cross-feature capabilities. Nominal SDK document tokens and pure value operations may use real factories;
  unit tests do not run Harness/model/storage orchestration.
- `test/mocks/`: typed shared boundary fixtures; no integration composition or private method access.
- `test/integration/`: real SDK/Harness/SQLite, channel/recovery/env conformance, Git/installer and build/publish
  checks. These retain their integration label rather than being presented as isolated unit tests.

Vitest projects have separate unit/integration timeouts. Mocks are cleared/restored between tests.

## Enforcement

Run `npm run verify` locally; `.github/workflows/check.yml` runs it on pull requests and main with Node 24.

| Mechanism                       | Enforces                                                                                                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.editorconfig`                 | Two spaces, LF, final newline and editor whitespace defaults                                                                                                                                                                        |
| Prettier                        | Layout, consistent semicolons/quotes/trailing commas; no duplicated indentation settings                                                                                                                                            |
| TypeScript                      | Strict types, erasable syntax, unused declarations/parameters and switch fallthrough                                                                                                                                                |
| Oxlint                          | No explicit `any`, non-null/definite assertions; braces; interface preference; structural/style/test rules                                                                                                                          |
| `scripts/check-architecture.ts` | Explicit exports/return types, no unchecked casts, descriptive bindings, one declaration per statement, package APIs, application-owned construction, public test access, nested-ternary rejection and unit cross-feature isolation |
| Unit + integration tests        | Boundary behavior, exact policy, protocol compatibility and durable restart/recovery guarantees                                                                                                                                     |

Only literal `as const` assertions are allowed. Parsing external JSON may return `unknown` through an annotated
boundary function; values are validated before domain use. There is no blanket async rule. Integration tests may
conditionally inspect outcomes and omit throw-message matchers; this does not disable the unsafe-type rules.

Meaningful responsibilities, recovery-only catches, sparing simple ternaries, justified duplication and truly
useful names still require review. A naming check is not proof of domain clarity, and a mock-import check is not
proof of complete behavioral isolation. Unit tests use injected capabilities rather than real framework services.

## Verification

`npm run verify` passes on Node 24.21.0: strict typecheck, Oxlint, architecture checks, Prettier and
**193 tests across 25 files** (82 isolated unit tests, 111 integration tests). Architecture enforcement has an
integration fixture proving both acceptance and rejection, including private bracket access/spies and
application-owned dependency construction. `git diff --check` and shell syntax checks also pass.

No Docker smoke, live Kubernetes verification or deployment was performed. Older grounding/design documents
retain historical source names; this document, README and the current implementation are the package-layout
authority.

## Principles and concrete effects

- **Encode lessons in structure:** feature API, cast, return-type and test-access violations become build failures.
- **Boundary discipline:** Zod validates config, network and saved replay data; pure logic trusts those contracts.
- **Foundational thinking:** consumer contracts and test categories establish ownership before implementation.
- **Laziness/subtract first:** remove duplicated configuration injection and old factory surfaces, not add adapters.
- **Minimize reader load:** domain operation names, explicit APIs, colocated types/tests and one metadata owner.
- **Outcome-oriented execution:** converge on feature packages without retaining obsolete public entry points.
