# Development-only real Clerk SDK smoke test

This is **not** part of `test:access:browser` (the deterministic,
no-credentials suite). It loads the real App, ClerkProvider, hooks and SDK
listener. No Clerk aliases, fake identities, CRM approval or authorization
bypasses are used. Production source files are unchanged.

From the workspace root, with the existing development Clerk secrets available:

```sh
pnpm --filter @workspace/og-client-comms exec playwright install chromium
pnpm --filter @workspace/og-client-comms run test:access:clerk:typecheck
CLERK_SDK_SMOKE=1 pnpm --filter @workspace/og-client-comms run test:access:clerk
```

The opt-in flag is required; missing credentials, live keys, production mode,
sign-in failures and unavailable Clerk all fail explicitly (never skip/pass).
Keep this out of the default deterministic CI job. It requires network access
to Clerk and Chromium's system dependencies.

The standalone loopback-only Vite server uses port 4180, does not reuse an
existing server, and is stopped by Playwright. The Node runner creates two
random, isolated development users and short-lived ticket-based sign-ins.
Tickets are consumed by the actual SDK, including real session issuance and
`setActive`. The development tenant permits one session per client, so identity
change is A → signed-out → B. The real SDK's supported sign-out callback prevents
a hard navigation in this portion only. Cache clearing is asserted separately
on both transitions, including a marker seeded while signed out that must be
cleared by B's sign-in itself. The original document/App must not reload, and
no tenant settings are changed. The final sign-out uses the production button
with its normal redirect.
The secret key stays in Node. No passwords or existing users are
used. Traces, screenshots and video are disabled to avoid recording credentials.
All created users are deleted in `finally`, including after failures. A forced
process kill can prevent cleanup; remove orphaned `og-sdk-smoke-…+clerk_test`
users from the **Development** instance only. Cleanup errors list only the
test user IDs requiring removal.

Every local `/api/workspace/access` response is intercepted as pending.
All other local app APIs and external hosts other than the configured development
Clerk host are aborted and fail the test. There is no API-server proxy, so this
server cannot reach CRM. Clerk requests remain real.

Assertions cover:
- A real signed-in user reaches `/guide`, sees pending access and their SDK email
  and user ID, but cannot see protected navigation/content.
- Changing to another real user clears the first user's access cache
  and seeded unrelated private-cache markers, and checks access for the new
  user. The marker/client observer exists only in this test server; the App's
  existing module-level client is observed by a test-only transform.
- Clicking the real pending-screen sign-out button redirects home, and visiting
  a protected URL while signed out redirects without making an access request.

This does not test the hosted sign-in form, owner approval, live CRM responses,
or production credentials/permissions.