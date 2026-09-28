import { q, audit } from "./db";
import { sendMail, sendMailBatch } from "./mail";
import { appUrl } from "./auth";
import { writtenConsentPdf } from "./pdf";
import type { MotionDetail } from "./motions";

const TZ = "America/Los_Angeles";
const fmt = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }) + " PT" : "";
const short = (title: string) => (title.length > 80 ? title.slice(0, 77) + "..." : title);
const plainName = (name: string) => name.replace(/\s*\(.*\)\s*$/, "");
const days = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Every active roster member, plus anyone in ADMIN_EMAILS even if not on the roster, deduplicated. */
async function closedNoticeRecipients(): Promise<string[]> {
  const rows = await q<{ email: string }>("SELECT email FROM members WHERE active ORDER BY name");
  const admins = (process.env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of [...rows.map((r) => r.email), ...admins]) {
    const key = email.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(email); }
  }
  return out;
}

/**
 * Emails the whole active roster (directors and non-voting members alike) and the admins that a vote
 * has closed: the result, the tally, each director's vote, and the written-consent PDF for the minutes
 * file. `how` says who or what closed it. Called after the motion is already closed; a mail failure
 * is logged and never undoes the close.
 */
export async function sendClosedNotice(m: MotionDetail, how: string): Promise<void> {
  const recipients = await closedNoticeRecipients();
  if (recipients.length === 0) return;
  const link = `${appUrl()}/motions/${m.id}`;
  const t = m.tally;
  const result = m.unanimous
    ? "Unanimous written consent: valid board action."
    : t.aye > t.nay
      ? "Passed, but not by unanimous written consent (a nay, an abstention, or a director who did not vote). Place it on the agenda for ratification at the next noticed board meeting."
      : "Did not pass.";
  const votes = m.voters
    .map((v) => `  ${v.name}: ${v.choice ? v.choice : "no vote recorded"}${v.source === "email" ? " (by email)" : ""}`)
    .join("\n");
  const text =
    `Voting closed ${fmt(m.closed_at)} (${how}) on this motion:\n\n` +
    `${m.title}\n\n` +
    `Result: ${result}\n` +
    `Tally: ${t.aye} aye, ${t.nay} nay, ${t.abstain} abstain, ${t.pending} not voting, of ${t.total} directors entitled to vote.\n\n` +
    `Votes:\n${votes}\n\n` +
    `The written-consent record is attached, and the motion is at:\n${link}\n\n` +
    `Yuba Watershed Institute`;
  try {
    const pdf = await writtenConsentPdf(m);
    const stamp = new Date(m.closed_at ?? new Date()).toLocaleDateString("en-CA", { timeZone: TZ });
    const safe = m.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60);
    const sent = await sendMail({
      to: recipients,
      subject: `Vote closed: ${short(m.title)}`,
      text,
      attachments: [{ filename: `${stamp}_written-consent_${safe}.pdf`, content: Buffer.from(pdf) }],
    });
    await audit("system", "closed_notice_sent", `#${m.id} to ${recipients.length} members${sent.delivered ? "" : " (not emailed: no mail config)"}`);
  } catch (err) {
    await audit("system", "mail_failed", `#${m.id} closed notice: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Kind = "vote" | "second";
type Pending = {
  kind: Kind; motion_id: number; title: string; since: Date; closes_at: Date | null; moved_by: string;
  member_id: number; name: string; email: string; last_reminded: Date | null;
};

export type ReminderResult = { emailed: Array<{ email: string; motions: number[] }>; delivered: boolean };

/**
 * Emails each voting director one message listing what is waiting on them: open motions they have
 * not voted on, and moved motions (by someone else) that still need a second.
 *
 * On the daily schedule a director is reminded about an item once it has been waiting for
 * REMINDER_AFTER_DAYS (default 2, counted from when voting opened or the motion was moved), and again
 * every REMINDER_EVERY_DAYS (default 3) while it still waits on them. Open motions whose deadline has
 * passed are skipped: voting is locked until an admin closes or extends them. With `force` (the
 * admin's button on the motion page) the timing rules are ignored and everyone the motion waits on
 * is reminded now.
 */
export async function sendReminders(opts: { motionId?: number; force?: boolean; now?: Date } = {}): Promise<ReminderResult> {
  const now = opts.now ?? new Date();
  const rows = await q<Pending>(
    `SELECT 'vote' AS kind, mo.id AS motion_id, mo.title, mo.opened_at AS since, mo.closes_at, mo.moved_by,
            m.id AS member_id, m.name, m.email,
            (SELECT max(r.sent_at) FROM vote_reminders r WHERE r.motion_id = mo.id AND r.member_id = m.id AND r.kind = 'vote') AS last_reminded
       FROM motions mo
       CROSS JOIN members m
       LEFT JOIN votes v ON v.motion_id = mo.id AND v.member_id = m.id
      WHERE mo.status = 'open' AND v.choice IS NULL
        AND m.active AND m.is_voting
        AND (mo.closes_at IS NULL OR mo.closes_at > $2)
        AND ($1::int IS NULL OR mo.id = $1)
     UNION ALL
     SELECT 'second' AS kind, mo.id AS motion_id, mo.title, mo.moved_at AS since, mo.closes_at, mo.moved_by,
            m.id AS member_id, m.name, m.email,
            (SELECT max(r.sent_at) FROM vote_reminders r WHERE r.motion_id = mo.id AND r.member_id = m.id AND r.kind = 'second') AS last_reminded
       FROM motions mo
       CROSS JOIN members m
      WHERE mo.status = 'moved'
        AND m.active AND m.is_voting AND m.id IS DISTINCT FROM mo.moved_by_id
        AND ($1::int IS NULL OR mo.id = $1)
     ORDER BY name, since`,
    [opts.motionId ?? null, now],
  );

  const afterMs = days("REMINDER_AFTER_DAYS", 2) * 86400_000;
  const everyMs = days("REMINDER_EVERY_DAYS", 3) * 86400_000;
  const due = opts.force
    ? rows
    : rows.filter((r) =>
        now.getTime() - new Date(r.since).getTime() >= afterMs &&
        (!r.last_reminded || now.getTime() - new Date(r.last_reminded).getTime() >= everyMs));
  if (due.length === 0) return { emailed: [], delivered: true };

  // One email per director, however many items are waiting on them.
  const byMember = new Map<number, Pending[]>();
  for (const r of due) byMember.set(r.member_id, [...(byMember.get(r.member_id) ?? []), r]);

  const base = appUrl();
  const mails = [...byMember.values()].map((list) => {
    const { name, email } = list[0];
    const votes = list.filter((r) => r.kind === "vote");
    const seconds = list.filter((r) => r.kind === "second");
    const sections: string[] = [];
    if (votes.length) {
      sections.push(
        `You haven't voted yet on ${votes.length === 1 ? "this motion" : "these motions"}:\n\n` +
        votes.map((r) => `  - ${r.title}\n    Open since ${fmt(r.since)}${r.closes_at ? `; deadline ${fmt(r.closes_at)}` : ""}\n    ${base}/motions/${r.motion_id}`).join("\n\n"));
    }
    if (seconds.length) {
      sections.push(
        `${seconds.length === 1 ? "This motion is" : "These motions are"} waiting for a second. Any director other than the mover can second, which opens voting:\n\n` +
        seconds.map((r) => `  - ${r.title}\n    Moved by ${r.moved_by} ${fmt(r.since)}\n    ${base}/motions/${r.motion_id}`).join("\n\n"));
    }
    const subject =
      votes.length && seconds.length ? "Reminder: board motions are waiting for your vote or a second"
      : votes.length ? (votes.length === 1 ? "Reminder: a board motion is waiting for your vote" : `Reminder: ${votes.length} board motions are waiting for your vote`)
      : (seconds.length === 1 ? "Reminder: a board motion needs a second" : `Reminder: ${seconds.length} board motions need a second`);
    return {
      to: email,
      subject,
      text:
        `Hi ${plainName(name)},\n\n${sections.join("\n\n")}\n\n` +
        `To ${votes.length && seconds.length ? "vote or second" : votes.length ? "vote" : "second"}, enter your email at ${base} and press the button in the sign-in link you receive. ` +
        `Any vote can be changed until the motion closes.\n\n` +
        `If you already sent your vote to the board by email, you can ignore this; an admin will record it.\n\n` +
        `Yuba Watershed Institute`,
    };
  });

  const sent = await sendMailBatch(mails);
  for (const r of due) {
    await q("INSERT INTO vote_reminders (motion_id, member_id, kind, sent_at) VALUES ($1,$2,$3,$4)", [r.motion_id, r.member_id, r.kind, now]);
  }
  const emailed = [...byMember.values()].map((list) => ({ email: list[0].email, motions: [...new Set(list.map((r) => r.motion_id))] }));
  await audit(
    "system",
    "reminders_sent",
    [...byMember.values()].map((list) => `${list[0].email} (${list.map((r) => `#${r.motion_id} ${r.kind}`).join(", ")})`).join("; ") + (sent.delivered ? "" : " (not emailed: no mail config)"),
  );
  return { emailed, delivered: sent.delivered };
}
