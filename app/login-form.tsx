"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";

type State = { error?: string; sent?: boolean; debugLink?: string } | null;

export default function LoginForm() {
  const [state, action, pending] = useActionState<State, FormData>(loginAction, null);
  if (state?.sent) {
    return (
      <div>
        <div className="notice ok">Check your email for the sign-in link. It expires in 20 minutes.</div>
        {state.debugLink && (
          <div className="notice">Email isn&apos;t configured on this server, so here is the link directly:<br /><a href={state.debugLink}><code>{state.debugLink}</code></a></div>
        )}
      </div>
    );
  }
  return (
    <form action={action} className="stack">
      <label>Email address
        <input type="email" name="email" required autoComplete="email" placeholder="you@example.com" />
      </label>
      {state?.error && <div className="notice err">{state.error}</div>}
      <div><button className="primary" type="submit" disabled={pending}>{pending ? "Sending…" : "Send me a sign-in link"}</button></div>
    </form>
  );
}
