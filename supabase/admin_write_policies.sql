-- Basketball Stats: admin-only write policies for the browser app.
-- Run this ONCE in Supabase Dashboard > SQL Editor.
-- This keeps RLS enabled. Only users whose auth.uid() exists in public.admin_users
-- are allowed to write match data. It does not expose or use a service_role key.

begin;

-- Used by RLS policies so the membership check works even when admin_users
-- has its own row-level security enabled.
create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users as au
    where au.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_app_admin() from public, anon;
grant execute on function public.is_app_admin() to authenticated;

-- The app checks the signed-in user's own admin_users row during login.
grant select on table public.admin_users to authenticated;
drop policy if exists "app_admin_read_own_admin_user" on public.admin_users;
create policy "app_admin_read_own_admin_user"
on public.admin_users
for select
to authenticated
using (user_id = (select auth.uid()));

-- These are the tables touched by normal match saving and admin roster editing.
-- SELECT is included because PostgREST upsert needs to see conflict rows.
grant select, insert, update, delete on table
  public.matches,
  public.players,
  public.player_stats,
  public.logs,
  public.lineups
to authenticated;

-- MATCHES
drop policy if exists "app_admin_select_matches" on public.matches;
create policy "app_admin_select_matches" on public.matches
for select to authenticated using ((select public.is_app_admin()));

drop policy if exists "app_admin_insert_matches" on public.matches;
create policy "app_admin_insert_matches" on public.matches
for insert to authenticated with check ((select public.is_app_admin()));

drop policy if exists "app_admin_update_matches" on public.matches;
create policy "app_admin_update_matches" on public.matches
for update to authenticated
using ((select public.is_app_admin()))
with check ((select public.is_app_admin()));

drop policy if exists "app_admin_delete_matches" on public.matches;
create policy "app_admin_delete_matches" on public.matches
for delete to authenticated using ((select public.is_app_admin()));

-- PLAYERS
drop policy if exists "app_admin_select_players" on public.players;
create policy "app_admin_select_players" on public.players
for select to authenticated using ((select public.is_app_admin()));

drop policy if exists "app_admin_insert_players" on public.players;
create policy "app_admin_insert_players" on public.players
for insert to authenticated with check ((select public.is_app_admin()));

drop policy if exists "app_admin_update_players" on public.players;
create policy "app_admin_update_players" on public.players
for update to authenticated
using ((select public.is_app_admin()))
with check ((select public.is_app_admin()));

drop policy if exists "app_admin_delete_players" on public.players;
create policy "app_admin_delete_players" on public.players
for delete to authenticated using ((select public.is_app_admin()));

-- PLAYER STATS
drop policy if exists "app_admin_select_player_stats" on public.player_stats;
create policy "app_admin_select_player_stats" on public.player_stats
for select to authenticated using ((select public.is_app_admin()));

drop policy if exists "app_admin_insert_player_stats" on public.player_stats;
create policy "app_admin_insert_player_stats" on public.player_stats
for insert to authenticated with check ((select public.is_app_admin()));

drop policy if exists "app_admin_update_player_stats" on public.player_stats;
create policy "app_admin_update_player_stats" on public.player_stats
for update to authenticated
using ((select public.is_app_admin()))
with check ((select public.is_app_admin()));

drop policy if exists "app_admin_delete_player_stats" on public.player_stats;
create policy "app_admin_delete_player_stats" on public.player_stats
for delete to authenticated using ((select public.is_app_admin()));

-- TIMELINE LOGS
drop policy if exists "app_admin_select_logs" on public.logs;
create policy "app_admin_select_logs" on public.logs
for select to authenticated using ((select public.is_app_admin()));

drop policy if exists "app_admin_insert_logs" on public.logs;
create policy "app_admin_insert_logs" on public.logs
for insert to authenticated with check ((select public.is_app_admin()));

drop policy if exists "app_admin_update_logs" on public.logs;
create policy "app_admin_update_logs" on public.logs
for update to authenticated
using ((select public.is_app_admin()))
with check ((select public.is_app_admin()));

drop policy if exists "app_admin_delete_logs" on public.logs;
create policy "app_admin_delete_logs" on public.logs
for delete to authenticated using ((select public.is_app_admin()));

-- LINEUPS
drop policy if exists "app_admin_select_lineups" on public.lineups;
create policy "app_admin_select_lineups" on public.lineups
for select to authenticated using ((select public.is_app_admin()));

drop policy if exists "app_admin_insert_lineups" on public.lineups;
create policy "app_admin_insert_lineups" on public.lineups
for insert to authenticated with check ((select public.is_app_admin()));

drop policy if exists "app_admin_update_lineups" on public.lineups;
create policy "app_admin_update_lineups" on public.lineups
for update to authenticated
using ((select public.is_app_admin()))
with check ((select public.is_app_admin()));

drop policy if exists "app_admin_delete_lineups" on public.lineups;
create policy "app_admin_delete_lineups" on public.lineups
for delete to authenticated using ((select public.is_app_admin()));

-- team_members is optional in older deployments. Add its policies only when
-- the table has already been created by the app's separate migration.
do $$
begin
  if to_regclass('public.team_members') is not null then
    execute 'grant select, insert, update, delete on table public.team_members to authenticated';

    execute 'drop policy if exists "app_admin_select_team_members" on public.team_members';
    execute 'create policy "app_admin_select_team_members" on public.team_members for select to authenticated using ((select public.is_app_admin()))';

    execute 'drop policy if exists "app_admin_insert_team_members" on public.team_members';
    execute 'create policy "app_admin_insert_team_members" on public.team_members for insert to authenticated with check ((select public.is_app_admin()))';

    execute 'drop policy if exists "app_admin_update_team_members" on public.team_members';
    execute 'create policy "app_admin_update_team_members" on public.team_members for update to authenticated using ((select public.is_app_admin())) with check ((select public.is_app_admin()))';

    execute 'drop policy if exists "app_admin_delete_team_members" on public.team_members';
    execute 'create policy "app_admin_delete_team_members" on public.team_members for delete to authenticated using ((select public.is_app_admin()))';
  end if;
end
$$;

commit;

-- Quick check after running:
-- select schemaname, tablename, policyname, roles, cmd
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('admin_users','matches','players','player_stats','logs','lineups','team_members')
-- order by tablename, policyname;
