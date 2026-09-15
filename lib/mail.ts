import { Resend } from "resend";

export async function sendMail(opts: { to: string; subject: string; text: string }): Promise<{ delivered: boolean }> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) {
    // Local development: no mail provider configured. The caller shows the link on screen.
    console.log(`\n[mail not configured] To: ${opts.to}\nSubject: ${opts.subject}\n\n${opts.text}\n`);
    return { delivered: false };
  }
  const resend = new Resend(key);
  const { error } = await resend.emails.send({ from, to: opts.to, subject: opts.subject, text: opts.text });
  if (error) throw new Error(`Resend: ${error.message}`);
  return { delivered: true };
}
