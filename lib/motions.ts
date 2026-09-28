import { q, one, audit, type Motion, type Member, type Vote } from "./db";
import { sendMail } from "./mail";
import { appUrl } from "./auth";
import { sendClosedNotice } from "./notify";

export type MotionDetail = Motion & {
  drafter_name: string | null;
  voters: Array<Member & { choice: Vote["choice"] | null; cast_at: Date | null; source: Vote["source"] | null }>;
  tally: { aye: number; nay: number; abstain: number; pending: number; total: number };
  unanimous: boolean;     // every voting director voted aye
  allVotesIn: boolean;    // every voting director has recorded something
};

const MOTION_SELECT = String.raw`SELECT mo.*, regexp_replace(d.name, '\s*\(.*\)\s*$', '') AS drafter_name FROM motions mo LEFT JOIN members d ON d.id = mo.drafted_by`;

export async function listMotions(): Promise<Array<Motion & { drafter_name: string | null }>> {
  return q(`${MOTION_SELECT}
    ORDER BY CASE mo.status WHEN 'open' THEN 0 WHEN 'moved' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
             COALESCE(mo.closed_at, mo.opened_at, mo.moved_at, mo.drafted_at) DESC`);
}

export async function getMotion(id: number): Promise<MotionDetail | null> {
  const motion = await one<Motion & { drafter_name: string | null }>(`${MOTION_SELECT} WHERE mo.id = $1`, [id]);
  if (!motion) return null;
  // Roster snapshot: active voting directors, plus anyone who voted but is no longer voting/active
  // (so history stays intact if the roster changes later).
  const voters = await q<Member & { choice: Vote["choice"] | null; cast_at: Date | null; source: Vote["source"] | null }>(
    `SELECT m.*, v.choice, v.cast_at, v.source
       FROM members m
       LEFT JOIN votes v ON v.member_id = m.id AND v.motion_id = $1
      WHERE (m.is_voting AND m.active) OR v.choice IS NOT NULL
      ORDER BY m.name`,
    [id],
  );
  const tally = { aye: 0, nay: 0, abstain: 0, pending: 0, total: voters.length };
  for (const v of voters) {
    if (v.choice) tally[v.choice]++; else tally.pending++;
  }
  return {
    ...motion,
    voters,
    tally,
    unanimous: tally.total > 0 && tally.aye === tally.total,
    allVotesIn: tally.pending === 0,
  };
}

/** Anyone signed in (voting or not) can put a draft on the table. */
export async function createDraft(member: Member, input: { title: string; body: string; draft_note: string }) {
  const row = await one<{ id: number }>(
    `INSERT INTO motions (title, body, draft_note, status, drafted_by, created_by)
     VALUES ($1,$2,$3,'draft',$4,$4) RETURNING id`,
    [input.title.trim(), input.body.trim(), input.draft_note.trim(), member.id],
  );
  await audit(member.email, "motion_drafted", `#${row!.id} ${input.title.trim()}`);
  return row!.id;
}

/** Drafter or admin may edit a draft before anyone moves it. */
export async function editDraft(member: Member, motionId: number, input: { title: string; body: string; draft_note: string }) {
  const m = await one<Motion>("SELECT * FROM motions WHERE id = $1", [motionId]);
  if (!m || m.status !== "draft") throw new Error("Only drafts can be edited.");
  if (m.drafted_by !== member.id && !member.is_admin) throw new Error("Only the drafter or an admin can edit this draft.");
  await q("UPDATE motions SET title=$2, body=$3, draft_note=$4 WHERE id=$1",
    [motionId, input.title.trim(), input.body.trim(), input.draft_note.trim()]);
  await audit(member.email, "draft_edited", `#${motionId}`);
}

/**
 * A voting director takes ownership of a draft. If they changed the wording, it is recorded as amended
 * from the draft. Passing no draft id creates and moves a brand-new motion in one step.
 */
export async function moveMotion(member: Member, input: { motionId?: number; title: string; body: string; closes_at: string | null; choice: Vote["choice"] }) {
  if (!member.is_voting) throw new Error("Only voting directors can move a motion.");
  if (!["aye", "nay", "abstain"].includes(input.choice)) throw new Error("Choose Aye, Nay, or Abstain when you move a motion; it is recorded once a director seconds.");
  const title = input.title.trim(), body = input.body.trim();
  if (!title) throw new Error("A motion needs wording.");
  let id = input.motionId;
  if (id) {
    const m = await one<Motion>("SELECT * FROM motions WHERE id = $1", [id]);
    if (!m || m.status !== "draft") throw new Error("That motion is no longer a draft.");
    const amended = m.title.trim() !== title || m.body.trim() !== body;
    await q(
      `UPDATE motions SET title=$2, body=$3, amended=$4, status='moved',
              moved_by=$5, moved_by_id=$6, moved_at=now(), closes_at=$7, mover_choice=$8
        WHERE id=$1 AND status='draft'`,
      [id, title, body, amended, displayName(member), member.id, input.closes_at || null, input.choice],
    );
    await audit(member.email, "motion_moved", `#${id}${amended ? " (amended from draft)" : ""}, mover's vote ${input.choice}`);
  } else {
    const row = await one<{ id: number }>(
      `INSERT INTO motions (title, body, status, drafted_by, created_by, moved_by, moved_by_id, moved_at, closes_at, mover_choice)
       VALUES ($1,$2,'moved',$3,$3,$4,$3,now(),$5,$6) RETURNING id`,
      [title, body, member.id, displayName(member), input.closes_at || null, input.choice],
    );
    id = row!.id;
    await audit(member.email, "motion_moved", `#${id} ${title}, mover's vote ${input.choice}`);
  }
  return id;
}

/** A different voting director seconds; that opens the vote. */
export async function secondMotion(member: Member, motionId: number, choice: Vote["choice"]) {
  if (!member.is_voting) throw new Error("Only voting directors can second a motion.");
  if (!["aye", "nay", "abstain"].includes(choice)) throw new Error("Choose Aye, Nay, or Abstain when you second a motion.");
  const m = await one<Motion>("SELECT * FROM motions WHERE id = $1", [motionId]);
  if (!m || m.status !== "moved") throw new Error("This motion isn't waiting for a second.");
  if (m.moved_by_id === member.id) throw new Error("The mover can't second their own motion.");
  await q(
    `UPDATE motions SET status='open', seconded_by=$2, seconded_by_id=$3, seconded_at=now(), opened_at=now()
      WHERE id=$1 AND status='moved'`,
    [motionId, displayName(member), member.id],
  );
  await audit(member.email, "motion_seconded", `#${motionId} (voting opened)`);

  // Voting is open now: record the mover's declared vote, then the seconder's.
  const insertVote = `INSERT INTO votes (motion_id, member_id, choice) VALUES ($1,$2,$3)
     ON CONFLICT (motion_id, member_id) DO UPDATE SET choice = EXCLUDED.choice, cast_at = now(), source = 'app'`;
  const mover = m.moved_by_id ? await one<Member>("SELECT * FROM members WHERE id = $1", [m.moved_by_id]) : null;
  if (m.mover_choice && mover) {
    await q(insertVote, [motionId, mover.id, m.mover_choice]);
    await audit(mover.email, "vote", `#${motionId} ${m.mover_choice} (declared at the move, recorded at the second)`);
  }
  await q(insertVote, [motionId, member.id, choice]);
  await audit(member.email, "vote", `#${motionId} ${choice} (with second)`);
  // On a two-director board the mover's and seconder's votes may already be all of them.
  const closedNow = await closeIfAllVotesIn(motionId, `${displayName(member)}'s second`);

  // Tell the mover voting is open. Mail failure must not undo the second.
  {
    if (mover?.email && !closedNow) {
      const link = `${appUrl()}/motions/${motionId}`;
      const recorded = m.mover_choice ? `Your vote of ${m.mover_choice} was recorded when the second came in; you can change it until the motion closes.` : "You haven't voted yet.";
      try {
        await sendMail({
          to: mover.email,
          subject: `Seconded: ${m.title.length > 80 ? m.title.slice(0, 77) + "..." : m.title}`,
          text: `Hi ${mover.name},\n\n${displayName(member)} seconded your motion, so voting is open:\n\n${link}\n\n${recorded}\n\nYuba Watershed Institute`,
        });
      } catch (err) {
        await audit("system", "mail_failed", `#${motionId} mover notice: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** Mover withdraws before a second; drafter or admin withdraws a draft. */
export async function withdrawMotion(member: Member, motionId: number) {
  const m = await one<Motion>("SELECT * FROM motions WHERE id = $1", [motionId]);
  if (!m) throw new Error("Motion not found.");
  const allowed =
    (m.status === "moved" && (m.moved_by_id === member.id || member.is_admin)) ||
    (m.status === "draft" && (m.drafted_by === member.id || member.is_admin));
  if (!allowed) throw new Error("You can't withdraw this motion at this stage.");
  await q("UPDATE motions SET status='withdrawn', closed_at=now() WHERE id=$1", [motionId]);
  await audit(member.email, "motion_withdrawn", `#${motionId} (was ${m.status})`);
}

export async function castVote(member: Member, motionId: number, choice: Vote["choice"]) {
  if (!member.is_voting) throw new Error("Only voting directors can vote.");
  const motion = await one<Motion>("SELECT * FROM motions WHERE id = $1", [motionId]);
  if (!motion) throw new Error("Motion not found.");
  if (motion.status !== "open") throw new Error("This motion is not open for voting.");
  if (motion.closes_at && new Date(motion.closes_at) < new Date()) throw new Error("The voting deadline has passed.");
  const existing = await one<Vote>("SELECT * FROM votes WHERE motion_id = $1 AND member_id = $2", [motionId, member.id]);
  await q(
    `INSERT INTO votes (motion_id, member_id, choice) VALUES ($1,$2,$3)
     ON CONFLICT (motion_id, member_id) DO UPDATE SET choice = EXCLUDED.choice, cast_at = now(), source = 'app'`,
    [motionId, member.id, choice],
  );
  await audit(member.email, "vote", `#${motionId} ${choice}`);
  if (!existing) await closeIfAllVotesIn(motionId, `${displayName(member)}'s vote`);
}

/**
 * Admin transcribes a vote a director sent by email (or otherwise outside the app), e.g. when the
 * director could not sign in. It is stored with source = 'email' and shown as "by email" on the motion
 * page and the written-consent PDF. A vote the director cast in the app is never overwritten here.
 */
export async function recordEmailVote(admin: Member, motionId: number, memberId: number, choice: Vote["choice"], note: string) {
  const motion = await one<Motion>("SELECT * FROM motions WHERE id = $1", [motionId]);
  if (!motion) throw new Error("Motion not found.");
  if (motion.status !== "open") throw new Error("This motion is not open for voting.");
  const director = await one<Member>("SELECT * FROM members WHERE id = $1 AND active AND is_voting", [memberId]);
  if (!director) throw new Error("Pick a voting director.");
  if (!note.trim()) throw new Error("Say where the vote came from, e.g. \"email to the board thread, Sept 27\".");
  const existing = await one<Vote>("SELECT * FROM votes WHERE motion_id = $1 AND member_id = $2", [motionId, memberId]);
  if (existing && existing.source === "app") throw new Error(`${director.name} already voted ${existing.choice} in the app; that vote stands.`);
  await q(
    `INSERT INTO votes (motion_id, member_id, choice, source) VALUES ($1,$2,$3,'email')
     ON CONFLICT (motion_id, member_id) DO UPDATE SET choice = EXCLUDED.choice, cast_at = now(), source = 'email'`,
    [motionId, memberId, choice],
  );
  await audit(admin.email, "vote_recorded_by_email", `#${motionId} ${director.email} ${choice}: ${note.trim()}`);
  if (!existing) await closeIfAllVotesIn(motionId, `${displayName(director)}'s vote by email`);
}

/** Admin closes voting. The board is then emailed the result with the written-consent PDF attached. */
export async function closeMotion(admin: Member, motionId: number) {
  await finishClose(admin.email, motionId, "", `by ${displayName(admin)}`);
}

/**
 * Voting closes by itself the moment the last voting director's vote is in, so nobody has to notice
 * and click. Only a director's first vote on a motion triggers this, never a changed vote: after an
 * admin reopens a motion so a vote can be changed, all votes are already in, and the change alone
 * must not close it again. Returns true if the motion was closed here.
 */
async function closeIfAllVotesIn(motionId: number, trigger: string): Promise<boolean> {
  const d = await getMotion(motionId);
  if (!d || d.status !== "open" || !d.allVotesIn) return false;
  await finishClose("system", motionId, `all votes in after ${trigger}`, "automatically, when the last director's vote came in");
  return true;
}

async function finishClose(actor: string, motionId: number, auditDetail: string, how: string) {
  const closed = await one<{ id: number }>(
    "UPDATE motions SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open' RETURNING id", [motionId]);
  if (!closed) return; // already closed (e.g. a double click): nothing to record and no second email
  await audit(actor, "motion_closed", `#${motionId}${auditDetail ? ` (${auditDetail})` : ""}`);
  const detail = await getMotion(motionId);
  if (detail) await sendClosedNotice(detail, how); // logs its own failure; never undoes the close
}

export async function reopenMotion(admin: Member, motionId: number) {
  // Reopening also clears the deadline; otherwise a past deadline would lock voting again immediately.
  await q("UPDATE motions SET status = 'open', closed_at = NULL, closes_at = NULL WHERE id = $1 AND status = 'closed'", [motionId]);
  await audit(admin.email, "motion_reopened", `#${motionId} (deadline cleared)`);
}

/**
 * Admin corrects the Details (background) of a motion after it has been moved or seconded. The motion
 * wording itself (title) is frozen once seconded and is not touched here. The correction is visible on
 * the motion page and the written-consent PDF, and the original text is kept in the audit log.
 */
export async function correctDetails(admin: Member, motionId: number, input: { body: string; note: string }) {
  const m = await one<Motion>("SELECT * FROM motions WHERE id = $1", [motionId]);
  if (!m || (m.status !== "open" && m.status !== "moved")) throw new Error("Only a moved or open motion can have its details corrected.");
  const body = input.body.trim(), note = input.note.trim();
  if (!note) throw new Error("Say what was corrected; the note is shown to the board.");
  if (body === m.body.trim()) throw new Error("The details are unchanged.");
  await q(
    `UPDATE motions SET body=$2, details_corrected_at=now(), details_corrected_by=$3, details_correction=$4 WHERE id=$1`,
    [motionId, body, displayName(admin), note],
  );
  await audit(admin.email, "details_corrected", `#${motionId} ${note}\n--- previous details ---\n${m.body}`);
}

/** Admin sets or clears the voting deadline on a motion that is open (or moved, awaiting a second). */
export async function setDeadline(admin: Member, motionId: number, closes_at: string | null) {
  const m = await one<Motion>("SELECT * FROM motions WHERE id = $1", [motionId]);
  if (!m || (m.status !== "open" && m.status !== "moved")) throw new Error("Only an open motion can have its deadline changed.");
  await q("UPDATE motions SET closes_at = $2 WHERE id = $1", [motionId, closes_at]);
  await audit(admin.email, "deadline_changed", `#${motionId} ${closes_at ? "-> " + closes_at : "cleared"}`);
}

export async function listMembers(): Promise<Member[]> {
  return q<Member>("SELECT * FROM members ORDER BY active DESC, is_voting DESC, name");
}

export async function upsertMember(admin: Member, input: { id?: number; email: string; name: string; is_admin: boolean; is_voting: boolean; active: boolean }) {
  const email = input.email.trim().toLowerCase();
  if (input.id) {
    await q("UPDATE members SET email=$2, name=$3, is_admin=$4, is_voting=$5, active=$6 WHERE id=$1",
      [input.id, email, input.name.trim(), input.is_admin, input.is_voting, input.active]);
    await audit(admin.email, "member_updated", `${email}`);
  } else {
    await q("INSERT INTO members (email, name, is_admin, is_voting, active) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, is_admin=EXCLUDED.is_admin, is_voting=EXCLUDED.is_voting, active=EXCLUDED.active",
      [email, input.name.trim(), input.is_admin, input.is_voting, input.active]);
    await audit(admin.email, "member_added", `${email}`);
  }
}

export async function recentAudit(limit = 50) {
  return q<{ id: number; at: Date; actor: string; action: string; detail: string }>(
    "SELECT * FROM audit_log ORDER BY at DESC LIMIT $1", [limit]);
}

/** "Chris Friedel (ED)" -> "Chris Friedel" */
export function displayName(m: { name: string }) {
  return m.name.replace(/\s*\(.*\)\s*$/, "");
}
