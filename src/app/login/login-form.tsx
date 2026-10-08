// Submits the passphrase to the sign-in server action and shows its error inline.
// The pending state disables the button so a double click can't submit twice.
"use client";

import { LogIn } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { signIn, type SignInState } from "./actions";

const initialState: SignInState = { error: null };

export function LoginForm({ nextPath }: { nextPath: string }) {
  const [state, action, pending] = useActionState(signIn, initialState);
  return (
    <form action={action} className="mt-5 space-y-3">
      <input name="next" type="hidden" value={nextPath} />
      <div>
        <label className="text-xs font-medium" htmlFor="password">
          Passphrase
        </label>
        <input
          aria-describedby={state.error ? "password-error" : undefined}
          aria-invalid={state.error ? true : undefined}
          autoComplete="current-password"
          autoFocus
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-2 focus:ring-accent/25"
          id="password"
          name="password"
          required
          type="password"
        />
        {state.error ? (
          <p
            className="mt-1.5 text-xs text-danger"
            id="password-error"
            role="alert"
          >
            {state.error}
          </p>
        ) : null}
      </div>
      <Button className="w-full" disabled={pending} id="sign-in" type="submit">
        <LogIn className="size-4" />
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
