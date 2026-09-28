import { q, audit } from "./db";
import { sendMail, sendMailBatch } from "./mail";
import { appUrl } from "./auth";
import { writtenConsentPdf } from "./pdf";
import type { MotionDetail } from "./motions";

const TZ = "America/Los_Angeles";
const fmt = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }) + " PT" : "";
const short = (title: string) => (title.length > 80 ? title.slice(0, 77) + "..." : title);
const days = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Emails the whole active roster (directors and non-voting members alike) that a vote has closed:
 * the result, the tally, each director's vote, and the written-consent PDF for the minutes file.
 * Called after the motion is already closed; a mail failure is logged and never undoes the close.
 */
export async function sendClosedNotice(m: MotionDetail): Promise<void> {
  const recipients = await q<{ email: string }>("SELECT email FROM members WHERE active ORDER BY name");
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
    `Voting closed ${fmt(m.closed_at)} on this motion:\n\n` +
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
      to: recipients.map((r) => r.email),
      subject: `Vote closed: ${short(m.title)}`,
      text,
      attachments: [{ filename: `${stamp}_written-consent_${safe}.pdf`, content: Buffer.from(pdf) }],
    });
    await audit("system", "closed_notice_sent", `#${m.id} to ${recipients.length} members${sent.delivered ? "" : " (not emailed: no mail config)"}`);
  } catch (err) {
    await audit("system", "mail_failed", `#${m.id} closed notice: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Pending = {
  motion_id: number; title: string; opened_at: Date; closes_at: Date | null;
  member_id: number; name: string; email: string; last_reminded: Date | null;
};

export type ReminderResult = { emailed: Array<{ email: string; motions: number[] }>; delivered: boolean };

/**
 * Emails each voting director one message listing the open motions they have not voted on.
 *
 * On the daily schedule a director is reminded about a motion once it has been open for
 * REMINDER_AFTER_DAYS (default 2), and again every REMINDER_EVERY_DAYS (default 3) while they still
 * have not voted. Motions whose deadline has passed are skipped: voting is locked until an admin
 * closes or extends them. With `force` (the admin's button on the motion page) the timing rules are
 * ignored and everyone who has not voted on that motion is reminded now.
 */
export async function sendVoteReminders(opts: { motionId?: number; force?: boolean; now?: Date } = {}): Promise<ReminderResult> {
  const now = opts.now ?? new Date();
  const rows = await q<Pending>(
    `SELECT mo.id AS motion_id, mo.title, mo.opened_at, mo.closes_at,
            m.id AS member_id, m.name, m.email,
            (SELECT max(r.sent_at) FROM vote_reminders r WHERE r.motion_id = mo.id AND r.member_id = m.id) AS last_reminded
       FROM motions mo
       CROSS JOIN members m
       LEFT JOIN votes v ON v.motion_id = mo.id AND v.member_id = m.id
      WHERE mo.status = 'open' AND v.choice IS NULL
        AND m.active AND m.is_voting
        AND (mo.closes_at IS NULL OR mo.closes_at > $2)
        AND ($1::int IS NULL OR mo.id = $1)
      ORDER BY m.name, mo.opened_at`,
    [opts.motionId ?? null, now],
  );

  const afterMs = days("REMINDER_AFTER_DAYS", 2) * 86400_000;
  const everyMs = days("REMINDER_EVERY_DAYS", 3) * 86400_000;
  const due = opts.force
    ? rows
    : rows.filter((r) =>
        now.getTime() - new Date(r.opened_at).getTime() >= afterMs &&
        (!r.last_reminded || now.getTime() - new Date(r.last_reminded).getTime() >= everyMs));
  if (due.length === 0) return { emailed: [], delivered: true };

  // One email per director, however many motions are waiting on them.
  const byMember = new Map<number, Pending[]>();
  for (const r of due) byMember.set(r.member_id, [...(byMember.get(r.member_id) ?? []), r]);

  const base = appUrl();
  const mails = [...byMember.values()].map((list) => {
    const { name, email } = list[0];
    const n = list.length;
    const items = list
      .map((r) => `  - ${r.title}\n    Open since ${fmt(r.opened_at)}${r.closes_at ? `; deadline ${fmt(r.closes_at)}` : ""}\n    ${base}/motions/${r.motion_id}`)
      .join("\n\n");
    return {
      to: email,
      subject: n === 1 ? `Reminder: a board motion is waiting for your vote` : `Reminder: ${n} board motions are waiting for your vote`,
      text:
        `Hi ${name.replace(/\s*\(.*\)\s*$/, "")},\n\n` +
        `You haven't voted yet on ${n === 1 ? "this motion" : "these motions"}:\n\n${items}\n\n` +
        `To vote, enter your email at ${base} and press the button in the sign-in link you receive. ` +
        `Any vote can be changed until the motion closes.\n\n` +
        `If you already sent your vote to the board by email, you can ignore this; an admin will record it.\n\n` +
        `Yuba Watershed Institute`,
    };
  });

  const sent = await sendMailBatch(mails);
  for (const r of due) {
    await q("INSERT INTO vote_reminders (motion_id, member_id, sent_at) VALUES ($1,$2,$3)", [r.motion_id, r.member_id, now]);
  }
  const emailed = [...byMember.values()].map((list) => ({ email: list[0].email, motions: list.map((r) => r.motion_id) }));
  await audit(
    "system",
    "reminders_sent",
    emailed.map((e) => `${e.email} (${e.motions.map((id) => `#${id}`).join(", ")})`).join("; ") + (sent.delivered ? "" : " (not emailed: no mail config)"),
  );
  return { emailed, delivered: sent.delivered };
}
