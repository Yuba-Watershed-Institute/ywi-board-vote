"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { consumeMagicLink, requestMagicLink, requireAdmin, requireMember } from "@/lib/auth";
import {
  castVote, closeMotion, correctDetails, createDraft, editDraft, moveMotion, recordEmailVote, reopenMotion,
  secondMotion, setDeadline, upsertMember, withdrawMotion,
} from "@/lib/motions";
import { sendVoteReminders } from "@/lib/notify";

/** "2026-09-30T17:00" typed as Pacific wall-clock time -> UTC Date. */
function pacificToUtc(local: string): Date {
  const guess = new Date(local + "Z"); // pretend it's UTC, then correct by the Pacific offset at that instant
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" }).formatToParts(guess);
  const off = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-7"; // e.g. "GMT-7" or "GMT-8"
  const hours = Number(off.replace("GMT", "")) || 0;
  return new Date(guess.getTime() - hours * 3600_000);
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
type Choice = "aye" | "nay" | "abstain";
function choiceFrom(fd: FormData): Choice {
  const c = str(fd, "choice") as Choice;
  if (!["aye", "nay", "abstain"].includes(c)) throw new Error("Choose Aye, Nay, or Abstain.");
  return c;
}

/** Parse an optional datetime-local deadline; reject one that is already past (a phone picker often defaults to "now"). */
function deadlineFrom(fd: FormData): string | null {
  const local = str(fd, "closes_at");
  if (!local) return null;
  const d = pacificToUtc(local);
  if (isNaN(d.getTime())) throw new Error("The voting deadline isn't a valid date.");
  if (d.getTime() < Date.now() + 60 * 60_000) throw new Error("The voting deadline must be at least an hour in the future. Leave it blank for no deadline.");
  return d.toISOString();
}

function refresh(id?: number) {
  revalidatePath("/motions");
  if (id) revalidatePath(`/motions/${id}`);
}

export async function loginAction(_prev: unknown, formData: FormData) {
  const email = str(formData, "email");
  if (!email) return { error: "Enter your email address." };
  try {
    const r = await requestMagicLink(email);
    if (!r.ok) return { error: r.reason };
    return { sent: true, debugLink: r.debugLink };
  } catch (e) {
    return { error: `Could not send the link: ${(e as Error).message}` };
  }
}

/** The button on /auth: only this POST consumes the sign-in token (mail scanners only GET/HEAD the link). */
export async function completeLoginAction(formData: FormData) {
  const token = str(formData, "token");
  const member = token ? await consumeMagicLink(token) : null;
  redirect(member ? "/motions" : "/?error=expired");
}

/** Anyone: propose a draft. A voting director may tick "move it now" to skip the draft stage. */
export async function proposeAction(formData: FormData) {
  const member = await requireMember();
  const title = str(formData, "title");
  if (!title) throw new Error("Title required");
  const body = str(formData, "body");
  let id: number;
  if (formData.get("move_now") === "on" && member.is_voting) {
    id = await moveMotion(member, { title, body, closes_at: deadlineFrom(formData), choice: choiceFrom(formData) });
  } else {
    id = await createDraft(member, { title, body, draft_note: str(formData, "draft_note") });
  }
  refresh(id);
  redirect(`/motions/${id}`);
}

export async function editDraftAction(formData: FormData) {
  const member = await requireMember();
  const id = Number(formData.get("motion_id"));
  await editDraft(member, id, { title: str(formData, "title"), body: str(formData, "body"), draft_note: str(formData, "draft_note") });
  refresh(id);
  redirect(`/motions/${id}`);
}

/** Voting director moves a draft, as written or with edits. */
export async function moveAction(formData: FormData) {
  const member = await requireMember();
  const id = Number(formData.get("motion_id"));
  await moveMotion(member, {
    motionId: id,
    title: str(formData, "title"),
    body: str(formData, "body"),
    closes_at: deadlineFrom(formData),
    choice: choiceFrom(formData),
  });
  refresh(id);
  redirect(`/motions/${id}`);
}

export async function secondAction(formData: FormData) {
  const member = await requireMember();
  const id = Number(formData.get("motion_id"));
  await secondMotion(member, id, choiceFrom(formData));
  refresh(id);
  redirect(`/motions/${id}`);
}

export async function withdrawAction(formData: FormData) {
  const member = await requireMember();
  const id = Number(formData.get("motion_id"));
  await withdrawMotion(member, id);
  refresh(id);
  redirect(`/motions`);
}

export async function voteAction(formData: FormData) {
  const member = await requireMember();
  const motionId = Number(formData.get("motion_id"));
  await castVote(member, motionId, choiceFrom(formData));
  refresh(motionId);
  redirect(str(formData, "back") || "/motions");
}

/** Admin transcribes a director's vote received by email. */
export async function recordEmailVoteAction(formData: FormData) {
  const admin = await requireAdmin();
  const motionId = Number(formData.get("motion_id"));
  const memberId = Number(formData.get("member_id"));
  if (!memberId) throw new Error("Pick a voting director.");
  await recordEmailVote(admin, motionId, memberId, choiceFrom(formData), str(formData, "note"));
  refresh(motionId);
  redirect(`/motions/${motionId}`);
}

export async function closeMotionAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = Number(formData.get("motion_id"));
  await closeMotion(admin, id);
  refresh(id);
  redirect(`/motions/${id}`);
}

/** Admin emails everyone who hasn't voted on this motion, regardless of the reminder schedule. */
export async function remindAction(formData: FormData) {
  await requireAdmin();
  const id = Number(formData.get("motion_id"));
  const r = await sendVoteReminders({ motionId: id, force: true });
  refresh(id);
  redirect(`/motions/${id}?reminded=${r.emailed.length}${r.delivered ? "" : "&unsent=1"}`);
}

export async function correctDetailsAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = Number(formData.get("motion_id"));
  await correctDetails(admin, id, { body: str(formData, "body"), note: str(formData, "note") });
  refresh(id);
  redirect(`/motions/${id}`);
}
export async function setDeadlineAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = Number(formData.get("motion_id"));
  await setDeadline(admin, id, deadlineFrom(formData));
  refresh(id);
  redirect(`/motions/${id}`);
}
export async function clearDeadlineAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = Number(formData.get("motion_id"));
  await setDeadline(admin, id, null);
  refresh(id);
  redirect(`/motions/${id}`);
}
export async function reopenMotionAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = Number(formData.get("motion_id"));
  await reopenMotion(admin, id);
  refresh(id);
  redirect(`/motions/${id}`);
}

export async function saveMemberAction(formData: FormData) {
  const admin = await requireAdmin();
  const idRaw = formData.get("id");
  await upsertMember(admin, {
    id: idRaw ? Number(idRaw) : undefined,
    email: str(formData, "email"),
    name: str(formData, "name"),
    is_admin: formData.get("is_admin") === "on",
    is_voting: formData.get("is_voting") === "on",
    active: formData.get("active") === "on",
  });
  revalidatePath("/admin");
  redirect("/admin?saved=1");
}
