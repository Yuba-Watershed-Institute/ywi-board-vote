import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { currentMember } from "@/lib/auth";

export const metadata: Metadata = {
  title: "YWI Board Votes",
  description: "Yuba Watershed Institute board voting between meetings",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let member = null;
  try { member = await currentMember(); } catch { /* DB not reachable; pages will surface it */ }
  return (
    <html lang="en">
      <body>
        <main>
          <header className="top">
            <Link className="brand" href="/">YWI Board Votes<small>Yuba Watershed Institute</small></Link>
            <nav>
              {member ? (
                <>
                  <Link href="/motions">Motions</Link>
                  {member.is_admin && <Link href="/admin">Admin</Link>}
                  <span>{member.name.split(" (")[0]}</span>
                  <a href="/signout">Sign out</a>
                </>
              ) : (
                <Link href="/">Sign in</Link>
              )}
            </nav>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
