import { test as base, expect, type Page, type Route } from "@playwright/test";

export const EPOCH = new Date("2026-01-01T12:00:00Z");
type Reply = {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  wait?: Promise<void>;
};
export const accessReply = (authorized: boolean, userId = "user-a"): Reply => ({
  status: 200,
  body: { authorized, userId, reason: authorized ? "Test authorization" : "Owner approval required" },
});
export const temporary = (status: number, retryAfter = "4"): Reply => ({
  status,
  headers: { "Retry-After": retryAfter },
  body: { message: "Temporary test access failure" },
});
export function hold(reply: Reply) {
  let release!: () => void;
  return {
    reply: { ...reply, wait: new Promise<void>((resolve) => { release = resolve; }) },
    release: () => release(),
  };
}

export class AccessBrowser {
  readonly replies: Reply[] = [];
  readonly requests: { at: number; userId: string | null }[] = [];
  readonly unexpected: string[] = [];
  completed = 0;
  private userId: string | null = null;

  constructor(readonly page: Page) {}

  async install() {
    await this.page.clock.install({ time: EPOCH });
    await this.page.clock.pauseAt(EPOCH);
    await this.page.route("**/*", async (route: Route) => {
      const url = new URL(route.request().url());
      // No live Clerk calls, external hosts, or unhandled application APIs.
      if (url.origin !== "http://127.0.0.1:4179") {
        this.unexpected.push(route.request().url());
        await route.abort();
      } else if (url.pathname === "/api/workspace/access") {
        this.requests.push({ at: await this.page.evaluate(() => Date.now()), userId: this.userId });
        const reply = this.replies.shift();
        if (!reply) {
          this.unexpected.push("Unscripted workspace access request");
          await route.fulfill({ status: 500, json: { message: "Unscripted access request" } });
          return;
        }
        await reply.wait;
        await route.fulfill({
          status: reply.status,
          headers: { "Cache-Control": "no-store", ...reply.headers },
          json: reply.body,
        });
        this.completed++;
      } else if (url.pathname === "/api/healthz") {
        await route.fulfill({ json: { status: "ok" } });
      } else if (url.pathname.startsWith("/api/")) {
        this.unexpected.push(url.pathname);
        await route.abort();
      } else {
        await route.continue();
      }
    });
  }

  async open(userId: string | null = "user-a") {
    await this.page.goto("/");
    await expect(this.page.getByTestId("link-sign-in")).toBeVisible();
    if (userId) await this.identity(userId);
  }

  async identity(userId: string | null) {
    this.userId = userId;
    await this.page.evaluate((id) => window.accessTest.identity(id), userId);
  }

  async remount() {
    await this.page.evaluate(() => window.accessTest.remount());
  }

  async rapidClicks(testId: string) {
    // Dispatch in a single JS turn, including synthetic events that bypass
    // native disabled-button suppression, to exercise RetryButton's ref lock.
    await this.page.getByTestId(testId).evaluate((button) => {
      for (let i = 0; i < 10; i++) {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
  }

  async advance(ms: number) {
    await this.page.clock.runFor(ms);
  }

  async count(expected: number) {
    await expect.poll(() => this.requests.length).toBe(expected);
  }

  async blocked() {
    await expect(this.page.getByTestId("banner-readonly")).toHaveCount(0);
    await expect(this.page.getByTestId("link-nav-dashboard")).toHaveCount(0);
    await expect(this.page.getByText("Check the connection", { exact: true })).toHaveCount(0);
  }

  async authorized() {
    await expect(this.page.getByTestId("banner-readonly")).toBeVisible();
    await expect(this.page.getByTestId("link-nav-dashboard")).toBeVisible();
    await expect(this.page.getByText("Check the connection", { exact: true })).toBeVisible();
  }
}

export const test = base.extend<{ access: AccessBrowser }>({
  access: async ({ page }, use) => {
    const browser = new AccessBrowser(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await browser.install();
    await use(browser);
    expect(browser.unexpected, "No real authentication or CRM traffic").toEqual([]);
    expect(pageErrors, "No application runtime errors").toEqual([]);
  },
});
export { expect };