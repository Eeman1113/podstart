-- Hardening pass, following Supabase's database linter.
--
-- The two policy helpers and the new-user trigger were reachable as REST
-- endpoints simply by living in `public`, which is the schema PostgREST
-- exposes. session_room() in particular would confirm the existence of any
-- take and hand its room id to an anonymous caller.
--
-- Moving them into a schema PostgREST does not expose removes the endpoint
-- while leaving them usable inside policies: a policy stores the function by
-- OID, so it follows the function across the move.
--
-- create_room, join_room and forget_session_audio stay in `public` on purpose.
-- They ARE the API, and each checks auth.uid() before doing anything.

create schema if not exists private;
grant usage on schema private to authenticated;

alter function public.is_room_member(uuid) set schema private;
alter function public.session_room(uuid)   set schema private;

-- Policy expressions run with the privileges of the querying role, so
-- authenticated must keep EXECUTE or every policy using these fails.
revoke all on function private.is_room_member(uuid) from anon, public;
revoke all on function private.session_room(uuid)   from anon, public;
grant execute on function private.is_room_member(uuid) to authenticated;
grant execute on function private.session_room(uuid)   to authenticated;

-- A trigger function's EXECUTE privilege is checked when the trigger is
-- created, not when it fires, so revoking this breaks nothing.
revoke all on function public.handle_new_user() from anon, authenticated, public;
