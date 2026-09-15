import { proposeAction } from "../actions";

export default function ProposeForm({ canMove }: { canMove: boolean }) {
  return (
    <form action={proposeAction} className="stack">
      <label>Motion <small>One sentence, as it should read in the minutes.</small>
        <input type="text" name="title" required placeholder="Approve the minutes of the August 2026 board meeting" />
      </label>
      <label>Details <small>Optional: resolution text, background, links.</small>
        <textarea name="body" />
      </label>
      <label>Note to the board <small>Optional, e.g. why this is coming up now. Not part of the motion.</small>
        <input type="text" name="draft_note" />
      </label>
      {canMove && (
        <>
          <label className="checks" style={{ fontWeight: 600 }}>
            <span><input type="checkbox" name="move_now" /> Move it now, in my name (skips the draft stage)</span>
          </label>
          <label>Voting deadline <small>Optional, Pacific time. Only used if you move it now.</small>
            <input type="datetime-local" name="closes_at" />
          </label>
        </>
      )}
      <div><button className="primary" type="submit">{canMove ? "Propose" : "Suggest this motion"}</button></div>
    </form>
  );
}
