-- Room creation / joining, and the storage buckets.

-- A code the two of you can read to each other over the phone without
-- ambiguity: no O/0, no I/1/L.
create function new_room_code() returns text
language plpgsql as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  candidate text;
  i int;
begin
  loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from rooms r where r.code = candidate);
  end loop;
  return candidate;
end;
$$;

-- Creates a room and makes the caller its host in one round trip.
create function create_room(room_name text default 'Untitled show')
returns rooms
language plpgsql security definer set search_path = public as $$
declare
  created rooms;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  insert into rooms (code, name, owner_id)
  values (new_room_code(), coalesce(nullif(trim(room_name), ''), 'Untitled show'), auth.uid())
  returning * into created;

  insert into room_members (room_id, user_id, role)
  values (created.id, auth.uid(), 'host');

  return created;
end;
$$;

-- The room code is the capability. Presenting a valid one grants membership,
-- which is how a guest records without ever making an account.
create function join_room(room_code text)
returns rooms
language plpgsql security definer set search_path = public as $$
declare
  found rooms;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  select * into found from rooms r where r.code = upper(trim(room_code));

  if found.id is null then
    raise exception 'no room with that code';
  end if;

  insert into room_members (room_id, user_id, role)
  values (found.id, auth.uid(), 'guest')
  on conflict (room_id, user_id) do nothing;

  return found;
end;
$$;

-- Deletes a take's uploaded audio once you have the files you need, so a
-- 1 GB free tier is not spent after a single episode. Rows cascade; the
-- objects are removed by the client, which has the paths.
create function forget_session_audio(target_session uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_room_member(session_room(target_session)) then
    raise exception 'not a member of this room';
  end if;
  delete from track_segments
    where track_id in (select id from tracks where session_id = target_session);
  delete from mixes where session_id = target_session;
end;
$$;

grant execute on function create_room(text)          to authenticated;
grant execute on function join_room(text)            to authenticated;
grant execute on function forget_session_audio(uuid) to authenticated;

-- ------------------------------------------------------------------- buckets

-- All private. 50 MB is the free-tier ceiling for a single object, which is why
-- stems arrive as segments rather than one file.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('stems',   'stems',   false, 52428800,  array['audio/flac', 'audio/wav', 'application/octet-stream']),
  ('jingles', 'jingles', false, 26214400,  array['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/x-m4a']),
  ('mixes',   'mixes',   false, 52428800,  array['audio/wav', 'audio/mpeg', 'audio/flac', 'audio/ogg'])
on conflict (id) do nothing;

-- Paths:
--   stems/<session_id>/<track_id>/<0000-padded index>.flac
--   jingles/<owner_id>/<jingle_id>.<ext>
--   mixes/<session_id>/<mix_id>.<ext>

create policy "members read stems" on storage.objects for select
  using (
    bucket_id = 'stems'
    and is_room_member(session_room((storage.foldername(name))[1]::uuid))
  );

-- You may only write under a track row that is yours, so neither of you can
-- overwrite the other's recording.
create policy "write own stem segments" on storage.objects for insert
  with check (
    bucket_id = 'stems'
    and exists (
      select 1 from tracks t
      where t.id = (storage.foldername(name))[2]::uuid
        and t.user_id = auth.uid()
    )
  );

create policy "members clear stems" on storage.objects for delete
  using (
    bucket_id = 'stems'
    and is_room_member(session_room((storage.foldername(name))[1]::uuid))
  );

create policy "own jingles" on storage.objects for all
  using (bucket_id = 'jingles' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'jingles' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "members read room jingles" on storage.objects for select
  using (
    bucket_id = 'jingles'
    and exists (
      select 1 from jingles j
      where j.path = storage.objects.name
        and j.room_id is not null
        and is_room_member(j.room_id)
    )
  );

create policy "members manage mixes" on storage.objects for all
  using (
    bucket_id = 'mixes'
    and is_room_member(session_room((storage.foldername(name))[1]::uuid))
  )
  with check (
    bucket_id = 'mixes'
    and is_room_member(session_room((storage.foldername(name))[1]::uuid))
  );
