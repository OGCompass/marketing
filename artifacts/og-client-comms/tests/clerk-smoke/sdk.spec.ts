import { test, expect, type Page } from "@playwright/test";
import type { useClerk } from "@clerk/react";
import { DevelopmentAccounts } from "./accounts";
import { requireDevelopmentClerk } from "./safety";

type ClerkSDK = ReturnType<typeof useClerk>;

async function signIn(page: Page, ticket: string, userId: string) {
  // Evaluate the real SDK, not a replacement hook or synthetic listener.
  const outcome = await page.evaluate(async (value) => {
    const clerk = (window as unknown as { Clerk: ClerkSDK }).Clerk;
    try {
      const attempt = await clerk.client!.signIn.create({ strategy: "ticket", ticket: value });
      if (attempt.status !== "complete" || !attempt.createdSessionId) return `status:${attempt.status}`;
      await clerk.setActive({ session: attempt.createdSessionId });
      return "complete";
    } catch (error) {
      // Only SDK machine codes are safe to report; never log the full error.
      const codes = (error as { errors?: { code: string }[] }).errors?.map(item => item.code);
      return codes?.join(",") || "SDK exception";
    }
  }, ticket);
  expect(outcome, "Real Clerk ticket sign-in must complete").toBe("complete");
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { Clerk: ClerkSDK }
  ).Clerk.user?.id)).toBe(userId);
}

test("real SDK gates pending users, clears identity caches, and signs out to home", async ({ page }) => {
  const accounts = new DevelopmentAccounts();
  const unexpected: string[] = [];
  const runtimeErrors: string[] = [];
  const accessUsers: string[] = [];
  // Only the configured development Clerk host may receive live requests.
  const encodedHost = requireDevelopmentClerk().publishableKey.slice("pk_test_".length);
  const clerkHost = Buffer.from(encodedHost, "base64").toString("utf8").replace(/\$$/, "");
  if (!clerkHost || clerkHost.includes("/") || clerkHost.includes(":")) {
    throw new Error("Invalid development Clerk hostname.");
  }
  async function intercept(target: Page) {
    target.on("pageerror", () => runtimeErrors.push("Browser runtime error"));
    await target.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://127.0.0.1:4180") {
        // Clerk's own SDK API is live, never stubbed. All other external
        // traffic (including direct CRM URLs) is blocked.
        if (url.protocol === "https:" && url.hostname === clerkHost) {
          await route.continue();
        } else {
          unexpected.push(`Unexpected external host: ${url.hostname}`);
          await route.abort();
        }
      } else if (url.pathname === "/api/workspace/access") {
        const id = await target.evaluate(() => (
          window as unknown as { Clerk: ClerkSDK }
        ).Clerk.user?.id);
        if (!id) {
          unexpected.push("Access requested without a signed-in SDK user");
          await route.abort();
          return;
        }
        accessUsers.push(id);
        await route.fulfill({
          json: { authorized: false, userId: id, reason: "Smoke test: owner approval required" },
          headers: { "Cache-Control": "no-store" },
        });
      } else if (url.pathname.startsWith("/api/")) {
        unexpected.push(url.pathname);
        await route.abort();
      } else {
        await route.continue();
      }
    });
  }
  await intercept(page);

  try {
    const first = await accounts.create();
    const second = await accounts.create();
    await page.goto("/");
    await expect(page.getByTestId("link-sign-in")).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!(
      window as unknown as { Clerk: ClerkSDK }
    ).Clerk?.loaded)).toBe(true);
    await signIn(page, await accounts.ticket(first), first.id);
    await expect(page).toHaveURL(/\/guide$/);
    await expect(page.getByTestId("screen-access-pending")).toBeVisible();
    await expect(page.getByTestId("text-primary-email")).toHaveText(first.email);
    await expect(page.getByTestId("text-user-id")).toHaveText(first.id);
    await expect(page.getByTestId("link-nav-dashboard")).toHaveCount(0);
    await expect(page.getByTestId("banner-readonly")).toHaveCount(0);
    expect(accessUsers).toContain(first.id);

    await page.evaluate(() => window.clerkSmoke.seed());
    expect(await page.evaluate(() => window.clerkSmoke.hasMarker())).toBe(true);
    expect(await page.evaluate(() => window.clerkSmoke.cachedAccessUsers())).toContain(first.id);
    const documentId = await page.evaluate(() => {
      const id = crypto.randomUUID();
      document.documentElement.dataset.smokeDocument = id;
      return id;
    });
    // The development tenant permits only one session per client. Use the
    // SDK's supported signOut callback to revoke A without a document reload,
    // then sign in B. This exercises both identity transitions with the same
    // real App, query client and addListener subscription.
    await page.evaluate(async () => {
      const clerk = (window as unknown as { Clerk: ClerkSDK }).Clerk;
      await clerk.signOut(() => {});
    });
    await expect(page.getByTestId("link-sign-in")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.clerkSmoke.hasMarker())).toBe(false);
    expect(await page.evaluate(() => window.clerkSmoke.cachedAccessUsers())).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.dataset.smokeDocument)).toBe(documentId);
    // Seed again while signed out: B's sign-in itself must clear this marker,
    // rather than merely relying on A's earlier sign-out to clear private data.
    await page.evaluate(() => window.clerkSmoke.seed());
    expect(await page.evaluate(() => window.clerkSmoke.hasMarker())).toBe(true);
    await signIn(page, await accounts.ticket(second), second.id);
    await expect(page.getByTestId("text-user-id")).toHaveText(second.id);
    await expect(page.getByTestId("text-primary-email")).toHaveText(second.email);
    await expect(page.getByTestId("screen-access-pending")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.clerkSmoke.hasMarker())).toBe(false);
    await expect.poll(() => page.evaluate(() => window.clerkSmoke.cachedAccessUsers())).toEqual([second.id]);
    expect(await page.evaluate(() => document.documentElement.dataset.smokeDocument)).toBe(documentId);
    expect(accessUsers).toContain(second.id);
    await expect(page.getByTestId("link-nav-dashboard")).toHaveCount(0);

    await page.evaluate(() => window.clerkSmoke.seed());
    await page.getByTestId("button-pending-sign-out").click();
    await expect(page).toHaveURL("http://127.0.0.1:4180/");
    await expect(page.getByTestId("link-sign-in")).toBeVisible();
    await expect(page.getByTestId("screen-access-pending")).toHaveCount(0);
    // A hard navigation may follow sign-out. Re-entering a gated route must
    // still redirect home with no access request, using actual signed-out hooks.
    const requestCount = accessUsers.length;
    await page.goto("/guide");
    await expect(page).toHaveURL("http://127.0.0.1:4180/");
    await expect(page.getByTestId("link-sign-in")).toBeVisible();
    expect(accessUsers).toHaveLength(requestCount);
    expect(await page.evaluate(() => window.clerkSmoke.hasMarker())).toBe(false);
    expect(await page.evaluate(() => window.clerkSmoke.cachedAccessUsers())).toEqual([]);
    expect(unexpected, "No real app/CRM APIs may be called").toEqual([]);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await accounts.cleanup();
  }
});