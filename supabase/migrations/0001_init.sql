-- podstart schema
--
-- Design notes that matter more than the DDL:
--
-- 1. Sync lives in two columns on `tracks`: `start_epoch_ms` (the shared-clock
--    wall time of the FIRST recorded sample) and `drift_ppm` (how fast this
--    device's audio clock actually ran). Together they let the mixer place two
--    independently recorded files on one timeline to within a few samples,
--    which is the whole point of the app.
--
-- 2. Audio is uploaded as many small segments rather than one big file. The
--    Supabase free tier caps a single object at 50 MB and total storage at 1 GB;
--    a one-hour lossless stem is far larger than that. Segments also make the
--    upload resumable and survive a phone locking mid-episode.
--
-- 3. A room `code` is a capability. Anyone holding it may join the room, which
--    is exactly how we let a guest record without creating an account.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- enumerations

create type session_state as enum (
  'idle',       -- room open, nobody armed
  'armed',      -- both ends have a live recorder, waiting on the countdown
  'recording',
  'stopped',    -- capture finished, stems still arriving
  'processing', -- cleanup / mixdown running in a browser
  'ready',      -- stems + mix available
  'failed'
);

create type track_state as enum ('recording', 'uploading', 'complete', 'failed');
create type jingle_kind as enum ('intro', 'outro', 'sting', 'bed');
create type member_role as enum ('host', 'guest');

-- -------------------------------------------------------------------- profiles

create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Untitled host',
  created_at  timestamptz not null default now()
);

-- Every signed-in user (including anonymous guests) gets a profile row.
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      split_part(coalesce(new.email, ''), '@', 1),
      'Guest'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ----------------------------------------------------------------------- rooms

create table rooms (
  id         uuid primary key default gen_random_uuid(),
  -- Six characters from an unambiguous alphabet: no O/0, no I/1/L.
  code       text not null unique check (code ~ '^[A-HJ-KM-NP-Z2-9]{6}$'),
  name       text not null default 'Untitled show',
  owner_id   uuid not null references profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table room_members (
  room_id   uuid not null references rooms (id) on delete cascade,
  user_id   uuid not null references profiles (id) on delete cascade,
  role      member_role not null default 'guest',
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index room_members_user_idx on room_members (user_id);

-- -------------------------------------------------------------------- sessions

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms (id) on delete cascade,
  title      text not null default 'Untitled take',
  state      session_state not null default 'idle',
  created_by uuid not null references profiles (id) on delete cascade,

  -- The scheduled downbeat, in the host's clock. Every participant converts it
  -- through their own measured offset, so both recorders open at the same
  -- instant of real time rather than the same instant of local time.
  downbeat_epoch_ms double precision,
  stopped_epoch_ms  double precision,

  created_at timestamptz not null default now()
);

create index sessions_room_idx on sessions (room_id, created_at desc);

-- ---------------------------------------------------------------------- tracks

create table tracks (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references sessions (id) on delete cascade,
  user_id      uuid not null references profiles (id) on delete cascade,
  display_name text not null default 'Guest',

  sample_rate  int not null check (sample_rate between 8000 and 384000),
  channels     int not null default 1 check (channels between 1 and 2),
  codec        text not null default 'flac' check (codec in ('flac', 'wav')),

  -- See the sync note at the top of this file.
  start_epoch_ms  double precision not null,
  clock_offset_ms double precision not null default 0,
  clock_rtt_ms    double precision,
  drift_ppm       double precision,

  duration_sec  double precision not null default 0,
  segment_count int not null default 0,
  bytes         bigint not null default 0,

  -- What the capture actually achieved, for the quality badge in the UI.
  capture        jsonb not null default '{}'::jsonb,
  state          track_state not null default 'recording',

  created_at timestamptz not null default now(),
  unique (session_id, user_id)
);

create table track_segments (
  id           uuid primary key default gen_random_uuid(),
  track_id     uuid not null references tracks (id) on delete cascade,
  idx          int not null check (idx >= 0),
  path         text not null,
  bytes        bigint not null,
  start_sample bigint not null,
  frames       int not null,
  created_at   timestamptz not null default now(),
  unique (track_id, idx)
);

create index track_segments_track_idx on track_segments (track_id, idx);

-- --------------------------------------------------------------------- jingles

create table jingles (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references profiles (id) on delete cascade,
  room_id      uuid references rooms (id) on delete cascade,
  name         text not null,
  kind         jingle_kind not null default 'sting',
  path         text not null,
  duration_sec double precision not null default 0,
  bytes        bigint not null default 0,
  -- Normalisation measured once on upload so placement is predictable.
  lufs         double precision,
  created_at   timestamptz not null default now()
);

create index jingles_owner_idx on jingles (owner_id, created_at desc);

-- Where a jingle sits on a given take's timeline.
create table session_jingles (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions (id) on delete cascade,
  jingle_id   uuid not null references jingles (id) on delete cascade,
  at_sec      double precision not null default 0,
  gain_db     double precision not null default 0,
  fade_in_ms  int not null default 0,
  fade_out_ms int not null default 400,
  -- How far to duck the voices underneath this bed, 0 for a plain sting.
  duck_db     double precision not null default 0,
  created_at  timestamptz not null default now()
);

create index session_jingles_session_idx on session_jingles (session_id, at_sec);

-- ---------------------------------------------------------------------- mixes

create table mixes (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references sessions (id) on delete cascade,
  path         text not null,
  format       text not null check (format in ('wav', 'mp3', 'opus', 'flac')),
  lufs         double precision,
  true_peak_db double precision,
  duration_sec double precision not null default 0,
  bytes        bigint not null default 0,
  settings     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index mixes_session_idx on mixes (session_id, created_at desc);
