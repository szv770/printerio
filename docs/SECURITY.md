# Printio security: plain-language guide

Written for the owner. No jargon. Last reviewed 2026-10-26 (two independent read-only reviews plus the database scan).

## If something looks fishy: do these in order

1. **Cut the front door.** Turn off the print gateway computer (or unplug its network). This is the only part of Printio that is open to the internet, and it holds the most access. Staff can still use the website; only printing from the phone/laptop print dialog stops.
2. **Rotate the keys** (a new key makes the old, possibly stolen one useless):
   - Supabase dashboard -> Project settings -> API: reset the **service role key** and the JWT secret. Then paste the new service role key into Vercel (Project -> Settings -> Environment Variables) and on the gateway and agent computers, and redeploy.
   - Vercel -> Environment Variables: change `GATEWAY_SHARED_SECRET` (and `CRON_SECRET`), set the same new value on the gateway computer, redeploy.
3. **Look at what happened:** Printio -> Admin -> Audit log, and Admin -> All jobs. Look for jobs, people or settings you do not recognise. Supabase dashboard -> Logs shows sign-ins.
4. **Remove people:** Admin -> Users -> the person -> Remove / disable. Revoke devices you do not recognise (Admin -> Devices).
5. **Tell me** (the next session) exactly what you saw. Do not delete anything yet: the logs are the evidence.

## What is protected (verified)

- Nobody without an account can do anything: the gateway, the agent routes, sign-in and the cleanup routes all need a secret or a login.
- A member cannot edit jobs, files, quotas or their own role/email in the database (migrations 0034, 0037, 0045). Checked live.
- Print jobs cannot smuggle commands into the printer (names are cleaned, the printer's escape code is blocked, no shell is used).
- A hostile PDF is cleaned (scripts, launch actions, attachments removed) and a "decompression bomb" is refused before it is opened.
- One address flooding the gateway can no longer use up everyone's allowance (fixed 2026-10-26).
- A web page on another site cannot drop a file into someone's phone share inbox (fixed 2026-10-26).
- A member can have at most 15 devices.
- Link import and the library can only reach public websites (internal addresses are blocked, redirects re-checked); the library only talks to mafteiach.app.
- Secrets are not in the code. Device addresses are random, and only a hash is stored.

## Known, accepted for now

- **The print gateway computer holds the master database key.** If someone broke into that computer they would have the database. Mitigation today: keep it locked down, rotate keys after any scare (above). Proper fix (later): give the gateway only narrow access.
- **One shared secret guards the gateway's web routes.** If it leaks, rotate it (step 2). A network allowlist would add a second lock.
- Any member can see the printer's internal address and port (not a way in; it is on your private network).
- Someone who knows a person's email can annoy them by locking their emailed-code sign-in for 15 minutes.
- A member can add fake lines to the history of their own job (cosmetic; it does not change what prints).
- Approvers can approve their own jobs (owner decision; and their jobs are now auto-approved).
- The Windows agent updates itself from the code repository. Anyone who could push to the main branch could change what runs on the print computer. Keep GitHub branch protection on (it is) and keep the repo private.
- The content security policy is in report-only mode (a hardening step not yet turned on).
- Two library advisories in the dependency audit (zod in the gateway, a build tool) are not reachable in how we use them.

## Things only you can do

- Turn on "Leaked password protection" in Supabase (Authentication -> Providers -> Email) if you ever turn on passwords. Not needed for emailed links.
- Keep the Tailscale/RDP access to the server to named people, with strong sign-in.
- After any staff member leaves: remove them in Admin -> Users the same day.
