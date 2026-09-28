# YWI Board Votes: setup and operations

Live site: https://ywi-board-vote.vercel.app
Vercel project: ywi-board-vote (team "Chris Friedel's projects")

The code is deployed. It will not work until the four steps below are done; they need
your Vercel, Resend, and DNS logins, so I can't do them from here. Budget about 20 minutes,
plus DNS propagation time.

## 1. Database (Neon, free, via Vercel)

1. Vercel dashboard > project ywi-board-vote > Storage tab > Create Database > Neon.
2. Accept the free plan, region US East (Vercel runs this project in iad1), and connect it
   to ywi-board-vote for all environments.
3. This adds `DATABASE_URL` (and a few `PG*`/`POSTGRES_*` variables) to the project automatically.
   The app only reads `DATABASE_URL`.

The schema is created automatically on first use, and the roster is seeded from `BOARD_ROSTER` if the
members table is empty. Nothing to run by hand.

Neon's free tier suspends compute after 5 minutes idle and resumes on the next request; the data
is never paused or deleted for inactivity. First page load after a quiet quarter takes a second or two.

## 2. Email (Resend, free)

1. Sign up at resend.com with chris@yubawatershedinstitute.org.
2. Domains > Add Domain > `yubawatershedinstitute.org`. Resend shows two or three DNS records
   (a DKIM TXT record and an SPF MX+TXT pair on a `send.` subdomain). Add them wherever the
   domain's DNS is hosted, then click Verify. This does not affect your existing Google Workspace mail.
3. API Keys > Create API Key, "Sending access" only. Copy it; it is shown once.

## 3. Environment variables (Vercel)

Vercel > ywi-board-vote > Settings > Environment Variables. Add these for Production:

| Name | Value |
|---|---|
| `RESEND_API_KEY` | the key from step 2 |
| `MAIL_FROM` | `YWI Board Votes <vote@yubawatershedinstitute.org>` |
| `SESSION_SECRET` | a long random string; run `openssl rand -base64 32` in Terminal |
| `APP_URL` | `https://ywi-board-vote.vercel.app` (change if you add a custom domain) |
| `ADMIN_EMAILS` | `chris@yubawatershedinstitute.org` |
| `BOARD_ROSTER` | JSON list of members (kept out of the public repo). I gave you the exact value in BOARD_ROSTER.txt; paste it as one line. Used only to seed an empty roster and to run one-time imports. |
| `CRON_SECRET` | another long random string (`openssl rand -base64 32`). Vercel sends it with each scheduled reminder run so nobody else can trigger one. Without it the schedule does nothing. |
| `REMINDER_AFTER_DAYS` | optional, default `2`: how long a motion has been open before a director who hasn't voted gets the first reminder. |
| `REMINDER_EVERY_DAYS` | optional, default `3`: how often to repeat the reminder while they still haven't voted. |

Then Deployments > latest > "..." > Redeploy so the variables take effect.

## 4. First sign-in and roster cleanup

1. Go to the site, enter your email, click the link.
2. Admin > Roster: fix the names I could only guess from email addresses (Kurt, Becky, Amber
   have no surnames), and untick "Voting" for anyone who should not count toward unanimity.
   You are seeded as admin and non-voting. Daniel is seeded as admin so he can open motions too.

## Running a vote

Motions have a life cycle: Suggested (draft) > Moved > Open for voting > Closed.

1. Anyone signed in, including you, can suggest a motion from the Motions page: wording, optional
   details, optional note to the board. It sits under "Suggested" until a director picks it up.
2. Any voting director opens the draft and moves it, either as written or after editing the wording
   (edits are recorded as an amendment of the draft). The mover picks Aye, Nay, or Abstain in the same
   click ("Move and vote Aye"); that vote is held until a second opens voting, then recorded. A director
   can also write and move a new motion in one step with the "Move it now" box.
3. A different voting director clicks "Second and vote Aye" (or Nay, or Abstain). That opens voting,
   records the seconder's vote and the mover's held vote, and emails the mover that voting is open.
   Everyone else clicks Aye/Nay/Abstain on the motion page. Any vote can be changed until the motion closes.
4. The motion page shows who has and hasn't voted, and the app nudges directors itself about motions
   waiting for a second or for their vote (see "Automatic emails").
   If a director sends their vote by email instead (for example, they could not sign in), an admin
   can record it from the motion page under Admin > "Record a vote received by email". It is marked
   "by email" in the tally and on the PDF, the note goes to the activity log, and it never overwrites
   a vote the director cast in the app themselves.
5. Voting closes by itself the moment the last voting director's vote is in. If it never gets there
   (say the deadline passes with a director silent), an admin clicks "Close voting". Either way,
   everyone on the roster and the admins are emailed the result, the tally, and each director's vote.
   The written-consent PDF is not emailed: an admin downloads it from the motion page, the Secretary
   signs it, and it is filed with the minutes. Directors can download the record from the motion page.

   Each ballot is labelled for the minutes file when voting opens, numbered per year in the order
   voting opened: "2026 Consent 1", "2026 Consent 2", and so on. The label is on the motion page, in
   the emails, on the PDF, and in the PDF's file name, which ends with the close date:
   `2026 Consent 1 - Approve the August minutes 2026 09 28.pdf`.

   Only a director's first vote on a motion can close it, never a changed vote. So an admin can
   "Reopen voting" to let a director change their mind without the change closing it again; the admin
   closes it by hand afterwards.

Withdrawals: the mover can withdraw before a second; the drafter or an admin can withdraw a draft.
Once seconded, wording is frozen; to change it, withdraw and re-move.

## Automatic emails

Besides the sign-in link, the app sends three kinds of email, all from `MAIL_FROM`:

- **Seconded** (to the mover): a director seconded their motion, so voting is open.
- **Vote closed** (to every active member, voting or not, plus every address in `ADMIN_EMAILS` even
  if it is not on the roster): sent when voting closes, whether by itself on the last vote or by an
  admin's click. Result, tally, each director's vote, how it closed, and a link to the motion. The
  PDF is deliberately not attached; the Secretary signs it and files it with the minutes. Reopening and closing again
  sends it again.
- **Reminder** (to each voting director something is waiting on): one email per director listing the
  open motions they haven't voted on and the moved motions (by someone else) that still need a
  second, with links. A scheduled job (`vercel.json`, daily at 16:00 UTC, which is 9 am PDT / 8 am PST)
  checks each morning: a director is reminded once an item has been waiting `REMINDER_AFTER_DAYS`
  (default 2, counted from when voting opened or the motion was moved) and again every
  `REMINDER_EVERY_DAYS` (default 3) until they act or the motion moves on. Open motions whose deadline
  has passed are skipped, since voting is locked then. Every reminder is recorded (table
  `vote_reminders`) and summarized in the activity log.

  An admin can also send the reminder immediately from the motion page ("Email a reminder to the N who
  haven't voted", or on a moved motion "... to the N who can second"); that ignores the schedule.
  Opening `/api/cron/reminders` in the browser while signed in as admin runs the scheduled check by
  hand and shows who was emailed.

  Vercel's free (Hobby) plan allows cron jobs that run once a day, and the run may land anywhere
  within the scheduled hour. That is all this needs. If you want reminders more often than daily,
  Vercel Pro allows any schedule; change `schedule` in `vercel.json`.

If mail fails (for example the Resend key is missing or revoked), the vote, close, or reminder is still
recorded and a `mail_failed` line appears in the activity log on the Admin page.

## What the PDF says, and why

California Corporations Code 5211(b): a nonprofit board can act without a meeting only by
unanimous written consent of all directors. The PDF therefore comes in two flavors:

- All voting directors aye: titled "Unanimous Written Consent", states the action is effective.
- Anything else (a nay, an abstention, or a director who never voted): titled "Record of Board Vote
  Taken by Electronic Ballot", states it documents positions and should be ratified at the next
  noticed meeting. That is what Daniel proposed for the current four motions.

Check this reading against the bylaws; I am not a lawyer.

## Security model, briefly

- Only emails on the roster can request a link. Unknown addresses are refused and logged.
- Links are random 256-bit tokens, hashed in the database, single use, 20-minute expiry.
- The link opens a page with a "Sign in" button, and only that button press uses up the token. Mail
  providers (Outlook/live.com in particular) open every link in an incoming email to scan it; before
  this step existed, that scan consumed the token and the member's own click reported "expired".
- Sessions are signed cookies (30 days). "Sign out" clears them.
- Every login, vote, motion open/close, and roster change is written to the activity log on the Admin page.
- Votes are visible to all signed-in members (open ballot, as board votes are). Nothing is public.

## Local development

```
cp .env.local.example .env.local   # fill in DATABASE_URL to a local Postgres
npm install && npm run dev
```
Without `RESEND_API_KEY`, the sign-in link is shown on screen instead of emailed.

## Source control

Repo: https://github.com/Yuba-Watershed-Institute/ywi-board-vote (public; it contains no addresses,
keys, or vote data, all of which live in Vercel environment variables and the Neon database).
Pushes to `main` deploy to production automatically.

## Optional later

- Custom domain (vote.yubawatershedinstitute.org): Vercel > Settings > Domains, add a CNAME, update `APP_URL`.
- Auto-close at deadline: the reminder cron could also close motions whose deadline has passed and
  send the close email; ask when you want it.
