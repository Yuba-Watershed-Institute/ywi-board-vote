import { redirect } from "next/navigation";
import { currentMember } from "@/lib/auth";
import { listMembers, recentAudit } from "@/lib/motions";
import { saveMemberAction } from "../actions";

export const dynamic = "force-dynamic";

const fmt = (d: Date | string) => new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "short", timeStyle: "short" });

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const member = await currentMember();
  if (!member) redirect("/");
  if (!member.is_admin) redirect("/motions");
  const { saved } = await searchParams;
  const members = await listMembers();
  const log = await recentAudit(40);

  return (
    <>
      <h1>Admin</h1>
      {saved && <div className="notice ok">Saved.</div>}

      <p className="muted small">Motions are proposed, moved, and seconded from the <a href="/motions">Motions</a> page by the people doing it. Admins close votes, keep the roster, and can withdraw stale drafts.</p>

      <h2>Roster</h2>
      <div className="card">
        <p className="muted small">Only these addresses can sign in. &quot;Voting&quot; controls who counts toward unanimity; &quot;Admin&quot; can open and close motions and edit this list. Unchecking &quot;Active&quot; removes someone without deleting their vote history.</p>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Flags</th><th></th></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td colSpan={4} style={{ padding: 0 }}>
                  <form action={saveMemberAction} className="row" style={{ padding: "8px 6px" }}>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="text" name="name" defaultValue={m.name} style={{ flex: "1 1 160px" }} />
                    <input type="email" name="email" defaultValue={m.email} style={{ flex: "2 1 220px" }} />
                    <span className="checks">
                      <label><input type="checkbox" name="is_voting" defaultChecked={m.is_voting} />Voting</label>
                      <label><input type="checkbox" name="is_admin" defaultChecked={m.is_admin} />Admin</label>
                      <label><input type="checkbox" name="active" defaultChecked={m.active} />Active</label>
                    </span>
                    <button className="secondary" type="submit">Save</button>
                  </form>
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={4} style={{ padding: 0 }}>
                <form action={saveMemberAction} className="row" style={{ padding: "8px 6px", background: "#fafaf7" }}>
                  <input type="text" name="name" placeholder="New member name" required style={{ flex: "1 1 160px" }} />
                  <input type="email" name="email" placeholder="email" required style={{ flex: "2 1 220px" }} />
                  <span className="checks">
                    <label><input type="checkbox" name="is_voting" defaultChecked />Voting</label>
                    <label><input type="checkbox" name="is_admin" />Admin</label>
                    <label><input type="checkbox" name="active" defaultChecked />Active</label>
                  </span>
                  <button className="primary" type="submit">Add</button>
                </form>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Activity log</h2>
      <div className="card">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
          <tbody>
            {log.map((e) => (
              <tr key={e.id}><td className="muted small">{fmt(e.at)}</td><td className="small">{e.actor}</td><td className="small">{e.action}{e.detail && <span className="muted"> · {e.detail}</span>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
