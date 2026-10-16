# Printio IPP spike (Phase 0)

A fake IPP printer that accepts anything and records exactly what each device sends, so we
can decide per platform whether native printing works. No dependencies, Node 20+. Design:
[docs/ipp-printing.md](../../docs/ipp-printing.md). **Not production code.**

## Run it on a Raspberry Pi (or any PC)

```bash
# 1. Node 20+ (Pi OS: https://nodejs.org or `sudo apt install nodejs` if >= 20)
git clone <this repo> && cd printerio/tools/ipp-spike
node server.mjs            # prints a local setup URL containing your secret token

# 2. In a second terminal: a free temporary HTTPS URL (no account, no router changes).
#    Install cloudflared for your Pi (arm64/armhf): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:8631
#    -> prints https://something-random.trycloudflare.com
```

The tunnel URL changes each time you restart cloudflared. Phones need HTTPS, so always test
through the tunnel URL, not the Pi's local address.

## Test (about 2 minutes per device)

On each device open `https://<tunnel-host>/setup/<token>` (token is printed by the server and
stored in `spike-data/token`). Follow that device's steps, then print a PDF/photo/webpage
with 2 copies and double-sided. Note on each device: was adding the printer easy, did the
print dialog show it, and did anything error?

## Send the results back

Open `https://<tunnel-host>/report/<token>` and paste it into the chat (it contains no secret;
the token is redacted). It lists, per device: which operations it used, the file format it
actually sent, and the options chosen. Received documents are in `spike-data/jobs/`.

## Notes

- `SPIKE_FORMATS=application/pdf node server.mjs` advertises PDF only (forces devices to send
  PDF if they can). Default also offers PWG raster / JPEG so we can see what Windows prefers.
- `PORT`, `PUBLIC_BASE`, `SPIKE_DATA`, `SPIKE_TOKEN` are optional env overrides.
- Tests: `node --test`.
- Everything is accepted and marked "completed" - nothing is printed.
