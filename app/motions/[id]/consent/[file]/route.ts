import { NextResponse, type NextRequest } from "next/server";
import { currentMember } from "@/lib/auth";
import { getMotion } from "@/lib/motions";
import { writtenConsentFilename, writtenConsentPdf } from "@/lib/pdf";

export const dynamic = "force-dynamic";

/**
 * GET /motions/:id/consent/:file. The file segment is decorative (the name is recomputed here); it is in
 * the URL so that browsers naming a saved PDF after the URL get the right name. Served as an attachment,
 * not inline, so the Content-Disposition name is honoured too.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; file: string }> }) {
  const member = await currentMember();
  if (!member) return NextResponse.redirect(new URL("/", req.nextUrl.origin));
  const { id } = await ctx.params;
  const m = await getMotion(Number(id));
  if (!m) return new NextResponse("Not found", { status: 404 });
  const bytes = await writtenConsentPdf(m);
  const filename = writtenConsentFilename(m);
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\x20-\x7e]|"/g, "")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
