import Link from "next/link";
import { redirect } from "next/navigation";
import { currentMember } from "@/lib/auth";
import { listMotions, getMotion, type MotionDetail } from "@/lib/motions";
import VoteButtons from "./vote-buttons";
import ProposeForm from "./propose-form";

export const dynamic = "force-dynamic";

const fmt = (d: Date | string | null) => d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" }) : "";

function Provenance({ m }: { m: MotionDetail }) {
  const bits: string[] = [];
  if (m.moved_by) bits.push(`Moved by ${m.moved_by}${m.moved_at ? ` ${fmt(m.moved_at)}` : ""}`);
  if (m.seconded_by) bits.push(`seconded by ${m.seconded_by}${m.seconded_at ? ` ${fmt(m.seconded_at)}` : ""}`);
  if (m.drafter_name && m.drafted_by !== m.moved_by_id) bits.push(`${m.amended ? "amended from a draft by" : "drafted by"} ${m.drafter_name}`);
  if (!m.moved_by && m.drafter_name) bits.push(`Suggested by ${m.drafter_name} ${fmt(m.drafted_at)}`);
  return <>{bits.join("; ")}.</>;
}

export default async function MotionsPage() {
  const member = await currentMember();
  if (!member) redirect("/");
  const all = (await Promise.all((await listMotions()).map((m) => getMotion(m.id)))).filter(Boolean) as MotionDetail[];
  const open = all.filter((m) => m.status === "open");
  const moved = all.filter((m) => m.status === "moved");
  const drafts = all.filter((m) => m.status === "draft");
  const done = all.filter((m) => m.status === "closed" || m.status === "withdrawn");

  return (
    <>
      <h1>Motions</h1>
      {!member.is_voting && <div className="notice">You&apos;re signed in as a non-voting member. You can suggest motions and see results, but moving, seconding, and voting are for directors.</div>}

      <h2>Open for voting</h2>
      {open.length === 0 && <p className="muted">Nothing is open right now.</p>}
      {open.map((m) => (
        <div className="card" key={m.id}>
          <h3><Link href={`/motions/${m.id}`}>{m.title}</Link></h3>
          <div className="meta"><Provenance m={m} />{m.closes_at && <> Deadline {fmt(m.closes_at)}.</>}</div>
          {m.body && <pre className="body small">{m.body}</pre>}
          <div className="meta" style={{ marginTop: 8 }}>
            {m.tally.aye} aye · {m.tally.nay} nay · {m.tally.abstain} abstain · {m.tally.pending} of {m.tally.total} still to vote
          </div>
          {member.is_voting && (
            <VoteButtons motionId={m.id} back="/motions"
              current={m.voters.find((v) => v.id === member.id)?.choice ?? null}
              disabled={!!m.closes_at && new Date(m.closes_at) < new Date()} />
          )}
        </div>
      ))}

      <h2>Awaiting a second</h2>
      {moved.length === 0 && <p className="muted">None.</p>}
      {moved.map((m) => (
        <div className="card" key={m.id}>
          <h3><Link href={`/motions/${m.id}`}>{m.title}</Link></h3>
          <div className="meta"><Provenance m={m} /></div>
          {member.is_voting && m.moved_by_id !== member.id && (
            <p className="small"><Link className="button" href={`/motions/${m.id}`}>Review and second</Link></p>
          )}
        </div>
      ))}

      <h2>Suggested (needs a director to move it)</h2>
      {drafts.length === 0 && <p className="muted">No drafts waiting.</p>}
      {drafts.map((m) => (
        <div className="card" key={m.id}>
          <h3><Link href={`/motions/${m.id}`}>{m.title}</Link></h3>
          <div className="meta"><Provenance m={m} />{m.draft_note && <> Note: {m.draft_note}</>}</div>
          {member.is_voting && <p className="small"><Link className="button" href={`/motions/${m.id}`}>Review and move</Link></p>}
        </div>
      ))}

      <h2>Propose a motion</h2>
      <div className="card">
        <p className="muted small">
          {member.is_voting
            ? "Put a motion on the table. Leave it as a draft for discussion, or move it now in your own name; another director must second it before voting opens."
            : "Suggest wording for the board. A director can move it as written or edit it first; another director seconds it, and then voting opens."}
        </p>
        <ProposeForm canMove={member.is_voting} />
      </div>

      <h2>Closed</h2>
      {done.length === 0 && <p className="muted">No closed motions yet.</p>}
      {done.map((m) => (
        <div className="card" key={m.id}>
          <h3><Link href={`/motions/${m.id}`}>{m.title}</Link></h3>
          <div className="meta">
            {m.status === "withdrawn" ? (
              <span className="pill closed">Withdrawn {fmt(m.closed_at)}</span>
            ) : (
              <>
                <span className={`pill ${m.unanimous ? "unanimous" : "pending"}`}>{m.unanimous ? "Unanimous consent" : m.tally.aye > m.tally.nay ? "Passed, not unanimous: ratify at meeting" : "Did not pass"}</span>
                {m.tally.aye} aye · {m.tally.nay} nay · {m.tally.abstain} abstain · {m.tally.pending} no vote. Closed {fmt(m.closed_at)}.
              </>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
