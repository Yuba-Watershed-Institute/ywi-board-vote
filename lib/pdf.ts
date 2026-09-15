import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { MotionDetail } from "./motions";

const TZ = "America/Los_Angeles";
function fmt(d: Date | string | null): string {
  if (!d) return "";
  return new Date(d).toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }) + " PT";
}
function fmtDate(d: Date | string | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { timeZone: TZ, dateStyle: "long" });
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(trial, size) > width && line) { out.push(line); line = w; }
      else line = trial;
    }
    out.push(line);
  }
  return out;
}

export async function writtenConsentPdf(m: MotionDetail): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 60;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const grey = rgb(0.35, 0.35, 0.35);

  const line = (txt: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number; x?: number } = {}) => {
    const size = opts.size ?? 10.5;
    const f = opts.font ?? font;
    if (y < M + size) { page = doc.addPage([W, H]); y = H - M; }
    page.drawText(txt, { x: opts.x ?? M, y, size, font: f, color: opts.color ?? rgb(0, 0, 0) });
    y -= size + (opts.gap ?? 4);
  };
  const para = (txt: string, size = 10.5, f = font) => {
    for (const l of wrap(txt, f, size, W - 2 * M)) line(l, { size, font: f });
  };
  const rule = () => { y -= 4; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: grey }); y -= 12; };

  line("Yuba Watershed Institute", { size: 9, color: grey, gap: 2 });
  line("Board of Directors", { size: 9, color: grey, gap: 10 });
  line(m.unanimous ? "Unanimous Written Consent of the Board of Directors" : "Record of Board Vote Taken by Electronic Ballot", { size: 15, font: bold, gap: 6 });
  line(`Action without a meeting. Motion #${m.id}. Record generated ${fmt(new Date())}.`, { size: 9, color: grey, gap: 10 });
  rule();

  line("Motion", { size: 11, font: bold, gap: 6 });
  para(m.title, 11, bold);
  if (m.body) { y -= 2; para(m.body); }
  y -= 4;
  if (m.drafter_name && m.drafted_by !== m.moved_by_id) {
    line(`Drafted by ${m.drafter_name}, ${fmt(m.drafted_at)}${m.amended ? "; wording amended by the mover" : ""}`, { size: 10, color: grey });
  }
  line(`Moved by ${m.moved_by || "—"}${m.moved_at ? `, ${fmt(m.moved_at)}` : ""}`, { size: 10, color: grey });
  line(`Seconded by ${m.seconded_by || "—"}${m.seconded_at ? `, ${fmt(m.seconded_at)}` : ""}`, { size: 10, color: grey });
  line(`Ballot opened: ${m.opened_at ? fmt(m.opened_at) : "not yet"}`, { size: 10, color: grey });
  if (m.closes_at) line(`Voting deadline: ${fmt(m.closes_at)}`, { size: 10, color: grey });
  line(`Ballot closed: ${m.closed_at ? fmt(m.closed_at) : "still open"}`, { size: 10, color: grey, gap: 10 });
  rule();

  line("Votes of the directors", { size: 11, font: bold, gap: 8 });
  const cols = { name: M, vote: M + 230, at: M + 320 };
  page.drawText("Director", { x: cols.name, y, size: 9, font: bold, color: grey });
  page.drawText("Vote", { x: cols.vote, y, size: 9, font: bold, color: grey });
  page.drawText("Recorded", { x: cols.at, y, size: 9, font: bold, color: grey });
  y -= 16;
  for (const v of m.voters) {
    if (y < M + 20) { page = doc.addPage([W, H]); y = H - M; }
    const choice = v.choice ? v.choice.toUpperCase() : "No vote recorded";
    page.drawText(v.name, { x: cols.name, y, size: 10.5, font });
    page.drawText(choice, { x: cols.vote, y, size: 10.5, font: v.choice ? bold : font, color: v.choice ? rgb(0, 0, 0) : grey });
    page.drawText(v.cast_at ? fmt(v.cast_at) + (v.source === "email" ? " (by email)" : "") : "", { x: cols.at, y, size: 9.5, font, color: grey });
    y -= 17;
  }
  y -= 4; rule();

  const t = m.tally;
  line(`Tally: ${t.aye} aye, ${t.nay} nay, ${t.abstain} abstain, ${t.pending} not voting, of ${t.total} directors entitled to vote.`, { size: 10.5, font: bold, gap: 8 });
  if (m.unanimous) {
    para("All directors entitled to vote consented in writing to the action above. Under California Corporations Code section 5211(b), an action taken by unanimous written consent has the same force and effect as a unanimous vote at a meeting of the board. This record shall be filed with the minutes of the board.");
  } else {
    para("This vote was not unanimous among all directors entitled to vote, or not every director recorded a vote. Under California Corporations Code section 5211(b), board action taken without a meeting requires the written consent of all directors. This record documents the directors' expressed positions; the action should be placed on the agenda and ratified at the next duly noticed meeting of the board, and this record filed with those minutes.");
  }
  y -= 10;
  line("Secretary's attestation", { size: 11, font: bold, gap: 8 });
  const byEmail = m.voters.some((v) => v.source === "email");
  para(byEmail
    ? "I certify that the above is a true record of the votes cast by the directors of the Yuba Watershed Institute. Votes marked \"by email\" were cast in the board's email correspondence and transcribed into the electronic voting system; the remainder were cast in the system by directors signed in with a one-time link sent to the email address on file."
    : "I certify that the above is a true record of the votes cast by the directors of the Yuba Watershed Institute through the board's electronic voting system, each director having signed in with a one-time link sent to the email address on file.");
  y -= 24;
  page.drawLine({ start: { x: M, y }, end: { x: M + 230, y }, thickness: 0.6 });
  page.drawLine({ start: { x: M + 280, y }, end: { x: M + 420, y }, thickness: 0.6 });
  y -= 12;
  line("Secretary", { size: 9, color: grey, gap: 0 });
  page.drawText("Date", { x: M + 280, y: y + 9, size: 9, font, color: grey });
  y -= 6;
  page.drawText(`Filed with minutes of the meeting held: ____________________  (${fmtDate(new Date())})`, { x: M, y: y - 14, size: 9, font, color: grey });

  return doc.save();
}
