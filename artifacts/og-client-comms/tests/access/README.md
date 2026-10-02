# Access-gate browser regressions

For the separate, opt-in real Clerk SDK check, see
[`../clerk-smoke/README.md`](../clerk-smoke/README.md). This deterministic suite
does not use Clerk credentials or run that smoke test.

From the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @workspace/og-client-comms exec playwright install --with-deps chromium
pnpm --filter @workspace/api-server run test:access
pnpm --filter @workspace/og-client-comms run test:access
pnpm --filter @workspace/og-client-comms run test:access:browser
pnpm --filter @workspace/og-client-comms run test:access:browser:typecheck
```

The browser command starts and stops its own loopback-only Vite server on port
4179. It does not require the normal workflows, API server, Clerk credentials,
an approved account, or a CRM connection. Install Chromium once per environment;
on a fresh CI runner, Playwright's browser system dependencies are also required.
Failure screenshots and traces are saved under
`artifacts/og-client-comms/test-results/access/` (relative to the workspace root).


## Pull-request CI

GitHub Actions runs `.github/workflows/access-regressions.yml` on every pull
request, without path filters, and also supports manual runs. The
`Isolated access checks` job uses Ubuntu 24.04, Node.js 24, pnpm 10.26.1, the
frozen workspace lockfile, and Chromium installed with its system dependencies.
It runs both packages' `test:access` commands, the isolated browser suite, and
its dedicated typecheck. Independent test steps still run if an earlier check
fails; any failure leaves the job failed.

No repository secrets, Clerk keys, real API process, database, approved account,
or CRM approval are needed. The only server the browser suite starts is its own
test Vite server. Pull-request code runs with read-only repository permissions.
Failed runs upload `access-failure-evidence`, containing available screenshots
and Playwright traces, for 14 days. Download it from the failed Actions run;
inspect a trace with `pnpm --filter @workspace/og-client-comms exec playwright
show-trace /path/to/trace.zip`. Successful runs do not upload failure evidence.

To enforce this check before merging, the GitHub repository administrator must
require `Isolated access checks` in branch protection or a repository ruleset.
The workflow alone reports failures; it does not change repository merge rules.

These tests load the **real App, routing, query client, Protected, ErrorBlock,
RetryButton, and access-retry implementation**. Only the Clerk SDK boundary is
replaced, via aliases in this directory's separate Vite config. The replacement
models signed-in/signed-out hooks, primary email, identity-change listeners,
and sign-out. It does not test Clerk's hosted login UI or real session issuance.
Authentication controls exist only in this test entry point; nothing is added
to the application's config, entry point, or access policy.

Every `/api/workspace/access` response is scripted and intercepted. Unexpected
APIs (including CRM/report endpoints), external requests, and runtime errors
fail the test. No server-side permissions or real accounts are changed.

Each case uses a fresh browser context and query client. Playwright's paused
browser clock drives real countdown intervals and React Query retry timers,
while held responses expose in-flight UI states. Query observer notifications
use microtasks in the test entry so freezing time does not freeze DOM updates.
Assertions cover integer and
HTTP-date Retry-After deadlines, remounts, automatic retry exhaustion, rapid
click locking, pending-to-authorized recovery, prior-grant hiding, identity
isolation, signed-out redirects, cancellation, and non-retryable 401/403.
