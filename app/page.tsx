import { redirect } from "next/navigation";
import { currentMember } from "@/lib/auth";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const member = await currentMember();
  if (member) redirect("/motions");
  const { error } = await searchParams;
  return (
    <>
      <h1>Sign in to vote</h1>
      <p className="muted">Enter the email address the board has on file. We&apos;ll send you a one-time sign-in link; no password needed.</p>
      {error === "expired" && <div className="notice err">That link has expired or was already used. Request a new one below.</div>}
      <div className="card"><LoginForm /></div>
      <p className="muted small">Votes recorded here are documented as written consents of the directors and filed with the board minutes.</p>
    </>
  );
}
