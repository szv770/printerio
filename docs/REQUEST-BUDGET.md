# Request budget: what the website can afford on Cloudflare's free plan

Cloudflare's free plan allows about **100,000 website requests a day in total** (print servers, browsers, scheduled jobs, everything). These numbers are
**calculated from the code's intervals, not measured**; real traffic will differ. The free plan is a beta tool; the $5 Workers Paid plan (10 million requests a month)
is the fallback and the honest answer once there are more than a handful of schools.

## What one print server costs per day
| Print loop poll | Poll calls | Heartbeat (every 30 s) | Total per server |
|---|---|---|---|
| every 3 s (today's default, the owner's server) | 28,800 | 2,880 | **~31,700** |
| every 10 s (recommended for other schools) | 8,640 | 2,880 | **~11,500** |
| every 15 s | 5,760 | 2,880 | **~8,600** |

The poll speed is a per-server setting an admin changes on the Print servers page (it arrives with the heartbeat, 2-300 seconds); no update of the server is needed.
Slower polling means a print can wait up to that long before it starts, so 10 s is the recommendation, not 15.

## The prepare worker costs nothing extra (since step R)
Preparing PDFs on the print server (`PRINTIO_PREPARE_WORKER=1`) used to mean its own claim call every 10 s (+8,640 a day per server). Now the website says "a prepare job is
waiting" inside the poll the print server already makes (`prepareWaiting`), so the worker makes **no calls while nothing is waiting** and picks a file up within one poll
(about 3 s on the owner's server, about 10 s at the recommended speed for other schools). An older website that does not send the field makes the worker fall back to its own timer.

## What else uses requests
- A person watching "Preparing your file..." refreshes about every 3 s while preparing (about 3 to 10 requests per file); My jobs refreshes every 4 s only while a job is active.
- Daily scheduled sweep: a few hundred at most.
- Browsing: a normal page view is a handful of requests.

## What the free plan holds (rough)
- The owner's server alone at 3 s: about a third of the day's budget.
- Each additional school at 10 s: about 11,500, so roughly **6 more schools** before the free plan is full, fewer on busy days.
- **Beyond about 5 schools, pay the $5**: it removes the limit that matters, it is not a failure.

## Not built (and why)
- **Slow polling when idle** (for example 3 s while printing, 10 s after a quiet minute): the admin's poll setting already covers it per server, and it would slow the owner's own
  prints. Build it only if the budget gets tight.
- **Instant pickup with no polling at all**: Supabase Realtime straight from the print server (phase D). The long-term fix.
