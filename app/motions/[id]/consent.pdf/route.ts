import { NextResponse, type NextRequest } from "next/server";
import { currentMember } from "@/lib/auth";
import { getMotion } from "@/lib/motions";
import { writtenConsentFilename, writtenConsentPdf } from "@/lib/pdf";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await currentMember();
  if (!member) return NextResponse.redirect(new URL("/", _req.nextUrl.origin));
  const { id } = await ctx.params;
  const m = await getMotion(Number(id));
  if (!m) return new NextResponse("Not found", { status: 404 });
  const bytes = await writtenConsentPdf(m);
  const filename = writtenConsentFilename(m);
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
