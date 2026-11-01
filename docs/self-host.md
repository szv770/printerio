# Running the web app on the Windows PC (instead of Vercel)

Why: Vercel's free plan blocks the account when its CPU quota runs out. The same code runs with `next start`.
Going back is: move the domain and env vars back to Vercel; nothing in the code changes.

## One command (on the PC, in an admin PowerShell, in the repo folder)
```powershell
git pull origin claude/upcoming-large-project-3d2j9p
powershell -ExecutionPolicy Bypass -File .\tools\self-host\setup-web.ps1 -Domain beta.printio.app -SwitchServices
```
It reads Supabase URL, service-role key, gateway secret and base domain from `apps\gateway\.env`, writes the git-ignored
`apps\web\.env.production.local`, builds, registers the scheduled tasks (`Printio Web`, `Printio cron sweep`,
`Printio cron cleanup`), starts the site on `127.0.0.1:3010`, and (with `-SwitchServices`) points the agent and gateway
at it and restarts their services (backups: `.env.bak`). Logs: `tools\self-host\web.log`, `cron.log`.

## Two dashboard steps the script cannot do
1. Cloudflare -> Zero Trust -> Networks -> Tunnels -> the named tunnel -> Public hostnames: add `beta.printio.app` ->
   HTTP -> `localhost:3010`, above the `*.szvtech.org` rule. The `printio.app` zone must be in the same Cloudflare account.
2. Supabase -> Authentication -> URL Configuration: Site URL `https://beta.printio.app`, add `https://beta.printio.app/**`
   to the redirect URLs.

The IPP gateway stays on `szvtech.org` (devices already use it); moving it means everyone re-adds the printer.
