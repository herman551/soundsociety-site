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

Sign in at <https://developer.sonos.com> and create a new **Control
Integration**. It gives you a **Key** and a **Secret**. Add this redirect URI
to it, with your own Workers subdomain:

    https://house-alarm.<your-subdomain>.workers.dev/oauth/callback

The address must match exactly, including `https` and the path.

### 2. Deploy the Worker

    npm install
    npx wrangler login
    npx wrangler deploy

    npx wrangler secret put APP_PASSWORD          # the passphrase you will sign in with
    npx wrangler secret put SONOS_CLIENT_ID       # the integration's Key
    npx wrangler secret put SONOS_CLIENT_SECRET   # the integration's Secret

Choose a long passphrase. The page is on the public internet, and the
passphrase is all that stands between it and your speakers.

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
    src/ui.html      The page, in one file.

One Durable Object holds everything. Rather than polling every minute, it sets
a single timer for the next moment anything is due: an alarm, a step of the
fade, a check that the music started, the watcher's next look. Cloudflare
wakes it at that moment.

## Working on it

    npm test             # the schedule and alarm logic, against a pretend Sonos
    npm run typecheck

To run the whole thing on your own machine without touching a real speaker:

    cp .dev.vars.example .dev.vars    # then add the two SONOS_*_BASE lines below
    node dev/fake-sonos.mjs           # a stand-in for Sonos, with three speakers
    npm run dev                       # the Worker, at http://localhost:8787

    SONOS_API_BASE=http://127.0.0.1:8799
    SONOS_AUTH_BASE=http://127.0.0.1:8799

`dev/fake-sonos.mjs` prints everything it is asked to do, and can be told to
misbehave (a favorite that never starts, a speaker dropping offline). See the
top of that file.
