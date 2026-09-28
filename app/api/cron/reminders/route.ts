import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { currentMember } from "@/lib/auth";
import { sendReminders } from "@/lib/notify";

export const dynamic = "force-dynamic";

function bearerOk(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization") ?? "";
  if (!secret || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7)), want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Daily vote reminders. Vercel Cron calls this (see vercel.json) with "Authorization: Bearer $CRON_SECRET";
 * a signed-in admin can also open it in the browser to run the schedule by hand.
 */
export async function GET(req: NextRequest) {
  if (!bearerOk(req) && !(await currentMember())?.is_admin) return new NextResponse("Unauthorized", { status: 401 });
  const result = await sendReminders();
  return NextResponse.json({ ok: true, ...result });
}
