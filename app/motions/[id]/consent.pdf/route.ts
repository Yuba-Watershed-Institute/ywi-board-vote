import { NextResponse, type NextRequest } from "next/server";
import { currentMember } from "@/lib/auth";
import { getMotion } from "@/lib/motions";
import { writtenConsentPdf } from "@/lib/pdf";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await currentMember();
  if (!member) return NextResponse.redirect(new URL("/", _req.nextUrl.origin));
  const { id } = await ctx.params;
  const m = await getMotion(Number(id));
  if (!m) return new NextResponse("Not found", { status: 404 });
  const bytes = await writtenConsentPdf(m);
  const safe = m.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60);
  const date = (m.closed_at ?? m.opened_at ?? m.drafted_at);
  const stamp = new Date(date).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${stamp}_written-consent_${safe}.pdf"`,
    },
  });
}
