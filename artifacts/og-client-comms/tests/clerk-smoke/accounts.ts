import { randomUUID } from "node:crypto";
import { requireDevelopmentClerk } from "./safety";

type TestUser = { id: string; email: string };

// Backend credentials stay in Node. Only one-use, short-lived sign-in tickets
// cross into the browser. No CRM/API-server calls are made here.
export class DevelopmentAccounts {
  private readonly created: TestUser[] = [];
  private readonly secretKey = requireDevelopmentClerk().secretKey;

  private async request(path: string, method: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`https://api.clerk.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    // Do not include response bodies, headers or credentials in failure logs.
    if (!response.ok) throw new Error(`Clerk development ${method} ${path} failed (${response.status}).`);
    return response.json();
  }

  async create(): Promise<TestUser> {
    const email = `og-sdk-smoke-${randomUUID()}+clerk_test@example.com`;
    const result = await this.request("/users", "POST", {
      email_address: [email],
      skip_password_requirement: true,
    }) as { id?: string };
    if (!result.id) throw new Error("Clerk did not return a development test user.");
    const user = { id: result.id, email };
    this.created.push(user);
    return user;
  }

  async ticket(user: TestUser): Promise<string> {
    if (!this.created.includes(user)) throw new Error("Only users created by this run may sign in.");
    const result = await this.request("/sign_in_tokens", "POST", {
      user_id: user.id,
      expires_in_seconds: 120,
    }) as { token?: string };
    if (!result.token) throw new Error("Clerk did not return a development sign-in ticket.");
    return result.token;
  }

  async cleanup() {
    const failures: string[] = [];
    // Delete only users owned by this run, even if an assertion/sign-in failed.
    for (const user of this.created) {
      try { await this.request(`/users/${user.id}`, "DELETE"); }
      catch { failures.push(user.id); }
    }
    if (failures.length) {
      throw new Error(`Clerk development cleanup failed for test user IDs: ${failures.join(", ")}. Delete these development users before retrying.`);
    }
  }
}