-- Row-level security.
--
-- The model is simple: membership of a room is the unit of access. Hold the
-- room code and you can join; once you are a member you can see and contribute
-- to that room's takes, and nothing else in the database.

alter table profiles        enable row level security;
alter table rooms           enable row level security;
alter table room_members    enable row level security;
alter table sessions        enable row level security;
alter table tracks          enable row level security;
alter table track_segments  enable row level security;
alter table jingles         enable row level security;
alter table session_jingles enable row level security;
alter table mixes           enable row level security;

-- Membership test, factored out so the policies stay readable and the planner
-- sees one stable function. security definer so it does not recurse into the
-- policies on room_members itself.
create function is_room_member(target_room uuid) returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.room_members m
    where m.room_id = target_room and m.user_id = auth.uid()
  );
$$;

create function session_room(target_session uuid) returns uuid
language sql security definer stable set search_path = '' as $$
  select s.room_id from public.sessions s where s.id = target_session;
$$;

-- ------------------------------------------------------------------- profiles

create policy "read own profile and co-members"
  on profiles for select using (
    id = auth.uid()
    or exists (
      select 1 from room_members mine
      join room_members theirs on theirs.room_id = mine.room_id
      where mine.user_id = auth.uid() and theirs.user_id = profiles.id
    )
  );

create policy "update own profile" on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------- rooms

create policy "read rooms you belong to"
  on rooms for select using (owner_id = auth.uid() or is_room_member(id));

create policy "create own rooms"
  on rooms for insert with check (owner_id = auth.uid());

create policy "owner updates room"
  on rooms for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "owner deletes room"
  on rooms for delete using (owner_id = auth.uid());

-- --------------------------------------------------------------- room_members

create policy "read members of your rooms"
  on room_members for select using (user_id = auth.uid() or is_room_member(room_id));

-- Joining is done through join_room(code); this covers the owner's own row.
create policy "add yourself to a room"
  on room_members for insert with check (user_id = auth.uid());

create policy "leave a room"
  on room_members for delete using (user_id = auth.uid());

-- ------------------------------------------------------------------- sessions

create policy "members read sessions"
  on sessions for select using (is_room_member(room_id));

create policy "members create sessions"
  on sessions for insert with check (is_room_member(room_id) and created_by = auth.uid());

create policy "members update sessions"
  on sessions for update using (is_room_member(room_id)) with check (is_room_member(room_id));

create policy "members delete sessions"
  on sessions for delete using (is_room_member(room_id));

-- --------------------------------------------------------------------- tracks

create policy "members read tracks"
  on tracks for select using (is_room_member(session_room(session_id)));

-- You may only ever write your own track. This is what stops one participant
-- from clobbering the other's recording.
create policy "write own track"
  on tracks for insert with check (
    user_id = auth.uid() and is_room_member(session_room(session_id))
  );

create policy "update own track"
  on tracks for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------- track_segments

create policy "members read segments"
  on track_segments for select using (
    exists (
      select 1 from tracks t
      where t.id = track_id and is_room_member(session_room(t.session_id))
    )
  );

create policy "write segments of own track"
  on track_segments for insert with check (
    exists (select 1 from tracks t where t.id = track_id and t.user_id = auth.uid())
  );

-- The uploader upserts a segment when it retries, which needs UPDATE as well
-- as INSERT. Without this every retried upload fails on the second attempt.
create policy "update segments of own track"
  on track_segments for update using (
    exists (select 1 from tracks t where t.id = track_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from tracks t where t.id = track_id and t.user_id = auth.uid())
  );

create policy "delete segments of own track"
  on track_segments for delete using (
    exists (select 1 from tracks t where t.id = track_id and t.user_id = auth.uid())
  );

-- -------------------------------------------------------------------- jingles

create policy "read own and room jingles"
  on jingles for select using (
    owner_id = auth.uid() or (room_id is not null and is_room_member(room_id))
  );

create policy "create own jingles"
  on jingles for insert with check (owner_id = auth.uid());

create policy "update own jingles"
  on jingles for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "delete own jingles"
  on jingles for delete using (owner_id = auth.uid());

-- ------------------------------------------------------------ session_jingles

create policy "members manage session jingles"
  on session_jingles for all
  using (is_room_member(session_room(session_id)))
  with check (is_room_member(session_room(session_id)));

-- ---------------------------------------------------------------------- mixes

create policy "members manage mixes"
  on mixes for all
  using (is_room_member(session_room(session_id)))
  with check (is_room_member(session_room(session_id)));
