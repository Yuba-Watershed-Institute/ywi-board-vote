import { q, one, audit, type Motion, type Member, type Vote } from "./db";

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
export async function moveMotion(member: Member, input: { motionId?: number; title: string; body: string; closes_at: string | null }) {
  if (!member.is_voting) throw new Error("Only voting directors can move a motion.");
  const title = input.title.trim(), body = input.body.trim();
  if (!title) throw new Error("A motion needs wording.");
  let id = input.motionId;
  if (id) {
    const m = await one<Motion>("SELECT * FROM motions WHERE id = $1", [id]);
    if (!m || m.status !== "draft") throw new Error("That motion is no longer a draft.");
    const amended = m.title.trim() !== title || m.body.trim() !== body;
    await q(
      `UPDATE motions SET title=$2, body=$3, amended=$4, status='moved',
              moved_by=$5, moved_by_id=$6, moved_at=now(), closes_at=$7
        WHERE id=$1 AND status='draft'`,
      [id, title, body, amended, displayName(member), member.id, input.closes_at || null],
    );
    await audit(member.email, "motion_moved", `#${id}${amended ? " (amended from draft)" : ""}`);
  } else {
    const row = await one<{ id: number }>(
      `INSERT INTO motions (title, body, status, drafted_by, created_by, moved_by, moved_by_id, moved_at, closes_at)
       VALUES ($1,$2,'moved',$3,$3,$4,$3,now(),$5) RETURNING id`,
      [title, body, member.id, displayName(member), input.closes_at || null],
    );
    id = row!.id;
    await audit(member.email, "motion_moved", `#${id} ${title}`);
  }
  return id;
}

/** A different voting director seconds; that opens the vote. */
export async function secondMotion(member: Member, motionId: number) {
  if (!member.is_voting) throw new Error("Only voting directors can second a motion.");
  const m = await one<Motion>("SELECT * FROM motions WHERE id = $1", [motionId]);
  if (!m || m.status !== "moved") throw new Error("This motion isn't waiting for a second.");
  if (m.moved_by_id === member.id) throw new Error("The mover can't second their own motion.");
  await q(
    `UPDATE motions SET status='open', seconded_by=$2, seconded_by_id=$3, seconded_at=now(), opened_at=now()
      WHERE id=$1 AND status='moved'`,
    [motionId, displayName(member), member.id],
  );
  await audit(member.email, "motion_seconded", `#${motionId} (voting opened)`);
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
  await q(
    `INSERT INTO votes (motion_id, member_id, choice) VALUES ($1,$2,$3)
     ON CONFLICT (motion_id, member_id) DO UPDATE SET choice = EXCLUDED.choice, cast_at = now(), source = 'app'`,
    [motionId, member.id, choice],
  );
  await audit(member.email, "vote", `#${motionId} ${choice}`);
}

export async function closeMotion(admin: Member, motionId: number) {
  await q("UPDATE motions SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open'", [motionId]);
  await audit(admin.email, "motion_closed", `#${motionId}`);
}

export async function reopenMotion(admin: Member, motionId: number) {
  await q("UPDATE motions SET status = 'open', closed_at = NULL WHERE id = $1 AND status = 'closed'", [motionId]);
  await audit(admin.email, "motion_reopened", `#${motionId}`);
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
