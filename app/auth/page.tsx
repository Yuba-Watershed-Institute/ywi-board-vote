import { redirect } from "next/navigation";
import { currentMember, peekMagicLink } from "@/lib/auth";
import { completeLoginAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * The sign-in link from the email lands here. Opening this page does NOT consume the token:
 * mail providers (Outlook/live.com Safe Links, Gmail, corporate filters) fetch every link in an
 * incoming message with GET/HEAD to scan it, which used to burn the single-use token before the
 * member ever clicked. The token is only exchanged for a session when the member presses the
 * button below, which submits a POST that scanners never make.
 */
export default async function AuthPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  if (await currentMember()) redirect("/motions");
  const { token } = await searchParams;
  if (!token || !(await peekMagicLink(token))) redirect("/?error=expired");
  return (
    <>
      <h1>Almost there</h1>
      <p className="muted">Press the button to finish signing in. This link works once and expires 20 minutes after it was requested.</p>
      <div className="card">
        <form action={completeLoginAction} className="stack">
          <input type="hidden" name="token" value={token} />
          <div><button className="primary" type="submit">Sign in and go to the motions</button></div>
        </form>
      </div>
    </>
  );
}
