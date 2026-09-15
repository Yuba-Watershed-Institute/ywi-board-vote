import { NextResponse, type NextRequest } from "next/server";
import { signOut } from "@/lib/auth";

export async function GET(req: NextRequest) {
  await signOut();
  return NextResponse.redirect(new URL("/", req.nextUrl.origin));
}
