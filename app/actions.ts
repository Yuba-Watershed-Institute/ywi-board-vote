"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requestMagicLink, requireAdmin, requireMember } from "@/lib/auth";
import {
  castVote, closeMotion, createDraft, editDraft, moveMotion, reopenMotion,
  secondMotion, upsertMember, withdrawMotion,
} from "@/lib/motions";

/** "2026-09-30T17:00" typed as Pacific wall-clock time -> UTC Date. */
function pacificToUtc(local: string): Date {
  const guess = new Date(local + "Z"); // pretend it's UTC, then correct by the Pacific offset at that instant
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" }).formatToParts(guess);
  const off = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-7"; // e.g. "GMT-7" or "GMT-8"
  const hours = Number(off.replace("GMT", "")) || 0;
  return new Date(guess.getTime() - hours * 3600_000);
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

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

/** Anyone: propose a draft. A voting director may tick "move it now" to skip the draft stage. */
export async function proposeAction(formData: FormData) {
  const member = await requireMember();
  const title = str(formData, "title");
  if (!title) throw new Error("Title required");
  const body = str(formData, "body");
  const closes = str(formData, "closes_at");
  let id: number;
  if (formData.get("move_now") === "on" && member.is_voting) {
    id = await moveMotion(member, { title, body, closes_at: closes ? pacificToUtc(closes).toISOString() : null });
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
  const closes = str(formData, "closes_at");
  await moveMotion(member, {
    motionId: id,
    title: str(formData, "title"),
    body: str(formData, "body"),
    closes_at: closes ? pacificToUtc(closes).toISOString() : null,
  });
  refresh(id);
  redirect(`/motions/${id}`);
}

export async function secondAction(formData: FormData) {
  const member = await requireMember();
  const id = Number(formData.get("motion_id"));
  await secondMotion(member, id);
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
  const choice = str(formData, "choice") as "aye" | "nay" | "abstain";
  if (!["aye", "nay", "abstain"].includes(choice)) throw new Error("Bad choice");
  await castVote(member, motionId, choice);
  refresh(motionId);
  redirect(str(formData, "back") || "/motions");
}

export async function closeMotionAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = Number(formData.get("motion_id"));
  await closeMotion(admin, id);
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
