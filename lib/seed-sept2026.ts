import type { Pool } from "pg";
import type { RosterEntry } from "./db";

/**
 * One-time import of the four motions that were put to the board by email in September 2026
 * (Gmail thread "meeting minutes, new board members", Sept 7-12, 2026), so the board can finish
 * voting here instead of re-entering anything.
 *
 * Only explicit votes from the thread are recorded. Moving or seconding is not treated as a vote.
 * Rob's "Yes x 3" is recorded on Mathieu, Corinne and the August minutes; April is left for him.
 * Imported votes carry source = 'email' and show as such in the app and on the PDF.
 *
 * Runs once: it checks the audit log for a prior import and does nothing if found.
 */

const T = {
  summary: "2026-09-07T17:06:06Z",     // Daniel's summary email (10:06 AM PT)
  kurtSecondsMinutes: "2026-09-07T17:21:37Z",
  danielVotes: "2026-09-07T17:29:40Z",
  robVotes: "2026-09-08T20:26:45Z",
  beckyVotes: "2026-09-11T00:22:56Z",
};

// Directors are referenced by roster key (see BOARD_ROSTER in lib/db.ts), not by email.
const E = { daniel: "daniel", kurt: "kurt", ann: "ann", rob: "rob", becky: "becky", amber: "amber" };

const IMPORTED_ON = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "long" });
const SOURCE_NOTE = "Motion made by email. Summarized by Daniel Nicholson on Sept 7, 2026 in the board thread \"meeting minutes, new board members\"; votes below were cast in that thread and imported here on " + IMPORTED_ON + ". Daniel proposed on Sept 12 that all four motions be ratified as the first agenda item of the next board meeting.";

type SeedMotion = {
  key: string; title: string; body: string;
  mover: string; seconder: string; moved_at: string; seconded_at: string;
  votes: Array<[string, "aye" | "nay" | "abstain", string]>;
};

const MOTIONS: SeedMotion[] = [
  {
    key: "mathieu",
    title: "Invite Mathieu to join the YWI Board of Directors",
    body: SOURCE_NOTE,
    mover: E.amber, seconder: E.kurt, moved_at: T.summary, seconded_at: T.summary,
    votes: [[E.daniel, "aye", T.danielVotes], [E.rob, "aye", T.robVotes], [E.becky, "aye", T.beckyVotes]],
  },
  {
    key: "corinne",
    title: "Invite Corinne to join the YWI Board of Directors",
    body: SOURCE_NOTE,
    mover: E.kurt, seconder: E.ann, moved_at: T.summary, seconded_at: T.summary,
    votes: [[E.daniel, "aye", T.danielVotes], [E.rob, "aye", T.robVotes], [E.becky, "aye", T.beckyVotes]],
  },
  {
    key: "aug-minutes",
    title: "Approve the minutes of the August 2026 YWI Board meeting",
    body: SOURCE_NOTE,
    mover: E.daniel, seconder: E.kurt, moved_at: T.summary, seconded_at: T.kurtSecondsMinutes,
    votes: [[E.daniel, "aye", T.danielVotes], [E.rob, "aye", T.robVotes], [E.becky, "aye", T.beckyVotes]],
  },
  {
    key: "apr-minutes",
    title: "Approve the minutes of the April 2026 YWI Board meeting",
    body: SOURCE_NOTE + " Becky noted she was not at the April meeting and did not vote on these minutes. Rob's \"Yes x 3\" was not applied here; he can record his vote directly.",
    mover: E.daniel, seconder: E.kurt, moved_at: T.summary, seconded_at: T.kurtSecondsMinutes,
    votes: [[E.daniel, "aye", T.danielVotes]],
  },
];

export async function importSept2026(pool: Pool, roster: RosterEntry[]): Promise<void> {
  const done = await pool.query("SELECT 1 FROM audit_log WHERE action = 'import_sept2026' LIMIT 1");
  if (done.rowCount) return;
  // Resolve roster keys to email addresses. Without BOARD_ROSTER we can't, so try again next start.
  const emailByKey = new Map(roster.map((r) => [r.key, r.email.trim().toLowerCase()]));
  const keys = Object.values(E);
  if (keys.some((k) => !emailByKey.has(k))) {
    console.warn("import_sept2026: BOARD_ROSTER missing or lacks keys; import deferred");
    return;
  }
  const emailOf = (key: string) => emailByKey.get(key)!;

  const { rows: members } = await pool.query<{ id: number; email: string; name: string }>(
    "SELECT id, email, name FROM members WHERE lower(email) = ANY($1)", [keys.map(emailOf)]);
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const missing = keys.map(emailOf).filter((e) => !byEmail.has(e));
  if (missing.length) {
    // Roster changed before import ran; record and skip rather than half-import.
    await pool.query("INSERT INTO audit_log (actor, action, detail) VALUES ('system','import_sept2026_skipped',$1)",
      [`missing roster emails: ${missing.join(", ")}`]);
    return;
  }
  const member = (key: string) => byEmail.get(emailOf(key))!;
  const display = (key: string) => member(key).name.replace(/\s*\(.*\)\s*$/, "");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const m of MOTIONS) {
      const mover = member(m.mover), seconder = member(m.seconder);
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO motions (title, body, status, drafted_by, drafted_at, created_by,
                              moved_by, moved_by_id, moved_at, seconded_by, seconded_by_id, seconded_at, opened_at)
         VALUES ($1,$2,'open',$3,$4,$3,$5,$3,$4,$6,$7,$8,$8) RETURNING id`,
        [m.title, m.body, mover.id, m.moved_at, display(m.mover), display(m.seconder), seconder.id, m.seconded_at],
      );
      const id = rows[0].id;
      for (const [key, choice, at] of m.votes) {
        await client.query(
          "INSERT INTO votes (motion_id, member_id, choice, cast_at, source) VALUES ($1,$2,$3,$4,'email')",
          [id, member(key).id, choice, at]);
      }
      await client.query("INSERT INTO audit_log (actor, action, detail) VALUES ('system','motion_imported',$1)",
        [`#${id} ${m.title} (${m.votes.length} email votes)`]);
    }
    await client.query("INSERT INTO audit_log (actor, action, detail) VALUES ('system','import_sept2026','four motions from the Sept 7-12, 2026 email thread')");
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
