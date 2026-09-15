import { NextResponse, type NextRequest } from "next/server";
import { consumeMagicLink } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const member = token ? await consumeMagicLink(token) : null;
  const dest = member ? "/motions" : "/?error=expired";
  return NextResponse.redirect(new URL(dest, req.nextUrl.origin));
}
