import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWorkspaceAccess,
  type WorkspaceIdentity,
} from "./workspace-access-policy";

const USER_ID = "user_fixture_123";
const APPROVED_EMAIL = "owner@example.test";

function identity(overrides: Partial<WorkspaceIdentity> = {}): WorkspaceIdentity {
  return {
    id: USER_ID,
    banned: false,
    locked: false,
    primaryEmailAddressId: "email_primary",
    emailAddresses: [{
      id: "email_primary",
      emailAddress: APPROVED_EMAIL,
      verification: { status: "verified" },
    }],
    ...overrides,
  };
}

function policy(
  overrides: Partial<Parameters<typeof evaluateWorkspaceAccess>[0]> = {},
) {
  return evaluateWorkspaceAccess({
    userId: USER_ID,
    authorizedEmails: APPROVED_EMAIL,
    lookupIdentity: async () => identity(),
    ...overrides,
  });
}

test("default deny does not call Clerk when no approvals are configured", async () => {
  let lookups = 0;
  const lookupIdentity = async () => {
    lookups++;
    return identity();
  };
  const result = await policy({
    authorizedEmails: "",
    authorizedUserIds: "",
    lookupIdentity,
  });
  const unsigned = await evaluateWorkspaceAccess({
    userId: null,
    authorizedEmails: APPROVED_EMAIL,
    authorizedUserIds: USER_ID,
    lookupIdentity,
  });
  assert.deepEqual(result, { authorized: false, unavailable: false });
  assert.deepEqual(unsigned, { authorized: false, unavailable: false });
  assert.equal(lookups, 0);
});

test("an exact verified primary email authorizes after case and trim normalization", async () => {
  const result = await policy({
    authorizedEmails: "  OWNER@Example.test , second@example.test  ",
    lookupIdentity: async () => identity({
      emailAddresses: [{
        id: "email_primary",
        emailAddress: " Owner@Example.test ",
        verification: { status: "verified" },
      }],
    }),
  });
  assert.deepEqual(result, { authorized: true, unavailable: false });
});

test("unknown and look-alike addresses or domains do not match", async () => {
  for (const address of [
    "unknown@example.test",
    "owner+other@example.test",
    "owner@sub.example.test",
    "owner@example.test.attacker.test",
  ]) {
    const result = await policy({
      lookupIdentity: async () => identity({
        emailAddresses: [{
          id: "email_primary",
          emailAddress: address,
          verification: { status: "verified" },
        }],
      }),
    });
    assert.deepEqual(result, { authorized: false, unavailable: false }, address);
  }
});

test("an unverified primary email is denied", async () => {
  const result = await policy({
    lookupIdentity: async () => identity({
      emailAddresses: [{
        id: "email_primary",
        emailAddress: APPROVED_EMAIL,
        verification: { status: "unverified" },
      }],
    }),
  });
  assert.deepEqual(result, { authorized: false, unavailable: false });
});

test("a missing primary email is denied", async () => {
  const result = await policy({
    lookupIdentity: async () => identity({
      primaryEmailAddressId: null,
    }),
  });
  assert.deepEqual(result, { authorized: false, unavailable: false });
});

test("a matching verified secondary email does not authorize", async () => {
  const result = await policy({
    lookupIdentity: async () => identity({
      primaryEmailAddressId: "email_primary",
      emailAddresses: [
        {
          id: "email_primary",
          emailAddress: "other@example.test",
          verification: { status: "verified" },
        },
        {
          id: "email_secondary",
          emailAddress: APPROVED_EMAIL,
          verification: { status: "verified" },
        },
      ],
    }),
  });
  assert.deepEqual(result, { authorized: false, unavailable: false });
});

test("banned and locked Clerk users are denied", async (t) => {
  for (const state of [{ banned: true }, { locked: true }]) {
    await t.test(JSON.stringify(state), async () => {
      const result = await policy({
        lookupIdentity: async () => identity(state),
      });
      assert.deepEqual(result, { authorized: false, unavailable: false });
    });
  }
});

test("a Clerk user ID that differs from the authenticated ID is denied", async () => {
  const result = await policy({
    lookupIdentity: async () => identity({ id: "different_user_fixture" }),
  });
  assert.deepEqual(result, { authorized: false, unavailable: false });
});

test("a mismatched returned Clerk ID is denied for an explicitly approved ID", async () => {
  const result = await policy({
    authorizedEmails: "",
    authorizedUserIds: USER_ID,
    lookupIdentity: async () => identity({ id: "different_user_fixture" }),
  });
  assert.deepEqual(result, { authorized: false, unavailable: false });
});

test("lookup failures fail closed without retaining or exposing exception details", async () => {
  const privateExceptionText = "credential-fixture private-fixture@example.test";
  const result = await policy({
    lookupIdentity: async () => { throw new Error(privateExceptionText); },
  });
  assert.deepEqual(result, { authorized: false, unavailable: true });
  assert.equal(JSON.stringify(result).includes(privateExceptionText), false);
});

test("malformed email allowlists fail closed without looking up a user", async () => {
  for (const authorizedEmails of [
    "owner@example.test,",
    "owner@example.test,,other@example.test",
    "*@example.test",
    "not-an-email",
  ]) {
    let lookups = 0;
    const result = await policy({
      authorizedEmails,
      lookupIdentity: async () => {
        lookups++;
        return identity();
      },
    });
    assert.deepEqual(result, { authorized: false, unavailable: true }, authorizedEmails);
    assert.equal(lookups, 0);
  }
});

test("legacy explicit user ID approvals require an active matching Clerk account, not an approved email", async () => {
  let lookups = 0;
  const result = await policy({
    authorizedUserIds: "another_fixture_id, user_fixture_123",
    authorizedEmails: "",
    lookupIdentity: async () => {
      lookups++;
      return identity({
        primaryEmailAddressId: "unverified_primary",
        emailAddresses: [{
          id: "unverified_primary",
          emailAddress: "unverified@example.test",
          verification: { status: "unverified" },
        }],
      });
    },
  });
  assert.deepEqual(result, { authorized: true, unavailable: false });
  assert.equal(lookups, 1);
});

test("an explicitly approved ID does not require a primary email address", async () => {
  const result = await policy({
    authorizedEmails: "",
    authorizedUserIds: USER_ID,
    lookupIdentity: async () => identity({
      primaryEmailAddressId: null,
      emailAddresses: [],
    }),
  });
  assert.deepEqual(result, { authorized: true, unavailable: false });
});

test("banned and locked explicitly approved ID accounts are denied", async (t) => {
  for (const state of [{ banned: true }, { locked: true }]) {
    await t.test(JSON.stringify(state), async () => {
      const result = await policy({
        authorizedEmails: "",
        authorizedUserIds: USER_ID,
        lookupIdentity: async () => identity(state),
      });
      assert.deepEqual(result, { authorized: false, unavailable: false });
    });
  }
});

test("removing an explicit ID approval revokes access on the next request", async () => {
  let lookups = 0;
  const lookupIdentity = async () => {
    lookups++;
    return identity();
  };
  const firstRequest = await policy({
    authorizedEmails: "",
    authorizedUserIds: USER_ID,
    lookupIdentity,
  });
  const secondRequest = await policy({
    authorizedEmails: "",
    authorizedUserIds: "",
    lookupIdentity,
  });
  assert.deepEqual(firstRequest, { authorized: true, unavailable: false });
  assert.deepEqual(secondRequest, { authorized: false, unavailable: false });
  assert.equal(lookups, 1);
});

test("an active explicitly approved ID is revoked when the Clerk account becomes banned or locked", async (t) => {
  for (const state of [{ banned: true }, { locked: true }]) {
    await t.test(JSON.stringify(state), async () => {
      let lookups = 0;
      const lookupIdentity = async () => {
        lookups++;
        return identity(lookups === 1 ? {} : state);
      };
      const firstRequest = await policy({
        authorizedEmails: "",
        authorizedUserIds: USER_ID,
        lookupIdentity,
      });
      const secondRequest = await policy({
        authorizedEmails: "",
        authorizedUserIds: USER_ID,
        lookupIdentity,
      });
      assert.deepEqual(firstRequest, { authorized: true, unavailable: false });
      assert.deepEqual(secondRequest, { authorized: false, unavailable: false });
      assert.equal(lookups, 2);
    });
  }
});

test("removed email approvals revoke access on the next request", async () => {
  let lookups = 0;
  const lookupIdentity = async () => {
    lookups++;
    return identity();
  };
  const firstRequest = await policy({ lookupIdentity });
  const secondRequest = await policy({
    authorizedEmails: "",
    lookupIdentity,
  });
  assert.deepEqual(firstRequest, { authorized: true, unavailable: false });
  assert.deepEqual(secondRequest, { authorized: false, unavailable: false });
  assert.equal(lookups, 1);
});

test("a changed verified primary email revokes access on the next request", async () => {
  let lookups = 0;
  const lookupIdentity = async () => {
    lookups++;
    return identity(lookups === 1
      ? {}
      : {
          primaryEmailAddressId: "email_changed",
          emailAddresses: [{
            id: "email_changed",
            emailAddress: "changed@example.test",
            verification: { status: "verified" },
          }],
        });
  };
  const firstRequest = await policy({ lookupIdentity });
  const secondRequest = await policy({ lookupIdentity });
  assert.deepEqual(firstRequest, { authorized: true, unavailable: false });
  assert.deepEqual(secondRequest, { authorized: false, unavailable: false });
  assert.equal(lookups, 2);
});
// Temporary merge-enforcement verification; never merge this commit.
test("required access check blocks an intentional regression", () => {
  assert.fail("Intentional failure to verify GitHub merge blocking");
});
