import { Resend } from "resend";

export type Mail = {
  to: string | string[];
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
};

function config(): { resend: Resend; from: string } | null {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) return null;
  return { resend: new Resend(key), from };
}

function logUnsent(m: Mail) {
  // Local development: no mail provider configured. The caller shows the link on screen or carries on.
  const att = m.attachments?.length ? `\n[attachments: ${m.attachments.map((a) => `${a.filename} (${a.content.length} bytes)`).join(", ")}]` : "";
  console.log(`\n[mail not configured] To: ${Array.isArray(m.to) ? m.to.join(", ") : m.to}\nSubject: ${m.subject}\n\n${m.text}${att}\n`);
}

export async function sendMail(m: Mail): Promise<{ delivered: boolean }> {
  const c = config();
  if (!c) { logUnsent(m); return { delivered: false }; }
  const { error } = await c.resend.emails.send({
    from: c.from, to: m.to, subject: m.subject, text: m.text,
    attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content })),
  });
  if (error) throw new Error(`Resend: ${error.message}`);
  return { delivered: true };
}

/**
 * Several individually addressed messages in one API call (Resend allows 100 per batch and only a
 * couple of calls per second, so one reminder run must not be one call per director).
 * Batch sends cannot carry attachments.
 */
export async function sendMailBatch(mails: Mail[]): Promise<{ delivered: boolean }> {
  if (mails.length === 0) return { delivered: true };
  if (mails.some((m) => m.attachments?.length)) throw new Error("sendMailBatch: attachments are not supported in a batch");
  const c = config();
  if (!c) { mails.forEach(logUnsent); return { delivered: false }; }
  for (let i = 0; i < mails.length; i += 100) {
    const chunk = mails.slice(i, i + 100);
    const { error } = await c.resend.batch.send(chunk.map((m) => ({ from: c.from, to: m.to, subject: m.subject, text: m.text })));
    if (error) throw new Error(`Resend: ${error.message}`);
  }
  return { delivered: true };
}
