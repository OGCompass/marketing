import { useSyncExternalStore, type ReactNode } from "react";

type TestUser = {
  id: string;
  primaryEmailAddress: {
    emailAddress: string;
    verification: { status: string };
  };
};
let user: TestUser | null = null;
const subscribers = new Set<() => void>();
const listeners = new Set<(state: { user: TestUser | null }) => void>();
const subscribe = (listener: () => void) => {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
};

export function setTestIdentity(id: string | null) {
  user = id ? {
    id,
    primaryEmailAddress: {
      emailAddress: `${id}@example.test`,
      verification: { status: "verified" },
    },
  } : null;
  // Exercise App's real Clerk cache-invalidation listener, not just its hooks.
  listeners.forEach((listener) => listener({ user }));
  subscribers.forEach((listener) => listener());
}

const clerk = {
  addListener(listener: (state: { user: TestUser | null }) => void) {
    listeners.add(listener);
    listener({ user });
    return () => { listeners.delete(listener); };
  },
  async signOut({ redirectUrl }: { redirectUrl: string }) {
    setTestIdentity(null);
    window.history.pushState(null, "", redirectUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  },
};

export function useUser() {
  return { user: useSyncExternalStore(subscribe, () => user), isLoaded: true };
}
export function useAuth() {
  return { userId: useUser().user?.id ?? null, isLoaded: true };
}
export const useClerk = () => clerk;
export const ClerkProvider = ({ children }: { children: ReactNode }) => <>{children}</>;
export function Show({ when, children }: { when: string; children: ReactNode }) {
  const signedIn = !!useAuth().userId;
  return (when === "signed-in" ? signedIn : !signedIn) ? <>{children}</> : null;
}
export const SignIn = () => <div>Isolated sign-in fixture</div>;
export const SignUp = () => <div>Isolated sign-up fixture</div>;