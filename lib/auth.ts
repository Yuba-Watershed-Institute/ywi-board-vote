import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "crypto";
import { one, q, audit, type Member } from "./db";
import { sendMail } from "./mail";

const COOKIE = "ywi_board_session";
const SESSION_DAYS = 30;
const LINK_MINUTES = 20;

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET must be set (16+ chars)");
  return new TextEncoder().encode(s);
}

export function appUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3000";
}

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

/** Step 1: member enters email. Only emails already on the roster get a link. */
export async function requestMagicLink(rawEmail: string): Promise<{ ok: true; debugLink?: string } | { ok: false; reason: string }> {
  const email = rawEmail.trim().toLowerCase();
  const member = await one<Member>("SELECT * FROM members WHERE lower(email) = $1 AND active", [email]);
  if (!member) {
    await audit(email, "login_denied", "email not on roster");
    return { ok: false, reason: "That address isn't on the board roster. Ask Chris to add it." };
  }
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + LINK_MINUTES * 60_000);
  await q("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES ($1,$2,$3)", [sha256(token), email, expires]);
  await q("DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'");
  const link = `${appUrl()}/auth?token=${token}`;
  const sent = await sendMail({
    to: email,
    subject: "Your YWI board voting link",
    text: `Hi ${member.name},\n\nClick to sign in and vote (link expires in ${LINK_MINUTES} minutes, single use):\n\n${link}\n\nIf you didn't request this, ignore this email.\n\nYuba Watershed Institute`,
  });
  await audit(email, "login_link_sent", sent.delivered ? "emailed" : "not emailed (no mail config)");
  return { ok: true, debugLink: sent.delivered ? undefined : link };
}

/** Step 2: token from the link is exchanged for a session cookie. */
export async function consumeMagicLink(token: string): Promise<Member | null> {
  const row = await one<{ email: string }>(
    `UPDATE login_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING email`,
    [sha256(token)],
  );
  if (!row) return null;
  const member = await one<Member>("SELECT * FROM members WHERE lower(email) = $1 AND active", [row.email]);
  if (!member) return null;
  const jwt = await new SignJWT({ sub: String(member.id), email: member.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
  (await cookies()).set(COOKIE, jwt, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: SESSION_DAYS * 86400,
  });
  await audit(member.email, "login");
  return member;
}

export async function currentMember(): Promise<Member | null> {
  const jwt = (await cookies()).get(COOKIE)?.value;
  if (!jwt) return null;
  try {
    const { payload } = await jwtVerify(jwt, secret());
    const id = Number(payload.sub);
    return await one<Member>("SELECT * FROM members WHERE id = $1 AND active", [id]);
  } catch {
    return null;
  }
}

export async function requireMember(): Promise<Member> {
  const m = await currentMember();
  if (!m) throw new Error("UNAUTHENTICATED");
  return m;
}

export async function requireAdmin(): Promise<Member> {
  const m = await requireMember();
  if (!m.is_admin) throw new Error("FORBIDDEN");
  return m;
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
}
