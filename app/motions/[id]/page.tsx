import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentMember } from "@/lib/auth";
import { getMotion } from "@/lib/motions";
import VoteButtons from "../vote-buttons";
import { closeMotionAction, editDraftAction, moveAction, reopenMotionAction, secondAction, withdrawAction } from "../../actions";

export const dynamic = "force-dynamic";

const fmt = (d: Date | string | null) => d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" }) : "";
const STATUS_LABEL: Record<string, string> = { draft: "Suggested draft", moved: "Moved, awaiting a second", open: "Open for voting", closed: "Closed", withdrawn: "Withdrawn" };

export default async function MotionPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await currentMember();
  if (!member) redirect("/");
  const { id } = await params;
  const m = await getMotion(Number(id));
  if (!m) notFound();
  const mine = m.voters.find((v) => v.id === member.id)?.choice ?? null;
  const pastDeadline = !!m.closes_at && new Date(m.closes_at) < new Date();
  const isMover = m.moved_by_id === member.id;
  const isDrafter = m.drafted_by === member.id;
  const hidden = (name: string, value: string | number) => <input type="hidden" name={name} value={value} />;

  return (
    <>
      <p className="small"><Link href="/motions">← All motions</Link></p>
      <h1>{m.title}</h1>
      <div className="meta">
        <span className={`pill ${m.status === "open" ? "open" : m.status === "moved" || m.status === "draft" ? "pending" : "closed"}`}>{STATUS_LABEL[m.status]}</span>
        {m.drafter_name && m.drafted_by !== m.moved_by_id && <>Drafted by {m.drafter_name} {fmt(m.drafted_at)}. </>}
        {m.moved_by && <>Moved by {m.moved_by} {fmt(m.moved_at)}{m.amended && " (wording amended from the draft)"}. </>}
        {m.seconded_by && <>Seconded by {m.seconded_by} {fmt(m.seconded_at)}. </>}
        {m.closes_at && <>Deadline {fmt(m.closes_at)}. </>}
        {m.closed_at && m.status !== "withdrawn" && <>Closed {fmt(m.closed_at)}. </>}
      </div>
      {m.body && <div className="card"><pre className="body">{m.body}</pre></div>}
      {m.draft_note && m.status === "draft" && <div className="notice">Note from {m.drafter_name}: {m.draft_note}</div>}

      {/* DRAFT: directors can move it; drafter/admin can edit or withdraw */}
      {m.status === "draft" && member.is_voting && (
        <div className="card">
          <h3>Move this motion</h3>
          <p className="muted small">Moving puts the motion in your name. Leave the wording as is to move it as written, or edit it first; edits are recorded as an amendment of the draft. Another director must second it before voting opens.</p>
          <form action={moveAction} className="stack">
            {hidden("motion_id", m.id)}
            <label>Motion <input type="text" name="title" required defaultValue={m.title} /></label>
            <label>Details <textarea name="body" defaultValue={m.body} /></label>
            <label>Voting deadline <small>Optional, Pacific time.</small><input type="datetime-local" name="closes_at" /></label>
            <div><button className="primary" type="submit">Move this motion</button></div>
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
              <p className="muted small">Seconding opens the vote to the whole board. It doesn&apos;t record a vote for you; you&apos;ll be asked to vote next.</p>
              <form action={secondAction}>{hidden("motion_id", m.id)}<button className="primary" type="submit">Second this motion</button></form>
            </>
          ) : isMover ? (
            <p className="muted small">You moved this. Voting opens when another director seconds it.</p>
          ) : (
            <p className="muted small">Waiting for a director other than the mover to second.</p>
          )}
          {(isMover || member.is_admin) && (
            <form action={withdrawAction} style={{ marginTop: 10 }}>{hidden("motion_id", m.id)}<button className="secondary" type="submit">Withdraw motion</button></form>
          )}
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

      {member.is_admin && (m.status === "open" || m.status === "closed") && (
        <div className="card">
          <h3>Admin</h3>
          <div className="row">
            {m.status === "open" ? (
              <form action={closeMotionAction}>{hidden("motion_id", m.id)}<button className="secondary">Close voting</button></form>
            ) : (
              <form action={reopenMotionAction}>{hidden("motion_id", m.id)}<button className="secondary">Reopen voting</button></form>
            )}
            {m.allVotesIn && m.status === "open" && <span className="muted small">All votes are in; you can close this.</span>}
          </div>
        </div>
      )}
    </>
  );
}
