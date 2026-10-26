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
- A member can have at most 15 devices, at most 10 jobs waiting at once, and no single job may use more than 300 sheets of paper (fixed 2026-10-26).
- The booklet builder refuses files over 500 pages or booklets over 1000 pages.
- Link import and the library can only reach public websites (internal addresses are blocked, redirects re-checked); the library only talks to mafteiach.app.
- Secrets are not in the code. Device addresses are random, and only a hash is stored.

## "Could someone use the website to hack the print computer and reach the whole network?"

Short answer: not directly, and not through the website. But it is the right worry, so here is the honest picture.

- **The website (Vercel) and the print computer are separate.** A person using the website only talks to Vercel and Supabase. They never touch your computers.
- **The one internet-facing piece on your side is the print gateway** (the program that receives prints from phones and laptops through the Cloudflare tunnel). The tunnel is an outgoing connection from your computer: no door is opened in your router. An outsider can only send the gateway print requests, and only to addresses that hold a secret token.
- **The real risk is a bug in how the gateway reads those requests.** If someone found one, they would run commands on that computer with whatever power the gateway has. Two reviews and 200+ gateway tests found no such bug, but "none found" is not "none exist".
- **What limits the damage is how much power that program has.** Today the gateway and the agent are installed as Windows services without a named account, which means they run as **LocalSystem, the most powerful account on the computer**. That is the thing to fix. A small bug becomes a big problem only because of it.

### The fix: run the two services as a limited account

Your server's two services are `printioippgateway.exe` (Printio IPP Gateway) and `printioprintagent.exe` (Printio Print Agent). Both run as LocalSystem today (checked 2026-10-26). One script changes that safely: `docs/hardening/limit-printio-services.ps1`.

1. In Printio Admin, press **Update this server** so the server has the script.
2. On the server, open PowerShell **as administrator** and go to the script's folder:
   `cd "C:\Users\MLM Office\printerio\docs\hardening"`
3. **Preview** (changes nothing, shows every step): `powershell -ExecutionPolicy Bypass -File .\limit-printio-services.ps1`
   (Run it from your own administrator window on the server. The `-ExecutionPolicy Bypass` part only gets past Windows' default block on scripts you downloaded.)
4. **Do it**: the same command with `-Apply` on the end.
5. **Check** (the script lists these too): Admin -> Agents shows the print program online; print a test page from your phone; press **Update this server** once and confirm it finishes.
6. **Undo, if anything is off**: the same command with `-Revert`. It puts both services back exactly as they were.

What it does: creates the account `printio-svc` (not an administrator, cannot sign in or use Remote Desktop, a random password nobody knows), lets it use only the Printio folder and the data folder, switches the gateway and then the agent over one at a time (and undoes a switch by itself if the service does not come back), tells git the Printio folder is safe for that account, and allows it to restart the gateway so the update button keeps working. Your own Remote Desktop, SSH and Tailscale logins are untouched.

**Phase 2: a firewall rule** (script `docs/hardening/firewall-printio-svc.ps1`). It blocks only the `printio-svc` account from starting connections to other computers on your private networks (office LAN, Tailscale). That account can still reach the internet, the printer and your DNS servers. Your own logins and Remote Desktop, SSH, Tailscale and cloudflared are different accounts and are untouched.

1. In Printio Admin press **Update this server**, then on the server open PowerShell **as administrator** and `cd "C:\Users\MLM Office\printerio\docs\hardening"`.
2. **Preview** (changes nothing; shows exactly what is blocked and allowed): `powershell -ExecutionPolicy Bypass -File .\firewall-printio-svc.ps1`
3. **Turn on**: same command with `-Apply`. The rule **removes itself after 10 minutes** unless you confirm, so a mistake cannot leave printing broken.
4. **Check within 10 minutes**: Admin -> Agents shows the print program online; print a test page; press **Update this server** once.
5. **Keep it**: same command with `-Keep`. Or remove it any time with `-Revert`.

The printer address defaults to 192.168.100.168 (add `-PrinterIp x.x.x.x` if yours differs).

**Adding another printer later** is one short command, with no 10-minute wait: `powershell -ExecutionPolicy Bypass -File .\firewall-printio-svc.ps1 -AddPrinter 192.168.100.170`. The script remembers every printer you give it. If a new printer shows as unreachable in Printio, that is the first thing to run.

**If "Update this server" says "The update did not finish ... EPERM ... lstat 'C:\Users\...\AppData'"** (it works on a retry): the update's `pnpm install` runs as the limited account and cannot see pnpm's package store inside your own profile. Fix once with `docs/hardening/fix-update-permissions.ps1`: preview with `powershell -ExecutionPolicy Bypass -File .\fix-update-permissions.ps1`, apply by adding `-Apply`. It lets the account walk through (attributes only) to the store and gives it change access to the store folder only.

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
