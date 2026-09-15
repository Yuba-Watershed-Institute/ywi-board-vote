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
2. Any voting director opens the draft and clicks "Move this motion", either as written or after
   editing the wording (edits are recorded as an amendment of the draft). A director can also write
   and move a new motion in one step with the "Move it now" box.
3. A different voting director clicks "Second". That opens voting automatically and prompts the
   seconder to vote. Moving or seconding does not record a vote; everyone clicks Aye/Nay/Abstain.
4. Email the board a heads-up with the site link when something needs a second or a vote. The motion
   page shows who has and hasn't voted.
5. When all votes are in (or the deadline passes), an admin clicks "Close voting" and downloads the
   written-consent PDF for the minutes file.

Withdrawals: the mover can withdraw before a second; the drafter or an admin can withdraw a draft.
Once seconded, wording is frozen; to change it, withdraw and re-move.

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
- Auto-close at deadline and email you the PDF: a small cron function; ask when you want it.
