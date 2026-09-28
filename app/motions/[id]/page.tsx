import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentMember } from "@/lib/auth";
import { getMotion } from "@/lib/motions";
import { consentLabel } from "@/lib/db";
import VoteButtons from "../vote-buttons";
import { clearDeadlineAction, closeMotionAction, correctDetailsAction, editDraftAction, moveAction, recordEmailVoteAction, remindAction, reopenMotionAction, secondAction, setDeadlineAction, withdrawAction } from "../../actions";

export const dynamic = "force-dynamic";

const fmt = (d: Date | string | null) => d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" }) : "";
const STATUS_LABEL: Record<string, string> = { draft: "Suggested draft", moved: "Moved, awaiting a second", open: "Open for voting", closed: "Closed", withdrawn: "Withdrawn" };

export default async function MotionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ reminded?: string; unsent?: string }> }) {
  const member = await currentMember();
  if (!member) redirect("/");
  const { id } = await params;
  const { reminded, unsent } = await searchParams;
  const m = await getMotion(Number(id));
  if (!m) notFound();
  const mine = m.voters.find((v) => v.id === member.id)?.choice ?? null;
  const pastDeadline = !!m.closes_at && new Date(m.closes_at) < new Date();
  const isMover = m.moved_by_id === member.id;
  const isDrafter = m.drafted_by === member.id;
  const canSecond = m.voters.filter((v) => v.is_voting && v.active && v.id !== m.moved_by_id).length;
  const hidden = (name: string, value: string | number) => <input type="hidden" name={name} value={value} />;

  return (
    <>
      <p className="small"><Link href="/motions">← All motions</Link></p>
      {reminded !== undefined && (
        <div className={`notice${Number(reminded) > 0 && !unsent ? " ok" : ""}`}>
          {Number(reminded) === 0 ? "Nobody to remind: nothing is waiting on anyone, or the deadline has passed." : unsent ? `Reminders for ${reminded} director${reminded === "1" ? "" : "s"} were logged but not emailed: mail isn't configured.` : `Reminder emailed to ${reminded} director${reminded === "1" ? "" : "s"}.`}
        </div>
      )}
      <h1>{m.title}</h1>
      <div className="meta">
        <span className={`pill ${m.status === "open" ? "open" : m.status === "moved" || m.status === "draft" ? "pending" : "closed"}`}>{STATUS_LABEL[m.status]}</span>
        {consentLabel(m) && <b>{consentLabel(m)}. </b>}
        {m.drafter_name && m.drafted_by !== m.moved_by_id && <>Drafted by {m.drafter_name} {fmt(m.drafted_at)}. </>}
        {m.moved_by && <>Moved by {m.moved_by} {fmt(m.moved_at)}{m.amended && " (wording amended from the draft)"}. </>}
        {m.seconded_by && <>Seconded by {m.seconded_by} {fmt(m.seconded_at)}. </>}
        {m.closes_at && <>Deadline {fmt(m.closes_at)}. </>}
        {m.closed_at && m.status !== "withdrawn" && <>Closed {fmt(m.closed_at)}. </>}
      </div>
      {m.body && <div className="card"><pre className="body">{m.body}</pre>
        {m.details_corrected_at && <p className="muted small" style={{ marginTop: 8 }}>Details corrected by {m.details_corrected_by} {fmt(m.details_corrected_at)}: {m.details_correction}. The motion wording is unchanged.</p>}
      </div>}
      {m.draft_note && m.status === "draft" && <div className="notice">Note from {m.drafter_name}: {m.draft_note}</div>}

      {/* DRAFT: directors can move it; drafter/admin can edit or withdraw */}
      {m.status === "draft" && member.is_voting && (
        <div className="card">
          <h3>Move this motion</h3>
          <p className="muted small">Moving puts the motion in your name. Leave the wording as is to move it as written, or edit it first; edits are recorded as an amendment of the draft. Another director must second it before voting opens. Your vote is declared now and recorded at the second; you can change it until the motion closes.</p>
          <form action={moveAction} className="stack">
            {hidden("motion_id", m.id)}
            <label>Motion <input type="text" name="title" required defaultValue={m.title} /></label>
            <label>Details <textarea name="body" defaultValue={m.body} /></label>
            <label>Voting deadline <small>Optional, Pacific time. Leave blank for no deadline; a deadline that has already passed is rejected.</small><input type="datetime-local" name="closes_at" /></label>
            <div className="row">
              <button className="primary" type="submit" name="choice" value="aye">Move and vote Aye</button>
              <button className="secondary" type="submit" name="choice" value="nay">Move and vote Nay</button>
              <button className="secondary" type="submit" name="choice" value="abstain">Move and abstain</button>
            </div>
          </form>
        </div>
      )}
      {m.status === "draft" && (isDrafter || member.is_admin) && (
        <div className="card">
          <h3>Edit the draft</h3>
          <form action={editDraftAction} className="stack">
            {hidden("motion_id", m.id)}
            <label>Motion <input type="text" name="title" required defaultValue={m.title} /></label>
            <label>Details <textarea name="body" defaultValue={m.body} /></label>
            <label>Note to the board <input type="text" name="draft_note" defaultValue={m.draft_note} /></label>
            <div className="row">
              <button className="secondary" type="submit">Save draft</button>
              <button className="secondary" type="submit" formAction={withdrawAction}>Withdraw draft</button>
            </div>
          </form>
        </div>
      )}

      {/* MOVED: another director seconds */}
      {m.status === "moved" && (
        <div className="card">
          <h3>Second</h3>
          {member.is_voting && !isMover ? (
            <>
              <p className="muted small">Seconding opens the vote to the whole board and records your vote in the same step. You can change your vote until the motion closes.</p>
              <form action={secondAction}>
                {hidden("motion_id", m.id)}
                <div className="row">
                  <button className="primary" type="submit" name="choice" value="aye">Second and vote Aye</button>
                  <button className="secondary" type="submit" name="choice" value="nay">Second and vote Nay</button>
                  <button className="secondary" type="submit" name="choice" value="abstain">Second and abstain</button>
                </div>
              </form>
            </>
          ) : isMover ? (
            <p className="muted small">You moved this{m.mover_choice ? ` and declared a vote of ${m.mover_choice}` : ""}. Voting opens when another director seconds it{m.mover_choice ? ", and your vote is recorded then" : ""}. You&apos;ll get an email when that happens.</p>
          ) : (
            <p className="muted small">Waiting for a director other than the mover to second.</p>
          )}
          {(isMover || member.is_admin) && (
            <div className="row" style={{ marginTop: 10 }}>
              <form action={withdrawAction}>{hidden("motion_id", m.id)}<button className="secondary" type="submit">Withdraw motion</button></form>
              {member.is_admin && canSecond > 0 && (
                <form action={remindAction}>{hidden("motion_id", m.id)}<button className="secondary" type="submit">Email a reminder to the {canSecond} who can second</button></form>
              )}
            </div>
          )}
          {member.is_admin && <p className="muted small" style={{ marginTop: 8 }}>Directors are also nudged about motions awaiting a second by the same daily reminder that chases missing votes.</p>}
        </div>
      )}

      {/* OPEN: vote */}
      {m.status === "open" && member.is_voting && (
        <div className="card">
          <h3>Your vote</h3>
          {!mine && (isMover || m.seconded_by_id === member.id) && (
            <div className="notice">You {isMover ? "moved" : "seconded"} this motion. That isn&apos;t recorded as a vote; please record one.</div>
          )}
          <p className="muted small">{mine ? "You can change your vote until the motion is closed." : "You haven't voted yet."}</p>
          <VoteButtons motionId={m.id} current={mine} disabled={pastDeadline} back={`/motions/${m.id}`} />
          {pastDeadline && <p className="notice" style={{ marginTop: 10 }}>The deadline has passed; voting is locked until an admin closes or extends the motion.</p>}
        </div>
      )}

      {(m.status === "open" || m.status === "closed") && (
        <div className="card">
          <h3>Votes</h3>
          <div className="tally">
            <div className="aye"><b>{m.tally.aye}</b>aye</div>
            <div className="nay"><b>{m.tally.nay}</b>nay</div>
            <div><b>{m.tally.abstain}</b>abstain</div>
            <div><b>{m.tally.pending}</b>not yet voted</div>
          </div>
          {m.status === "closed" && (
            <p className="small">
              <span className={`pill ${m.unanimous ? "unanimous" : "pending"}`}>
                {m.unanimous ? "Unanimous written consent: valid board action" : "Not unanimous: place on next meeting agenda for ratification"}
              </span>
            </p>
          )}
          <table>
            <thead><tr><th>Director</th><th>Vote</th><th className="hide-sm">Recorded</th></tr></thead>
            <tbody>
              {m.voters.map((v) => (
                <tr key={v.id}>
                  <td>{v.name}{v.id === m.moved_by_id && <span className="muted small"> (mover)</span>}{v.id === m.seconded_by_id && <span className="muted small"> (seconder)</span>}</td>
                  <td className={`choice ${v.choice ?? "none"}`}>{v.choice ?? "—"}</td>
                  <td className="hide-sm muted small">{fmt(v.cast_at)}{v.source === "email" && " (by email)"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small" style={{ marginTop: 12 }}>
            <a className="button" href={`/motions/${m.id}/consent.pdf`}>Download written-consent PDF</a>
          </p>
        </div>
      )}

      {member.is_admin && (m.status === "open" || m.status === "moved") && (
        <div className="card">
          <h3>Correct the details</h3>
          <p className="muted small">For clerical corrections to the background text after the motion has been moved. The motion wording above is frozen once seconded and can&apos;t be changed here; to change it, withdraw and re-move. The correction note is shown to the board and on the written-consent PDF, and the previous text is kept in the activity log.</p>
          <form action={correctDetailsAction} className="stack">
            {hidden("motion_id", m.id)}
            <label>Details <textarea name="body" defaultValue={m.body} rows={12} /></label>
            <label>What was corrected <small>One sentence, shown to the board.</small><input type="text" name="note" required /></label>
            <div><button className="secondary" type="submit">Save correction</button></div>
          </form>
        </div>
      )}

      {member.is_admin && (m.status === "open" || m.status === "closed") && (
        <div className="card">
          <h3>Admin</h3>
          <div className="row">
            {m.status === "open" ? (
              <form action={closeMotionAction}>{hidden("motion_id", m.id)}<button className="secondary">Close voting</button></form>
            ) : (
              <form action={reopenMotionAction}>{hidden("motion_id", m.id)}<button className="secondary">Reopen voting</button></form>
            )}
            {m.status === "open" && !m.allVotesIn && !pastDeadline && (
              <form action={remindAction}>{hidden("motion_id", m.id)}<button className="secondary">Email a reminder to the {m.tally.pending} who haven&apos;t voted</button></form>
            )}
            {m.allVotesIn && m.status === "open" && <span className="muted small">All votes are in; you can close this.</span>}
          </div>
          {m.status === "open" && (
            <p className="muted small" style={{ marginTop: 8 }}>
              Voting closes by itself the moment the last director&apos;s vote is in; close it here to end it early, for example at the deadline.
              Closing, either way, emails the whole roster and the admins the result. The written-consent PDF is not emailed: download it here, have the Secretary sign it, then circulate it.
              Directors who haven&apos;t voted are also reminded automatically each morning once a motion has been open a couple of days (see SETUP.md); the button sends one right now.
            </p>
          )}
          {m.status === "open" && (
            <form action={recordEmailVoteAction} className="stack" style={{ marginTop: 12 }}>
              {hidden("motion_id", m.id)}
              <h4 style={{ margin: 0 }}>Record a vote received by email</h4>
              <p className="muted small" style={{ margin: 0 }}>For a director who sent their vote to the board thread instead of voting here. It is marked &quot;by email&quot; in the tally and on the written-consent PDF. A vote the director cast in the app can&apos;t be overwritten this way.</p>
              <label>Director
                <select name="member_id" required defaultValue="">
                  <option value="" disabled>Choose a director</option>
                  {m.voters.filter((v) => v.is_voting && v.active && v.source !== "app").map((v) => (
                    <option key={v.id} value={v.id}>{v.name}{v.choice ? ` (currently ${v.choice} by email)` : ""}</option>
                  ))}
                </select>
              </label>
              <label>Where it came from <small>Shown in the activity log, e.g. &quot;email to the board thread, Sept 27&quot;.</small><input type="text" name="note" required /></label>
              <div className="row">
                <button className="secondary" type="submit" name="choice" value="aye">Record Aye</button>
                <button className="secondary" type="submit" name="choice" value="nay">Record Nay</button>
                <button className="secondary" type="submit" name="choice" value="abstain">Record Abstain</button>
              </div>
            </form>
          )}
          {m.status === "open" && (
            <form action={setDeadlineAction} className="stack" style={{ marginTop: 12 }}>
              {hidden("motion_id", m.id)}
              <label>Voting deadline <small>Pacific time. {m.closes_at ? `Currently ${fmt(m.closes_at)}.` : "None set."} Voting locks when it passes.</small>
                <input type="datetime-local" name="closes_at" />
              </label>
              <div className="row">
                <button className="secondary" type="submit">Set deadline</button>
                {m.closes_at && <button className="secondary" type="submit" formAction={clearDeadlineAction}>Clear deadline</button>}
              </div>
            </form>
          )}
        </div>
      )}
    </>
  );
}
