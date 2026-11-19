# Timing the print server's PDF preparation on your real files

Why: the website is moving to a host that cannot do PDF work, so your print server will. You said a few seconds is fine and minutes is not.
This measures it on YOUR server with YOUR kinds of files. It never touches the website, the database or a printer.

## What to gather (5 minutes)
Put these in one folder on the print server, for example `C:\printio-bench\in` (real files from your school, not private ones you cannot share):
1. a scan (a photographed or scanned document)
2. a Word export
3. a long file (about 100 pages)
4. a Hebrew file (a booklet you really print)
5. anything that has ever printed wrongly or slowly

## Run it (on the print server, in the Printio folder)
```bash
pnpm install --frozen-lockfile
pnpm --filter @printio/agent exec tsx scripts/prepare-bench.ts C:\printio-bench\in --out C:\printio-bench\out
```
(If you do not have `pnpm` on that machine, press **Update this server** first; the update installs it.)

It tries each file four ways: plain, pages 1-3, booklet left, booklet right. It prints a table and saves the prepared files into `out` so you can open them.

## What to send back
Copy the whole table it prints and paste it here. Also open two or three files from `out` and tell me if they look right.

## How to read it
- **seconds**: about 10 or less is the target. Over 60 would fail on a real job (the server stops at 60 s with a plain message). If any file is close, tell me; the limit and the steps are settings.
- **result**: "original as is" means nothing needed changing, so nothing is uploaded.
- **fingerprint**: the same file gives the same fingerprint on every machine (the clock is frozen). Send me your table and I run the same files here: matching fingerprints prove the print server produces the same output as the website did.
- **CRASH** on any line: send me that line, it is a bug I want to fix before anyone depends on this.

## Honest limits
Run time on a very busy server may be slower than this test. Nothing here proves the Kyocera prints it correctly; that is a separate print test.
