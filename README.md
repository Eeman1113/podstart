# podstart

Record a podcast with someone on the other side of the country.

You both press record once. Each end records **itself**, locally, at full quality — the
distance between you never touches the audio. When you stop, the stems are already
aligned to the sample and the synced mix is a click away.

It is a static site plus a Supabase project. No server to run, nothing to pay for at
your size.

---

## What it actually does

**Synchronised start.** Before every take the two browsers measure the offset between
their clocks the way NTP does — a burst of round trips, keeping the least-delayed
sample. The host then schedules a downbeat a few seconds out, each side converts it
into its own clock, and both recorders open at the same instant of *real* time rather
than the same instant of local time.

**Records what the microphone heard.** podstart explicitly switches **off** the
browser's echo canceller, noise suppressor and auto gain. Those three are WebRTC's
voice-call processor: they narrow the band, collapse toward telephony and pump the
level. They make a bad microphone acceptable and a good one bad — and the damage is
unrecoverable. Your iPhone's microphone is worth keeping, so we keep it.

**Cleans up afterwards instead.** Once you stop, each stem goes through a proper chain:
de-click, rumble filter, RNNoise, room-echo removal, de-ess, then loudness
normalisation to the −16 LUFS podcasts are delivered at. You get the cleaned version
*and* the original, with an A/B switch, and a report of exactly what changed.

**Removes room echo properly.** Not EQ. In each frequency band it tracks the decaying
tail of what that band was doing a moment ago, estimates the room's reverb time from
your own pauses, and subtracts the tail while leaving the direct sound. That is the
thing that makes home recordings sound "far away".

**Corrects clock drift.** Two phones' audio clocks run at slightly different speeds.
Fifty parts per million is 180 ms of slip across an hour — the reason long remote
recordings fall apart even when the start was perfect. podstart measures each device's
drift over the take and resamples it out before mixing.

**Survives bad connections.** The peer connection carries talkback and control only.
If it stutters, drops, or never forms, your recording is untouched. Audio is written
losslessly to local storage as you talk and uploaded in 30-second segments with
backoff, so a lift, a tunnel, or a locked phone costs you a retry, not a take.

**Raw mode, meaning raw.** Any take can be marked raw before you record. Then nothing
is ever applied to its samples: no denoise, no dereverb, no loudness, no limiter, no
head trim, and no drift resampling. Stems upload and export as 32-bit float — bit-for-bit
what the microphone produced — and the alignment is delivered as numbers in a text file
for you to apply in your own editor. It is a single switch rather than a row of sliders
set to zero, because zeroed sliders would still leave the mastering stage running and the
label would be a lie. Costs about twice the storage, since FLAC cannot carry float.

**Jingles.** Drop in an intro, outro or bed. They are placed on the timeline at exact
offsets with fades, and a bed automatically ducks both voices underneath it.

---

## Setup

### 1. Supabase (about three minutes)

Create a free project at [supabase.com](https://supabase.com), then:

```bash
npm install -g supabase
supabase link --project-ref <your-project-ref>
supabase db push
```

That applies the four migrations in `supabase/migrations`: schema, row-level security,
the room functions, and the storage buckets.

In the dashboard, under **Authentication → Providers**, enable **Anonymous sign-ins**.
That is what lets your friend record without making an account — the room code is the
credential.

### 2. Local

```bash
cp .env.example .env.local     # add your project URL and anon key
npm install
npm run dev
```

Open <http://localhost:3000>. Both keys are public by design in a static bundle; every
table is protected by row-level security instead.

### 3. Deploy to GitHub Pages

Push to `main`. Then in the repo:

- **Settings → Pages → Source**: GitHub Actions
- **Settings → Secrets and variables → Actions → Variables**: add
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`

The workflow in `.github/workflows/deploy.yml` handles the rest, including setting the
base path to your repo name.

Finally, add your Pages URL to Supabase under **Authentication → URL Configuration →
Redirect URLs**.

---

## Recording an episode

1. Both of you open the site and **run the device check** (`/check`). Ten seconds, and
   it tells you what that browser will really do. Do this once per device, not on the
   night.
2. One of you presses **Start a room** and reads the six-character code to the other.
3. Both allow the microphone. Watch the levels — aim for the green band, roughly
   −18 to −6 dB.
4. Press record. There is a three-second count-in, then you are both rolling.
5. Press stop. Open the take, run the cleanup, place your jingles, build the mix.
6. Download it, then **clear the take's audio** to free the 1 GB.

### Two things that matter more than any setting

**Wear headphones.** Both of you. Without them each microphone records the other
person's voice out of your speakers, and bleed between stems is the one problem no
amount of processing fully undoes.

**Keep the screen awake and the tab in front.** A backgrounded mobile browser stops
recording. podstart takes a screen wake lock and warns you if the tab loses focus, but
a web page cannot override this. On iPhone in particular, do not switch apps.

---

## Known limits, stated plainly

- **iOS talkback costs quality.** When a WebRTC audio stream is playing, iOS forces the
  whole audio session into voice-chat mode and routes your microphone down the
  echo-cancelled path regardless of the constraints we asked for. There is no
  workaround available to a web page. If you want the best possible recording on an
  iPhone, mute talkback in the studio and keep a normal phone call going for
  conversation. The app detects this and offers the switch.
- **Microphone hardware latency is not measurable** from a browser on every platform.
  Chrome reports it; others do not. The gap is typically 10–40 ms and consistent per
  device, so Settings has a per-device calibration offset and the mixer has a manual
  nudge. For talking, the automatic alignment is already well inside what anyone can
  hear.
- **Free tier storage is 1 GB**, and an hour of lossless audio from two people is around
  600 MB as FLAC. One episode fits comfortably. Clear each take after you have
  downloaded it, or upgrade. The lossless copy on your own device is independent of
  this.
- **Safari before 17** lacks pieces of the storage and WebCodecs APIs. The device check
  will say so rather than letting you find out afterwards.

---

## How it is put together

```
app/                    Four screens: landing, studio, episode, device check
  studio/               Live recording: the split waveform, transport, meters
  episode/              Cleanup, jingles, mixdown, export
  check/                Capability probe — runs the real workers, not stubs

components/
  WaveformTape.tsx      The split waveform: friend above, you below, one cue line

lib/
  audio/                Capture, recorder, clock anchoring, WAV, envelopes
  dsp/                  FFT, STFT, denoise, dereverb, filters, loudness, pipeline
  mix/                  Drift correction, resampling, the aligned mixdown
  room/                 Peer connection, signalling, NTP-style clock sync
  store/                Supabase repository, upload queue, React hooks

public/
  worklets/capture.js   Runs on the audio thread. Plain JS: worklets load by URL
  workers/recorder.js   OPFS writes and FLAC encoding, off the main thread
  vendor/               RNNoise and libFLAC wasm, copied in by scripts/vendor.mjs

supabase/migrations/    Schema, RLS, room functions, storage buckets
```

Two design notes worth knowing before you change anything:

**Sync lives in two numbers per track.** `start_epoch_ms` — the shared-clock instant of
that track's first sample — and `drift_ppm`. Everything else about alignment is
arithmetic over those. Nothing listens to the audio to line it up.

**Audio uploads as segments, not files.** The free tier rejects objects over 50 MB and
a lossless hour is far more. Segmenting also makes the upload resumable and means a
phone locking mid-episode costs thirty seconds, not the take.

## Commands

```bash
npm run dev         # local, with the wasm modules vendored automatically
npm run build       # static export into out/
npm run typecheck
npm run check       # typecheck + build, what CI runs
npm run db:push     # apply migrations to the linked Supabase project
```
