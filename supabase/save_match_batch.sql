-- (선택) 저장 버튼 1회 = DB 트랜잭션 1회 로 만들고 싶을 때 사용합니다.
-- 사용법: Supabase SQL Editor 에서 실행 → index.html 의 LF.USE_RPC 를 true 로 변경.
-- 주의: 아래 컬럼 타입(text/int/timestamptz)은 템플릿입니다. 실제 테이블 타입에 맞게 수정하세요.
-- security invoker 이므로 기존 RLS 정책이 그대로 적용됩니다 (운영진만 쓰기 가능하도록 RLS 확인 필수).

create or replace function public.save_match_batch(
  p_match_id text, p_logs_add jsonb, p_logs_del jsonb, p_stats jsonb,
  p_lineups jsonb, p_quarter int, p_timer int
) returns void
language plpgsql
security invoker
as $$
declare op jsonb;
begin
  -- 1) 로그 추가 (id 기준 upsert → 재시도해도 중복 없음)
  insert into public.logs (id, match_id, quarter, player_id, stat_type, log_time, text, created_at)
  select x.id, x.match_id, x.quarter, x.player_id, x.stat_type, x.log_time, x.text, x.created_at
  from jsonb_to_recordset(coalesce(p_logs_add, '[]'::jsonb)) as x(
    id text, match_id text, quarter int, player_id text, stat_type text, log_time text, text text, created_at timestamptz)
  on conflict (id) do update set quarter = excluded.quarter, player_id = excluded.player_id,
    stat_type = excluded.stat_type, log_time = excluded.log_time, text = excluded.text;

  -- 2) 로그 삭제
  delete from public.logs
  where match_id = p_match_id
    and id in (select jsonb_array_elements_text(coalesce(p_logs_del, '[]'::jsonb)));

  -- 3) 스탯 (절대값 upsert)
  insert into public.player_stats (match_id, player_id, quarter, pt2_made, pt2_miss, pt3_made, pt3_miss,
    ft_made, ft_miss, def_reb, off_reb, ast, stl, blk, to_count, foul)
  select x.match_id, x.player_id, x.quarter, x.pt2_made, x.pt2_miss, x.pt3_made, x.pt3_miss,
    x.ft_made, x.ft_miss, x.def_reb, x.off_reb, x.ast, x.stl, x.blk, x.to_count, x.foul
  from jsonb_to_recordset(coalesce(p_stats, '[]'::jsonb)) as x(
    match_id text, player_id text, quarter int, pt2_made int, pt2_miss int, pt3_made int, pt3_miss int,
    ft_made int, ft_miss int, def_reb int, off_reb int, ast int, stl int, blk int, to_count int, foul int)
  on conflict (match_id, player_id, quarter) do update set
    pt2_made = excluded.pt2_made, pt2_miss = excluded.pt2_miss, pt3_made = excluded.pt3_made, pt3_miss = excluded.pt3_miss,
    ft_made = excluded.ft_made, ft_miss = excluded.ft_miss, def_reb = excluded.def_reb, off_reb = excluded.off_reb,
    ast = excluded.ast, stl = excluded.stl, blk = excluded.blk, to_count = excluded.to_count, foul = excluded.foul;

  -- 4) 라인업 교체 (삭제+삽입이 한 트랜잭션이라 중간 상태가 보이지 않음)
  for op in select * from jsonb_array_elements(coalesce(p_lineups, '[]'::jsonb)) loop
    delete from public.lineups
      where match_id = p_match_id and quarter = (op->>'q')::int and team_type = op->>'team';
    insert into public.lineups (match_id, quarter, team_type, player_id)
      select p_match_id, (op->>'q')::int, op->>'team', jsonb_array_elements_text(op->'ids');
  end loop;

  -- 5) 경기 메타
  update public.matches set quarter = p_quarter, timer_seconds = p_timer where id = p_match_id;
end $$;