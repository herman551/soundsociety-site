# House Alarm

A whole-house alarm clock for Sonos. At the time you set, it starts a playlist
on the speakers you choose, fades it in, and keeps an eye on things so the
alarm does not fail silently.

It runs as a Cloudflare Worker and talks to Sonos through Sonos's own cloud
API, so there is nothing to keep switched on at home.

## What it does

- **Alarms** with a time, days of the week (or once), a name, what to play,
  which speakers to ring on, a volume and a fade-in.
- **Fade-in** from a quiet starting volume. The fade is timed from when the
  music is confirmed playing, so a slow start still comes in gently.
- **Skips**: skip just the next occurrence, or set days away during which
  repeating alarms stay quiet.
- **Snooze and Stop** from a page on your phone, plus stopping by itself after
  a time you choose.
- **A fallback** if the music does not start: try again, then a backup
  favorite, then the Sonos chime on repeat.
- **Speakers**: every speaker in the household is found automatically. See what
  each is playing, set volumes, group and separate them, pause everything.
- **A watcher** that looks over the system every 15 minutes, and 10 minutes
  before each alarm. It notices a speaker going offline, Sonos signing the app
  out, an alarm's playlist being removed from Favorites, and a fixed-volume
  line-out. It can post alerts to your phone.

Speakers are grouped for an alarm so they play in step, then put back the way
they were when the alarm is stopped. Volumes are put back too.

## Set it up

You need a Cloudflare account, a Sonos account, and Node 20 or later. Run
every command below from this `house-alarm` folder.

### 1. Create a Sonos integration

Sign in at <https://developer.sonos.com>. A new account first has to fill
in **More → Account** (name, address, Integration Type **Control Partner**,
and the two agreements) before it can make anything.

Then go to **Dashboard → Control Integrations → New Control Integration**.
For **Integration Type** choose **Smart Home Control Integration** (the cloud
API; Direct Control is the local one). Add this redirect URI, with your own
Workers subdomain:

    https://house-alarm.<your-subdomain>.workers.dev/oauth/callback

The address must match exactly, including `https` and the path. Fill in a
tech contact on the Contact page, then **Submit**.

Once it is active, the **Client Credentials** card further down the page
shows a **Key** and a **Secret**. It loads a few seconds after the page.
Use that Key. The "Your Client ID" at the top of the section looks similar
but is not it: Sonos's sign-in page rejects it with "Oops, there was a
problem".

### 2. Deploy the Worker

    npm ci
    npx wrangler login
    npx wrangler deploy
    scripts/set-secrets.sh

`set-secrets.sh` asks for the three secrets in turn and says which one each
prompt wants: `APP_PASSWORD` (a passphrase you make up), `SONOS_CLIENT_ID`
(the Key) and `SONOS_CLIENT_SECRET` (the Secret). Wrangler hides what you
type. To change just one later, name it: `scripts/set-secrets.sh SONOS_CLIENT_SECRET`.
Changing the passphrase signs every browser out.

Choose a long passphrase. The page is on the public internet, and the
passphrase is all that stands between it and your speakers.

If connecting Sonos ends with "Sonos turned down the integration's Secret",
`SONOS_CLIENT_SECRET` is wrong: Sonos answers a bare `invalid_request` for a
wrong Key or Secret and says nothing more.

### 3. Add your music to Sonos Favorites

Alarms play from **Sonos Favorites**. In the Sonos app, add the Spotify
playlist you want to wake to, and a radio station to use as the backup.
Starting music through Favorites is the route Sonos documents, and it avoids
depending on Spotify's own developer API.

### 4. Connect and test

Open the Worker's address on your phone and sign in. Tap **Connect Sonos** and
approve. Your speakers appear by themselves. Add an alarm, open it again, and
tap **Ring it now as a test** before you trust it with a morning.

On an iPhone, use Share → Add to Home Screen to keep it as an app.

### 5. Alerts (optional)

In Settings → Alerts, enter an address to post to. The simplest is a topic on
<https://ntfy.sh>: pick a long, unguessable topic name, enter
`https://ntfy.sh/<that-topic>`, install the ntfy app and subscribe to the same
topic. Any webhook that accepts a plain-text POST works too.

## Things to know

- **Line-out volume.** A Sonos Port or Connect feeding an amplifier may have
  its Line-Out Level set to Fixed. Then Sonos refuses volume changes, so the
  alarm plays but cannot fade in or set its level. Set it to Variable in the
  Sonos app. The watcher tells you if this is the case.
- **It needs the internet.** The Worker reaches your speakers through Sonos's
  cloud. If your home internet or Sonos's service is down at alarm time, the
  alarm cannot ring. If that matters, keep a bedside alarm as a last resort.
- **It only sees what Sonos's cloud reports.** It knows which speakers are
  online, how they are grouped and what they are playing. It cannot see Wi-Fi
  strength or IP addresses, and it cannot restart a speaker. Those would need
  a small program running inside your home network.
- **Alarm level.** Each speaker has an alarm level (tap its name in the
  Speakers list). Turn it down for a speaker that is much louder than the
  others at the same number.
- **Auto-stop pauses whatever is playing** on the alarm's speakers when its
  time is up, unless you tapped "I'm up — keep the music playing" or stopped
  the music from another app.

## How it works

    src/index.ts     The Worker: serves the page, checks the passphrase.
    src/clock.ts     A Durable Object: storage, Sonos sign-in, and the timer.
    src/engine.ts    The alarm clock: schedules, ringing, fallbacks, the watcher.
    src/schedule.ts  Time-zone arithmetic, including clock changes.
    src/sonos.ts     The Sonos cloud API calls it uses.
    src/settle.ts    Covers for Sonos reporting grouping changes late.
    src/ui.html      The page, in one file.
    scripts/set-secrets.sh  Sets the Worker's secrets, one labelled prompt each.

One Durable Object holds everything. Rather than polling every minute, it sets
a single timer for the next moment anything is due: an alarm, a step of the
fade, a check that the music started, the watcher's next look. Cloudflare
wakes it at that moment.

## Working on it

    npm test             # the schedule and alarm logic, against a pretend Sonos
    npm run typecheck

To see exactly what Sonos answers, deploy with `npx wrangler deploy --var
SONOS_DEBUG:1`. While signed in, `/api/debug/sonos` then lists the last 40
Control API calls with Sonos's replies (never tokens). The next plain
`npx wrangler deploy` turns it off.

After a deploy, the Durable Object keeps running the old code while the page
is open and polling somewhere. Close it for half a minute and it restarts on
the new code.

To run the whole thing on your own machine without touching a real speaker:

    cp .dev.vars.example .dev.vars    # then add the two SONOS_*_BASE lines below
    node dev/fake-sonos.mjs           # a stand-in for Sonos, with three speakers
    npm run dev                       # the Worker, at http://localhost:8787

    SONOS_API_BASE=http://127.0.0.1:8799
    SONOS_AUTH_BASE=http://127.0.0.1:8799

`dev/fake-sonos.mjs` prints everything it is asked to do, and can be told to
misbehave (a favorite that never starts, a speaker dropping offline, a group
list that lags like the real one). See the top of that file.

## What the real Sonos API does

Checked against a real household of three Ports on 2026-11-14:

- `createGroup` and `setGroupMembers` answer at once with the group they
  made (`{"group": {...}}`), but the household's group list shows the change
  late: 11 seconds for a join, about 2 for a split. `src/settle.ts` lays those
  answers over the list until it catches up.
- A group keeps its id while its coordinator stays in it. A created group
  gets a new one: the number after the colon goes up.
- Favorites come back as `{"items": [...]}`, as expected.
- A Port reports `FIXED_VOLUME` among its capabilities whether or not its
  line-out is set to Fixed; `playerVolume`'s `fixed` says which it is.
