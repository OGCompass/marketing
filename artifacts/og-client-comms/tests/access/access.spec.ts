import { test, expect, EPOCH, accessReply, temporary, hold } from "./fixtures";

for (const status of [429, 503]) {
  test(`${status} countdown blocks clicks and recovers automatically to pending, then authorized`, async ({ access, page }) => {
    access.replies.push(temporary(status), accessReply(false));
    await access.open();
    const retry = page.getByTestId("button-retry-access");
    await expect(page.getByRole("alert")).toContainText("Access check temporarily unavailable");
    await expect(retry).toHaveText("Retry in 4s");
    await expect(retry).toBeDisabled();
    await access.blocked();
    await access.rapidClicks("button-retry-access");
    await access.advance(1_000);
    await expect(retry).toHaveText("Retry in 3s");
    await access.count(1);
    await access.advance(2_999);
    await access.count(1);
    await access.advance(1);
    await expect(page.getByTestId("screen-access-pending")).toBeVisible();
    await expect(page.getByTestId("text-user-id")).toHaveText("user-a");
    await expect(page.getByTestId("text-primary-email")).toHaveText("user-a@example.test");
    await access.count(2);
    expect(access.requests[1].at - access.requests[0].at).toBeGreaterThanOrEqual(4_000);
    await access.blocked();

    const approval = hold(accessReply(true));
    access.replies.push(approval.reply);
    await access.rapidClicks("button-recheck-access");
    await expect(page.getByTestId("button-recheck-access")).toHaveText("Checking access…");
    await expect(page.getByTestId("button-recheck-access")).toBeDisabled();
    await access.count(3);
    await access.rapidClicks("button-recheck-access");
    await access.count(3);
    await access.blocked();
    approval.release();
    await access.authorized();
    await access.count(3);
  });
}

test("HTTP-date Retry-After persists across a remount and recovers to authorized", async ({ access, page }) => {
  access.replies.push(
    temporary(503, new Date(EPOCH.getTime() + 6_000).toUTCString()),
    accessReply(true),
  );
  await access.open();
  const retry = page.getByTestId("button-retry-access");
  await expect(retry).toHaveText("Retry in 6s");
  await access.advance(2_000);
  await expect(retry).toHaveText("Retry in 4s");
  await access.remount();
  // An in-flight query can revert to loading on unmount; the shared cooldown
  // must still prevent its new observer from making an early request.
  await access.blocked();
  await access.advance(3_999);
  await access.count(1);
  await access.blocked();
  await access.advance(1);
  await access.authorized();
  await access.count(2);
  expect(access.requests[1].at).toBeGreaterThanOrEqual(EPOCH.getTime() + 6_000);
});

test("exhausted automatic retries leave a live countdown and one manual recovery", async ({ access, page }) => {
  access.replies.push(temporary(429), temporary(503), temporary(429));
  await access.open();
  const retry = page.getByTestId("button-retry-access");
  await expect(retry).toHaveText("Retry in 4s");
  await access.advance(4_000);
  await access.count(2);
  await expect(retry).toHaveText("Retry in 4s");
  await access.advance(4_000);
  await access.count(3);
  await expect(page.getByRole("alert")).toContainText("Please wait before trying again");
  await expect(retry).toBeDisabled();
  await access.remount();
  await expect(retry).toHaveText("Retry in 4s");
  await access.rapidClicks("button-retry-access");
  await access.advance(3_999);
  await access.count(3);
  await access.advance(1);
  await expect(retry).toHaveText("Retry");
  await expect(retry).toBeEnabled();
  await access.count(3); // no fourth automatic retry

  const recovered = hold(accessReply(false));
  access.replies.push(recovered.reply);
  await access.rapidClicks("button-retry-access");
  // Refetch clears a terminal query error and shows the loading gate. There
  // must be no stale retry control or protected content while it is in flight.
  await expect(retry).toHaveCount(0);
  await access.count(4);
  await access.blocked();
  recovered.release();
  await expect(page.getByTestId("screen-access-pending")).toBeVisible();
  await access.count(4);
});

test("a prior grant is hidden during remount revalidation, failure, and pending recovery", async ({ access, page }) => {
  access.replies.push(accessReply(true));
  await access.open();
  await access.authorized();
  const revalidation = hold(temporary(503));
  access.replies.push(revalidation.reply, accessReply(false));
  await access.remount();
  await access.count(2);
  await access.blocked();
  revalidation.release();
  await expect(page.getByTestId("button-retry-access")).toHaveText("Retry in 4s");
  await access.blocked();
  await access.advance(4_000);
  await expect(page.getByTestId("screen-access-pending")).toBeVisible();
  await access.blocked();
  access.replies.push(accessReply(true));
  await page.getByTestId("button-recheck-access").click();
  await access.authorized();
});

test("identity switching cancels the old countdown without sharing its grant or delay", async ({ access, page }) => {
  access.replies.push(temporary(429, "10"));
  await access.open();
  await expect(page.getByTestId("button-retry-access")).toHaveText("Retry in 10s");
  const other = hold(accessReply(false, "user-b"));
  access.replies.push(other.reply);
  await access.identity("user-b");
  await access.count(2); // B does not inherit A's ten-second cooldown
  await access.blocked();
  other.release();
  await expect(page.getByTestId("text-user-id")).toHaveText("user-b");
  await expect(page.getByTestId("text-primary-email")).toHaveText("user-b@example.test");
  await access.advance(10_000);
  await access.count(2); // cancelled A retry must never call the endpoint

  access.replies.push(accessReply(true, "user-b"));
  await page.getByTestId("button-recheck-access").click();
  await access.authorized();
  const switched = hold(accessReply(false, "user-c"));
  access.replies.push(switched.reply);
  await access.identity("user-c");
  await access.count(4);
  await access.blocked(); // B's successful grant is not reused for C
  switched.release();
  await expect(page.getByTestId("text-user-id")).toHaveText("user-c");
  await access.blocked();
  expect(access.requests.map((request) => request.userId)).toEqual(["user-a", "user-b", "user-b", "user-c"]);
});

test("signed-out protected navigation redirects home without checking workspace access", async ({ access, page }) => {
  await access.open(null);
  await page.goto("/guide");
  await expect(page).toHaveURL("http://127.0.0.1:4179/");
  await expect(page.getByTestId("link-sign-in")).toBeVisible();
  await access.blocked();
  await access.count(0);
});

test("an old identity's late authorized response cannot unlock the new identity", async ({ access, page }) => {
  const oldGrant = hold(accessReply(true));
  access.replies.push(oldGrant.reply);
  await access.open();
  await access.count(1);
  await access.blocked();
  access.replies.push(accessReply(false, "user-b"));
  await access.identity("user-b");
  await expect(page.getByTestId("text-user-id")).toHaveText("user-b");
  await access.blocked();
  oldGrant.release();
  await expect.poll(() => access.completed).toBe(2);
  await expect(page.getByTestId("text-user-id")).toHaveText("user-b");
  await expect(page.getByTestId("screen-access-pending")).toBeVisible();
  await access.blocked();
  await access.count(2);
});

test("pending sign-out clears the gate and returns to the signed-out landing page", async ({ access, page }) => {
  access.replies.push(accessReply(false));
  await access.open();
  await expect(page.getByTestId("screen-access-pending")).toBeVisible();
  await page.getByTestId("button-pending-sign-out").click();
  await expect(page).toHaveURL("http://127.0.0.1:4179/");
  await expect(page.getByTestId("link-sign-in")).toBeVisible();
  await expect(page.getByTestId("screen-access-pending")).toHaveCount(0);
  await access.blocked();
  await access.count(1);
});

test("sign-out during a retry wait redirects home and cancels the delayed request", async ({ access, page }) => {
  access.replies.push(temporary(503, "10"));
  await access.open();
  await expect(page.getByTestId("button-retry-access")).toHaveText("Retry in 10s");
  await access.identity(null);
  await expect(page).toHaveURL("http://127.0.0.1:4179/");
  await expect(page.getByTestId("link-sign-in")).toBeVisible();
  await access.advance(10_000);
  await access.count(1);
  await access.blocked();
});

for (const status of [401, 403]) {
  test(`${status} remains blocked without automatic retries or countdown`, async ({ access, page }) => {
    access.replies.push({ status, body: { message: "Access denied by test server" } });
    await access.open();
    await expect(page.getByRole("alert")).toContainText("Access check failed");
    await expect(page.getByTestId("button-retry-access")).toHaveText("Retry");
    await access.advance(60_000);
    await access.count(1);
    await access.blocked();
  });
}