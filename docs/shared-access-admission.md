# Shared access admission design

## Status and approval boundary

This is a design with executable synthetic fixtures, **not live distributed
enforcement**. The API still uses its process-local limiter. Do not scale the API
to multiple instances on the strength of these fixtures. A process restart still
resets live limits. No new service, database table, persistence, deployment setting,
approved-account setting, or credential has been added.

Before scaling, obtain approval for an admission authority shared by **all**
instances (and deployment generations), its storage, retention, and operations.
An edge service is an alternative only if it implements the same authenticated
principal and provider-permit protocol below. Ordinary IP-based edge rate limits
are insufficient. Splitting budgets by replica count is not safe during rolling
restarts, autoscaling, or uneven traffic.

## Proposed architecture

Use a single logical, strongly consistent admission authority backed by an
approved transactional store. API instances verify Clerk authentication locally,
then submit only the authenticated Clerk principal's opaque key. Never accept a
principal from request headers, email, IP address, or an unverified token.
Namespace by environment and application; all replicas use the same namespace.
Use a keyed hash of the Clerk principal to avoid storing the raw identifier.
The hashing key must survive rolling restarts; rotation requires a coordinated
drain, not concurrent old/new namespaces with independent budgets.

The authority stores only:

- Per-principal token balance, last refill timestamp, and active permit count.
- Global active provider permit count.
- Opaque permit IDs and owning worker generation for idempotent release/recovery.
- A versioned, centrally managed limit policy and recovery state.

No CRM records, identity response, email, approved-account list, or positive
authorization result is stored or cached. Counter keys are pseudonymous access
metadata, not anonymous data; their retention and access controls require approval.

## Protocol and atomic operations

1. **Debit** on every authenticated access-status/private request, before any
   provider lookup. One transaction refills and consumes one principal token using
   authority time, not replica clocks. Defaults remain burst 60, one token per
   1000 ms, maximum 10000 tracked principals. Exhaustion returns 429 with the
   ceiling of time to the next token (minimum one second). A capacity rejection
   later in the request does not refund this token.
2. **Acquire** only when current policy actually needs a Clerk identity. In one
   transaction check principal active count (default 2) and global active count
   (default 8), then reserve a unique provider permit and increment both.
   Principal exhaustion returns 429; global exhaustion returns 503. No queue.
   Debits do not reserve provider slots for anonymous/default-denied/malformed
   policy requests.
3. **Lookup** once per admitted request and evaluate the existing policy using
   current approvals. Do not coalesce lookups or reuse any earlier identity or
   grant. Explicit ID approvals still require the fresh ban/lock check.
4. **Release** the opaque permit exactly once after the actual provider operation
   settles, including provider failure. HTTP disconnects/timeouts do not release
   it early. Release is idempotent and cannot decrement another principal's count.
   If release cannot be confirmed, retain the reservation conservatively, retry
   release through a bounded recovery path, and return 503 rather than access.

Only these admission operations are centralized; fresh policy evaluation remains
in the API. Authenticate and restrict the authority's internal API to API workers.
Do not expose it as a public proxy, log principal keys, or send identity payloads
through it. Use bounded operation deadlines, no per-replica grant batches, and no
automatic local-limiter fallback. An ambiguous debit/acquire consumes/reserves
capacity conservatively and returns 503; never run the provider after ambiguous
acquire. Idempotency IDs prevent transport retries from creating duplicate permits;
an ID is single-request-scoped and must not become an authorization cache.

## Restart, outage and lease safety

- API restart: budgets and outstanding provider permits stay in the authority.
  Adding/restarting a replica creates no new allowance.
- Authority restart: counters and permits must survive with transactional
  consistency. If unavailable, disconnected, restored from stale state, or of
  unknown freshness, protected traffic fails closed with 503. Never initialize
  empty full buckets while traffic continues.
- Loss of state: enter a closed recovery epoch. Stop new provider calls, fence
  all old worker generations and verify their calls have settled/terminated.
  Wait at least the full bucket-refill horizon before reopening conservatively.
  The authority must reject old worker operations after recovery.
- Worker crash: do **not** expire a permit on heartbeat/lease timeout alone.
  A timed-out HTTP client does not prove a provider request ended. Retain the
  permit until settlement is known or the owning worker is fenced/terminated and
  provider work is demonstrably drained. If this cannot be established, stay
  closed pending operator recovery. Prefer temporary lost capacity over exceeding
  the provider limit.
- Evict principal counters only when idle and fully replenished. Never evict
  depleted counters or counters with active/unresolved permits. Retention
  expiration and policy changes must not silently refill active budgets.
- Use one policy version cluster-wide. Changes to limits require coordinated
  reconciliation of existing balances/permits; replicas cannot each choose limits.

The future adapter must handle failed and ambiguous transactions, release retries,
fencing, authority restart, and state recovery. The synchronous fixture deliberately
does not claim to implement a network/store adapter or crash recovery.

## HTTP and routing invariants

Reuse the current handler contract: all admission denials have `authorized: false`
and `unavailable: true`. Return 429 for principal limits, 503 for provider/authority
capacity or faults, with positive integer `Retry-After` and `Cache-Control:
no-store` on status and private responses. Never execute a private handler on
failure. Anonymous protected requests retain 401; policy denials retain 403.
Public health and Clerk proxy/sign-in routes remain outside admission entirely.
Sharing counters never changes approvals or the next-request revocation contract.

## Executable evidence and rollout gate

`pnpm --filter @workspace/api-server test:access` includes two or more synthetic
replicas using one reference authority, alternated/concurrent bursts, principal
isolation, shared provider capacity, replica replacement with depleted balances
and active permits, authority unavailability, safe counter eviction, and fresh
revocation. These prove the proposed coordination semantics, not cross-process
durability. Existing HTTP fixtures cover 429/503, headers and public-path bypass.

Before enabling replicas:

1. Obtain infrastructure/metadata approval and implement the transactional adapter.
2. Run independent-process tests against that approved service: concurrent atomic
   operations, store failover/restart, lost replies, release failure, worker crash,
   clock behavior, namespace/policy mismatch and closed state-loss recovery.
3. Verify status/private routes share one budget with real authenticated
   principals, health/Clerk proxy bypass, and next-request ban/lock/email revocation.
4. Monitor aggregate provider concurrency and admission failure counts without
   identifiers, identity payloads or CRM data. Prove rollback cannot route traffic
   to multiple independent local budgets. Keep replica count at one until approved.