// Node-only. Never import this module into the browser fixture.
export function requireDevelopmentClerk() {
  if (process.env.CLERK_SDK_SMOKE !== "1" || process.env.NODE_ENV === "production") {
    throw new Error("Clerk smoke tests require explicit CLERK_SDK_SMOKE=1 in development.");
  }
  const publishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!publishableKey?.startsWith("pk_test_") || !secretKey?.startsWith("sk_test_")) {
    throw new Error("Clerk smoke tests require development publishable and secret keys; live keys are refused.");
  }
  return { publishableKey, secretKey };
}