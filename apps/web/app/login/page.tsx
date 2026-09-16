import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { ShaderBackdrop } from "@/components/auth/shader-backdrop";

export const metadata: Metadata = {
  title: "Sign in | Open Analytics",
};

/**
 * A signed-in visitor is sent on before this page paints, but not from here:
 * the script that does it ships from the root layout, because a `<script>`
 * rendered inside a page is never executed on a client-side navigation. See
 * `SESSION_HINT_SCRIPT` in `lib/session-hint.ts`.
 *
 * `LoginForm` still holds the slower half of the same job — a confirmed
 * session moves anyone, hint or no hint.
 */

/** `?error=access_denied` → `"access_denied"`; a repeated parameter takes its
 * first value rather than becoming the string `"a,b"`. */
function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * `?next=`: where to land after signing in, when somewhere other than the
 * dashboard sent the person here. Today that is one route: the invite
 * acceptance page, which puts its own URL (token and all) in `next` so the
 * sign-in round trip ends back on the invitation instead of on a dashboard
 * with a "now open the email link again" step.
 *
 * Validated here, on the server, before the client ever sees it, because the
 * value ends up in `router.replace` and in the `callbackURL` handed to the
 * auth provider: only a same-origin relative path may pass. `//host` is a
 * scheme-relative URL and `/\host` is the same trick in the one browser
 * quirk that treats a backslash as a slash; both are refused along with
 * anything not starting at `/`. An invalid value degrades to the dashboard
 * rather than to an error, and the person still signs in.
 */
function safeNext(value: string | null): string | null {
  if (value === null) return null;
  return /^\/(?![/\\])/.test(value) ? value : null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // The only door: there is no sign-up screen, by product decision. Google and
  // GitHub create the account on their first callback, so a first-time visitor
  // and a returning one arrive here alike.
  //
  // Two things arrive in the query string, and both are read here rather than in
  // the client: a failed provider sign-in (`?error=`) and a completed email
  // verification (`?verified=1`). The client alternatives are `useSearchParams()`
  // (which would push the form to client-side rendering behind a Suspense
  // fallback) and reading `window.location` in a state initializer, which
  // renders one thing on the server and another in the browser. Reading them
  // here makes the route dynamic, which is honest — its content depends on the
  // query string.
  const params = await searchParams;

  return (
    <main className="relative flex min-h-svh flex-1 items-center justify-center overflow-hidden bg-[#f6f6f6] px-4 py-12">
      <ShaderBackdrop />
      <div className="relative">
        <LoginForm
          next={safeNext(first(params.next))}
          oauthError={first(params.error)}
          oauthErrorDescription={first(params.error_description)}
          verified={first(params.verified) === "1"}
        />
      </div>
    </main>
  );
}
