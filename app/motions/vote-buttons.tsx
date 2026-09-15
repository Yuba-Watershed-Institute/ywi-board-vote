import { voteAction } from "../actions";

export default function VoteButtons({ motionId, current, disabled, back }: {
  motionId: number; current: "aye" | "nay" | "abstain" | null; disabled?: boolean; back: string;
}) {
  const opts: Array<["aye" | "nay" | "abstain", string]> = [["aye", "Aye"], ["nay", "Nay"], ["abstain", "Abstain"]];
  return (
    <form action={voteAction} className="votebar">
      <input type="hidden" name="motion_id" value={motionId} />
      <input type="hidden" name="back" value={back} />
      {opts.map(([v, label]) => (
        <button key={v} type="submit" name="choice" value={v} disabled={disabled}
          className={`${v}${current === v ? " selected" : ""}`}>
          {current === v ? "✓ " : ""}{label}
        </button>
      ))}
    </form>
  );
}
