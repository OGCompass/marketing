import { useEffect, useRef, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import Guide from '@/pages/guide';
import Dashboard from '@/pages/dashboard';
import Inventory from '@/pages/inventory';
import Blueprint from '@/pages/blueprint';
import Safeguards from '@/pages/safeguards';
import Approvals from '@/pages/approvals';
import { Protected } from '@/components/shell';
import { Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#0f0f0f',
    colorForeground: '#0f0f0f',
    colorMutedForeground: '#5c5c5c',
    colorDanger: '#0f0f0f',
    colorBackground: '#ffffff',
    colorInput: '#fafafa',
    colorInputForeground: '#0f0f0f',
    colorNeutral: '#0f0f0f',
    fontFamily: 'Arial, Helvetica, sans-serif',
    borderRadius: '0px',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-white border border-black w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: { fontFamily: 'Georgia, serif', fontWeight: 400, color: '#0f0f0f' },
    headerSubtitle: { color: '#5c5c5c' },
    socialButtonsBlockButtonText: { color: '#0f0f0f' },
    formFieldLabel: { color: '#0f0f0f', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: 11 },
    footerActionLink: { color: '#0f0f0f', textDecoration: 'underline' },
    footerActionText: { color: '#5c5c5c' },
    dividerText: { color: '#5c5c5c' },
    identityPreviewEditButton: { color: '#0f0f0f' },
    formFieldSuccessText: { color: '#0f0f0f' },
    alertText: { color: '#0f0f0f' },
    formButtonPrimary: { backgroundColor: '#0f0f0f', color: '#fafafa', textTransform: 'uppercase', letterSpacing: '0.12em', fontSize: 12 },
    formFieldInput: { borderColor: '#737373' },
    socialButtonsBlockButton: { borderColor: '#737373' },
    dividerLine: { backgroundColor: '#c7c7c7' },
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} forceRedirectUrl={`${basePath}/guide`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} forceRedirectUrl={`${basePath}/guide`} />
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prev = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    return addListener(({ user }) => {
      const id = user?.id ?? null;
      if (prev.current !== undefined && prev.current !== id) qc.clear();
      prev.current = id;
    });
  }, [addListener, qc]);
  return null;
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in"><Redirect to="/guide" /></Show>
      <Show when="signed-out"><Home /></Show>
    </>
  );
}

function Gated({ children }: { children: ReactNode }) {
  return (
    <>
      <Show when="signed-in"><Protected>{children}</Protected></Show>
      <Show when="signed-out"><Redirect to="/" /></Show>
    </>
  );
}

const page = (C: () => ReactNode) => () => <Gated><C /></Gated>;
const GuideRoute = page(Guide);
const DashboardRoute = page(Dashboard);
const InventoryRoute = page(Inventory);
const BlueprintRoute = page(Blueprint);
const SafeguardsRoute = page(Safeguards);
const ApprovalsRoute = page(Approvals);

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  useEffect(() => {
    const titles: Record<string, string> = {
      "/": "Client Communications",
      "/guide": "How to Use",
      "/dashboard": "Readiness",
      "/inventory": "FUB Field Inventory",
      "/blueprint": "Communication Blueprint",
      "/safeguards": "Safeguards",
      "/approvals": "Approvals",
    };
    document.title = `${titles[location] ?? "Secure Access"} | The Oldham Group`;
  }, [location]);
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: 'Sign in to OG Client Communications', subtitle: 'Internal access for The Oldham Group' } },
        signUp: { start: { title: 'Request workspace access', subtitle: 'An owner must authorize your account afterward' } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route path="/guide" component={GuideRoute} />
              <Route path="/dashboard" component={DashboardRoute} />
              <Route path="/inventory" component={InventoryRoute} />
              <Route path="/blueprint" component={BlueprintRoute} />
              <Route path="/safeguards" component={SafeguardsRoute} />
              <Route path="/approvals" component={ApprovalsRoute} />
              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
