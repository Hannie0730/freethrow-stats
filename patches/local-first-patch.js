    /* =====================================================================
     * LOCAL-FIRST PATCH  (기록은 브라우저에만 즉시 반영 → [저장] 시 일괄 전송)
     * 같은 <script> 안에서 동일 이름의 함수를 뒤에서 다시 선언하므로 원본 함수를 덮어씁니다.
     * ===================================================================== */
    const LF = {
      KEY: 'bb_draft_v1',
      AUTO_KEY: 'bb_autosave',
      FOUL_LIMIT: 5,
      USE_RPC: false,          // true: save_match_batch.sql 을 DB에 만든 뒤 켜면 한 트랜잭션으로 저장
      draft: {},               // matchId -> { stats, logsAdd, logsDel, lineups, meta }
      undo: [],                // 이번 세션에서 기록한 logId 스택 (되돌리기용)
      saving: false,
      error: null,
      lastSavedAt: null,
      remoteChanged: {},       // matchId -> 다른 기기에서 변경됨
      ignoreUntil: 0,          // 내가 저장한 직후 들어오는 realtime 에코 무시
      loadSeq: 0,
      triedInit: false,
      renderQueued: false,
      persistTimer: null
    };

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /* ---------- draft(미저장 변경분) 관리 ---------- */
    function lfDraft(matchId) {
      if (!LF.draft[matchId]) LF.draft[matchId] = { stats: {}, logsAdd: {}, logsDel: [], lineups: {}, meta: null };
      return LF.draft[matchId];
    }
    function lfCount(matchId) {
      const d = LF.draft[matchId];
      if (!d) return 0;
      return Object.keys(d.logsAdd).length + d.logsDel.length + Object.keys(d.lineups).length + (d.meta ? 1 : 0);
    }
    function lfTotalDirty() { return Object.keys(LF.draft).reduce((n, id) => n + lfCount(id), 0); }
    function lfPersist() {
      clearTimeout(LF.persistTimer);
      LF.persistTimer = setTimeout(() => {
        try {
          Object.keys(LF.draft).forEach(id => { if (!lfCount(id)) delete LF.draft[id]; });
          if (!Object.keys(LF.draft).length) { localStorage.removeItem(LF.KEY); return; }
          // 타이머 값은 draft 와 함께 보관해 새로고침 후에도 복원
          Object.keys(LF.draft).forEach(id => { const m = matches[id]; if (m && LF.draft[id].meta) LF.draft[id].meta.timerSeconds = m.timerSeconds; });
          localStorage.setItem(LF.KEY, JSON.stringify({ v: 1, savedAt: Date.now(), draft: LF.draft }));
        } catch (e) { console.warn('draft 로컬 보관 실패', e); }
      }, 120);
    }
    (function lfRestoreDraft() {
      try {
        const raw = localStorage.getItem(LF.KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.v === 1 && parsed.draft) LF.draft = parsed.draft;
      } catch (_) { LF.draft = {}; }
    })();

    function lfRowToLog(r) {
      return { id: r.id, quarter: r.quarter, playerId: r.player_id, statType: r.stat_type, time: r.log_time, text: r.text, createdAt: r.created_at, _local: true };
    }
    function lfSortLogs(logs) { logs.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)); }

    // 서버에서 받은 데이터 위에 미저장 변경분을 덧씌운다 (realtime 재조회가 와도 기록이 사라지지 않음)
    function lfApplyOverlay(m) {
      const d = LF.draft[m.id];
      if (!d) return;
      Object.values(d.stats).forEach(s => { m.stats[`${s.playerId}_q${s.quarter}`] = { ...STAT_DEFAULTS, ...s.values }; });
      const del = new Set(d.logsDel);
      m.logs = m.logs.filter(l => !del.has(l.id));
      Object.values(d.logsAdd).forEach(r => { if (!m.logs.some(l => l.id === r.id)) m.logs.push(lfRowToLog(r)); });
      lfSortLogs(m.logs);
      Object.entries(d.lineups).forEach(([key, ids]) => {
        const [q, team] = key.split('|');
        if (!m.lineups[q]) m.lineups[q] = { home: [], away: [] };
        m.lineups[q][team === 'HOME' ? 'home' : 'away'] = ids.slice();
      });
      if (d.meta) { m.quarter = d.meta.quarter; m.timerSeconds = d.meta.timerSeconds; }
      m.substitutions = parseSubstitutionsFromLogs(m.logs);
    }

    /* ---------- 서버 조회: 병렬 + 페이지네이션 + 에러 시 기존 데이터 유지 ---------- */
    async function lfFetchAll(table, orders) {
      const out = [], size = 1000;
      for (let from = 0; ; from += size) {
        let q = supabaseClient.from(table).select('*');
        orders.forEach(([col, asc]) => { q = q.order(col, { ascending: asc }); });
        const { data, error } = await q.range(from, from + size - 1);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < size) break;
      }
      return out;
    }

    async function loadFromSupabase() {
      const seq = ++LF.loadSeq;
      try {
        const { data: matchData, error } = await supabaseClient.from('matches').select('*')
          .order('date', { ascending: false }).order('created_at', { ascending: false });
        if (error) throw error;
        if (!matchData || matchData.length === 0) {
          if (LF.triedInit) { lfSetBanner('경기 데이터가 없고 기본 경기 생성도 실패했습니다. 권한(RLS)을 확인하세요.'); return; }
          LF.triedInit = true;
          await initDefaultMatchInSupabase();
          return;
        }
        const [players, stats, logs, lineups] = await Promise.all([
          lfFetchAll('players', [['id', true]]),
          lfFetchAll('player_stats', [['match_id', true], ['player_id', true], ['quarter', true]]),
          lfFetchAll('logs', [['created_at', false], ['id', false]]),
          lfFetchAll('lineups', [['match_id', true], ['quarter', true], ['team_type', true], ['player_id', true]])
        ]);
        if (seq !== LF.loadSeq) return;   // 더 최신 요청이 있으면 이 응답은 버린다 (경합 방지)

        const by = (rows) => rows.reduce((acc, r) => { (acc[r.match_id] ||= []).push(r); return acc; }, {});
        const P = by(players), S = by(stats), L = by(logs), U = by(lineups);
        const prev = matches;
        const next = {};
        for (const m of matchData) {
          const mapP = (type) => (P[m.id] || []).filter(p => p.team_type === type)
            .map(p => ({ id: p.id, number: String(p.number), name: p.name, birth: p.birth_date || '', color: p.team_color || '블랙' }));
          const st = {};
          (S[m.id] || []).forEach(r => {
            st[`${r.player_id}_q${r.quarter}`] = {
              '2PT_MADE': r.pt2_made || 0, '2PT_MISS': r.pt2_miss || 0, '3PT_MADE': r.pt3_made || 0, '3PT_MISS': r.pt3_miss || 0,
              'FT_MADE': r.ft_made || 0, 'FT_MISS': r.ft_miss || 0, 'DEF_REB': r.def_reb || 0, 'OFF_REB': r.off_reb || 0,
              'AST': r.ast || 0, 'STL': r.stl || 0, 'BLK': r.blk || 0, 'TO': r.to_count || 0, 'FOUL': r.foul || 0
            };
          });
          const lg = (L[m.id] || []).map(l => ({ id: l.id, quarter: l.quarter, playerId: l.player_id, statType: l.stat_type, time: l.log_time, text: l.text, createdAt: l.created_at }));
          const lu = { 1: { home: [], away: [] }, 2: { home: [], away: [] }, 3: { home: [], away: [] }, 4: { home: [], away: [] } };
          (U[m.id] || []).forEach(r => {
            if (!lu[r.quarter]) lu[r.quarter] = { home: [], away: [] };
            lu[r.quarter][r.team_type === 'HOME' ? 'home' : 'away'].push(r.player_id);
          });
          const quarterDuration = Math.max(1, Number(m.quarter_duration || Math.round((m.timer_seconds || 600) / 60) || 10));
          const obj = {
            id: m.id, date: m.date, mode: m.mode || '교류전', homeTeam: m.home_team, awayTeam: m.away_team,
            quarter: m.quarter || 1,
            timerSeconds: Math.max(0, Number(m.timer_seconds ?? (quarterDuration * 60))),
            quarterDuration, homePlayers: mapP('HOME'), awayPlayers: mapP('AWAY'),
            lineups: lu, stats: st, logs: lg, substitutions: parseSubstitutionsFromLogs(lg)
          };
          lfApplyOverlay(obj);
          // 타이머가 돌아가는 중이면 로컬 시계를 서버/보관값으로 되돌리지 않는다
          if (m.id === currentMatchId && isTimerRunning && prev[m.id]) { obj.timerSeconds = prev[m.id].timerSeconds; obj.quarter = prev[m.id].quarter; }
          next[m.id] = obj;
        }
        matches = next;

        // 팀원 마스터 명단 (기존 로직 유지)
        const { data: memberData, error: memberError } = await supabaseClient.from('team_members').select('*').order('number', { ascending: true });
        teamMembersTableAvailable = !memberError;
        if (!memberError && Array.isArray(memberData) && memberData.length > 0) {
          teamMembers = memberData.map(p => ({ id: String(p.id), number: String(p.number ?? ''), name: p.name || '', birth: p.birth_date || '', color: p.team_color || '블랙' }));
        } else {
          const fallback = new Map();
          Object.values(matches).forEach(match => [...match.homePlayers, ...match.awayPlayers].forEach(p => {
            if (!String(p.name).includes('(게스트)')) {
              const key = `${p.number}_${p.name}`;
              if (!fallback.has(key)) fallback.set(key, { id: `legacy_${key}`, number: String(p.number), name: p.name, birth: p.birth || '', color: p.color || '블랙' });
            }
          }));
          teamMembers = Array.from(fallback.values());
        }

        if (!currentMatchId || !matches[currentMatchId]) currentMatchId = Object.keys(matches)[0];
        const dateFilter = document.getElementById('matchDateFilter');
        if (dateFilter && matches[currentMatchId]) dateFilter.value = matches[currentMatchId].date || '';
        renderMatchSelectOptions();
        const sel = document.getElementById('matchSelect');
        if (sel && matches[currentMatchId]) sel.value = currentMatchId;
        renderCurrentMatch();
        lfSetBanner(null);
        lfRenderBar();
        if (!document.getElementById('pageStats').classList.contains('hidden')) initStatsPageViewerDates();
      } catch (e) {
        // 조회 실패 시 화면의 기존 데이터를 비우지 않는다 (빈 데이터 위에 +1 해서 덮어쓰는 사고 방지)
        console.error('데이터 조회 실패:', e);
        lfSetBanner('서버에서 데이터를 불러오지 못했습니다. 화면의 기록은 이 기기에 그대로 있습니다. (' + (e.message || e) + ')');
      }
    }

    async function initDefaultMatchInSupabase() {
      const matchId = 'match_' + Date.now();
      const today = new Date().toISOString().split('T')[0];
      const { error } = await supabaseClient.from('matches').insert([{ id: matchId, date: today, mode: '자체전', home_team: 'Black 팀', away_team: 'White 팀', quarter: 1, timer_seconds: 600 }]);
      if (error) { lfSetBanner('기본 경기 생성 실패: ' + error.message); return; }
      const rows = DEFAULT_PLAYERS_HOME.map(p => ({ id: `${matchId}_${p.id}`, match_id: matchId, team_type: 'HOME', number: p.number, name: p.name, birth_date: p.birth }));
      const { error: pe } = await supabaseClient.from('players').insert(rows);
      if (pe) { lfSetBanner('기본 선수 생성 실패: ' + pe.message); return; }
      currentMatchId = matchId;
      await loadFromSupabase();
    }

    /* ---------- realtime: 전체 재조회 대신 디바운스 + 에코 무시 + 충돌 표시 ---------- */
    let lfReloadTimer = null;
    function setupRealtimeSubscription() {
      supabaseClient.channel('public-db-changes')
        .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => {
          if (Date.now() < LF.ignoreUntil) return;
          const mid = (payload.new && (payload.new.match_id || payload.new.id)) || (payload.old && (payload.old.match_id || payload.old.id));
          if (mid && lfCount(mid)) { LF.remoteChanged[mid] = true; lfRenderBar(); }
          clearTimeout(lfReloadTimer);
          lfReloadTimer = setTimeout(() => { if (!LF.saving) loadFromSupabase(); }, 1200);
        }).subscribe();
    }

    /* ---------- 기록 입력: 전부 로컬 (네트워크 0회) ---------- */
    function lfNewId(prefix) { return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

    function lfRecord(playerId, team, statType, customMsg = null) {
      const m = matches[currentMatchId];
      if (!m || !Object.prototype.hasOwnProperty.call(STAT_DB_COLUMNS, statType)) return false;
      const q = Number(m.quarter || 1);
      const qKey = `${playerId}_q${q}`;
      const prev = { ...STAT_DEFAULTS, ...(m.stats[qKey] || {}) };
      const next = { ...prev, [statType]: (Number(prev[statType]) || 0) + 1 };
      m.stats[qKey] = next;

      const p = [...m.homePlayers, ...m.awayPlayers].find(x => x.id === playerId);
      const label = p ? `#${p.number} ${p.name}` : '팀';
      const now = new Date();
      const row = {
        id: lfNewId('log'), match_id: m.id, quarter: q, player_id: playerId, stat_type: statType,
        log_time: now.toTimeString().split(' ')[0], text: customMsg || `${q}Q [${team}] ${label} - ${statType}`,
        created_at: now.toISOString()          // 일괄 저장해도 기록 순서가 유지되도록 발생 시각을 명시
      };
      const d = lfDraft(m.id);
      d.stats[qKey] = { playerId, quarter: q, values: next };
      d.logsAdd[row.id] = row;
      m.logs.unshift(lfRowToLog(row));
      LF.undo.push({ matchId: m.id, logId: row.id });
      if (LF.undo.length > 200) LF.undo.shift();
      if (navigator.vibrate) navigator.vibrate(8);
      lfAfterChange();
      return true;
    }
    async function applyStatAndSave(playerId, team, statType, customMsg = null) { return lfRecord(playerId, team, statType, customMsg); }
    async function applyAwayStat(statType) {
      const m = matches[currentMatchId];
      if (!m || m.mode !== '교류전') return false;
      return lfRecord('AWAY_TEAM', 'AWAY', statType, `${m.quarter}Q [AWAY] ${m.awayTeam} - ${statType}`);
    }
    function handleStatClick(statType) {
      const p = activePlayer;
      if (!p) return;
      closeModal('statModal');
      if (!lfRecord(p.id, p.team, statType)) return;
      if (['2PT_MADE', '3PT_MADE'].includes(statType)) triggerAssistChain(p);
      else if (['2PT_MISS', '3PT_MISS', 'FT_MISS'].includes(statType)) triggerReboundChain(p);
      else if (statType === 'STL') triggerStealTurnoverChain(p);
    }
    function lfQuick(playerId, team, statType) {
      const m = matches[currentMatchId];
      const p = [...m.homePlayers, ...m.awayPlayers].find(x => x.id === playerId);
      if (!p) return;
      activePlayer = { ...p, team };
      handleStatClick(statType);
    }

    // 교체 로그 기준으로 라인업 재구성 (삭제된 교체의 효과까지 되돌림)
    function lfSubsChrono(m, q, team, excludeId) {
      return m.logs.slice().reverse()                      // 오래된 것 → 최신
        .filter(l => l.statType === 'SUB' && Number(l.quarter) === Number(q) && l.id !== excludeId)
        .map(l => { try { const d = JSON.parse(l.text || '{}'); return d.team === team ? { ...d, timeSec: Number(d.timeSec) } : null; } catch (_) { return null; } })
        .filter(s => s && s.outId && s.inId && Number.isFinite(s.timeSec))
        .sort((a, b) => b.timeSec - a.timeSec);            // 남은 시간 큰 순 = 시간순
    }
    function lfRebuildLineupAfterSubDelete(m, log) {
      let sub; try { sub = JSON.parse(log.text || '{}'); } catch (_) { return; }
      const team = sub.team, q = log.quarter;
      if (team !== 'HOME' && team !== 'AWAY') return;
      const side = team === 'HOME' ? 'home' : 'away';
      const lineup = ((m.lineups[q] && m.lineups[q][side]) || []).slice();   // 자리 순서를 유지하며 치환
      const swap = (from, to) => { const i = lineup.indexOf(from); if (i >= 0 && !lineup.includes(to)) lineup[i] = to; };
      const all = lfSubsChrono(m, q, team, null);          // 삭제 대상 포함
      for (const s of all.slice().reverse()) swap(s.inId, s.outId);                      // 쿼터 시작 라인업 복원
      for (const s of lfSubsChrono(m, q, team, log.id)) swap(s.outId, s.inId);           // 남은 교체만 재적용
      if (!m.lineups[q]) m.lineups[q] = { home: [], away: [] };
      m.lineups[q][side] = lineup;
      lfDraft(m.id).lineups[`${q}|${team}`] = lineup.slice();
    }

    function lfDeleteLogLocal(logId) {
      const m = matches[currentMatchId];
      const log = m && m.logs.find(l => l.id === logId);
      if (!log) return false;
      const d = lfDraft(m.id);
      if (log.statType === 'SUB') {
        lfRebuildLineupAfterSubDelete(m, log);
      } else {
        const qKey = `${log.playerId}_q${log.quarter}`;
        const cur = m.stats[qKey];
        if (cur && Number(cur[log.statType]) > 0) {
          const next = { ...STAT_DEFAULTS, ...cur, [log.statType]: Number(cur[log.statType]) - 1 };
          m.stats[qKey] = next;
          d.stats[qKey] = { playerId: log.playerId, quarter: Number(log.quarter), values: next };
        }
      }
      m.logs = m.logs.filter(l => l.id !== logId);
      if (d.logsAdd[logId]) delete d.logsAdd[logId];       // 아직 서버에 없던 기록이면 그냥 취소
      else if (!d.logsDel.includes(logId)) d.logsDel.push(logId);
      m.substitutions = parseSubstitutionsFromLogs(m.logs);
      return true;
    }
    async function deleteLog(logId) {
      if (!confirm('이 기록을 삭제하시겠습니까?')) return;
      if (lfDeleteLogLocal(logId)) lfAfterChange();
    }
    function lfUndo() {
      while (LF.undo.length) {
        const u = LF.undo.pop();
        if (u.matchId !== currentMatchId) continue;
        if (lfDeleteLogLocal(u.logId)) { lfToast('마지막 기록을 되돌렸습니다'); lfAfterChange(); return; }
      }
      lfToast('되돌릴 기록이 없습니다');
    }

    /* ---------- 쿼터 / 타이머 / 교체 / 라인업 (모두 로컬) ---------- */
    async function changeQuarter(delta) {
      const m = matches[currentMatchId];
      if (!m) return;
      stopTimer({ persist: false });
      const prevQ = Number(m.quarter || 1);
      const nextQ = Math.max(1, Math.min(4, prevQ + delta));
      if (nextQ === prevQ) { updateTimerDisplay(); return; }
      m.quarter = nextQ;
      m.timerSeconds = Math.max(1, Number(m.quarterDuration) || 10) * 60;
      const d = lfDraft(m.id);
      d.meta = { quarter: nextQ, timerSeconds: m.timerSeconds };
      // 다음 쿼터 라인업이 비어 있으면 직전 쿼터의 현재 라인업을 이어받는다 (매 쿼터 5명 재선택 방지)
      if (delta > 0) {
        const from = m.lineups[prevQ] || { home: [], away: [] };
        const to = m.lineups[nextQ] || (m.lineups[nextQ] = { home: [], away: [] });
        [['home', 'HOME'], ['away', 'AWAY']].forEach(([side, team]) => {
          if (!to[side].length && from[side].length && !(team === 'AWAY' && m.mode === '교류전')) {
            to[side] = from[side].slice();
            d.lineups[`${nextQ}|${team}`] = from[side].slice();
          }
        });
      }
      renderCurrentMatch();
      lfAfterChange();
    }
    async function persistTimerSeconds(matchId, seconds) {      // 5초마다 서버로 쏘던 동작 제거 → 로컬 보관만
      const m = matches[matchId];
      if (m && LF.draft[matchId] && LF.draft[matchId].meta) { LF.draft[matchId].meta.timerSeconds = m.timerSeconds; lfPersist(); }
    }
    async function resetTimer() {
      stopTimer({ persist: false });
      const m = matches[currentMatchId];
      if (!m) return;
      m.timerSeconds = Math.max(1, Number(m.quarterDuration) || 10) * 60;
      lfDraft(m.id).meta = { quarter: m.quarter, timerSeconds: m.timerSeconds };
      updateTimerDisplay(); lfAfterChange();
    }
    async function editTimerManual() {
      const m = matches[currentMatchId];
      if (!m) return;
      const input = prompt('변경할 남은 시간 (예: 10:00 또는 초 단위 600):', `${Math.floor(m.timerSeconds / 60)}:${String(m.timerSeconds % 60).padStart(2, '0')}`);
      if (input === null) return;
      const v = input.trim();
      let sec;
      if (/^\d{1,3}:\d{1,2}$/.test(v)) { const [a, b] = v.split(':').map(Number); if (b > 59) { alert('초는 0~59'); return; } sec = a * 60 + b; }
      else if (/^\d+$/.test(v)) sec = Number(v);
      else { alert('형식 오류. 예: 10:00 또는 600'); return; }
      if (!Number.isSafeInteger(sec) || sec < 0 || sec > 86400) { alert('0초~24시간 범위로 입력하세요.'); return; }
      stopTimer({ persist: false });
      m.timerSeconds = sec;
      lfDraft(m.id).meta = { quarter: m.quarter, timerSeconds: sec };
      updateTimerDisplay(); lfAfterChange();
    }
    const lfOrigUpdateTimerDisplay = updateTimerDisplay;
    updateTimerDisplay = function () { lfOrigUpdateTimerDisplay(); lfRenderBar(); };

    async function executeSubstitution() {
      const m = matches[currentMatchId];
      if (!m) return;
      const q = Number(m.quarter);
      const team = document.getElementById('subTeamSelect').value;
      const isHome = team === 'HOME';
      const players = isHome ? m.homePlayers : m.awayPlayers;
      const outId = document.getElementById('subOutPlayerSelect').value;
      const inId = document.getElementById('subInPlayerSelect').value;
      const tStr = document.getElementById('subTimeInput').value.trim();
      if (!outId || !inId) { alert('교체 아웃/인 선수를 모두 선택해주세요.'); return; }
      if (outId === inId) { alert('동일한 선수로 교체할 수 없습니다.'); return; }
      if (!players.some(p => p.id === outId) || !players.some(p => p.id === inId)) { alert('선수 선택이 유효하지 않습니다.'); return; }
      const duration = Math.max(1, Number(m.quarterDuration) || 10) * 60;
      let timeSec;
      if (/^\d{1,3}:\d{1,2}$/.test(tStr)) { const [a, b] = tStr.split(':').map(Number); if (b > 59) { alert('초는 0~59'); return; } timeSec = a * 60 + b; }
      else if (/^\d+$/.test(tStr)) timeSec = Number(tStr);
      else { alert('교체 시간 형식이 올바르지 않습니다. 예: 08:32'); return; }
      if (!Number.isInteger(timeSec) || timeSec < 0 || timeSec > duration) { alert('교체 시간이 쿼터 시간 범위를 벗어났습니다.'); return; }
      const side = isHome ? 'home' : 'away';
      if (!m.lineups[q]) m.lineups[q] = { home: [], away: [] };
      const lineup = ((m.lineups[q] && m.lineups[q][side]) || []).slice();
      if (!lineup.includes(outId)) { alert('교체 아웃 선수는 현재 출전 중이어야 합니다.'); return; }
      if (lineup.includes(inId)) { alert('교체 인 선수는 현재 출전 중이 아니어야 합니다.'); return; }
      const updated = lineup.map(id => id === outId ? inId : id);
      const now = new Date();
      const row = { id: lfNewId('log'), match_id: m.id, quarter: q, player_id: inId, stat_type: 'SUB',
        log_time: now.toTimeString().split(' ')[0], text: JSON.stringify({ outId, inId, timeSec, team }), created_at: now.toISOString() };
      const d = lfDraft(m.id);
      d.logsAdd[row.id] = row;
      d.lineups[`${q}|${team}`] = updated;
      m.lineups[q][side] = updated;
      m.logs.unshift(lfRowToLog(row));
      m.substitutions = parseSubstitutionsFromLogs(m.logs);
      LF.undo.push({ matchId: m.id, logId: row.id });
      closeModal('subModal');
      lfAfterChange();
    }

    async function saveLineupSelection() {
      const m = matches[currentMatchId];
      if (!m) return;
      const q = activeLineupModalQuarter;
      const home = Array.from(document.querySelectorAll('input[name="homeLineup"]:checked')).map(c => c.value);
      const away = Array.from(document.querySelectorAll('input[name="awayLineup"]:checked')).map(c => c.value);
      if (home.length > 5 || away.length > 5) { alert('팀별 출전 선수는 최대 5명입니다.'); return; }
      const hasSubs = ((m.substitutions && m.substitutions[q]) || []).length > 0;
      if (hasSubs && !confirm('이 쿼터에는 교체 기록이 있습니다. 라인업을 다시 저장하면 출전시간 계산이 달라질 수 있습니다. 계속할까요?')) return;
      if (!m.lineups[q]) m.lineups[q] = { home: [], away: [] };
      const d = lfDraft(m.id);
      m.lineups[q].home = home; d.lineups[`${q}|HOME`] = home;
      if (m.mode !== '교류전') { m.lineups[q].away = away; d.lineups[`${q}|AWAY`] = away; }
      closeModal('lineupModal');
      renderCurrentMatch(); lfAfterChange();
    }

    async function resetMatchStatsAndScores() {
      const m = matches[currentMatchId];
      if (!m) return;
      if (!confirm(`현재 경기(${m.homeTeam} vs ${m.awayTeam})의 모든 점수·스탯·타임라인을 서버에서도 완전히 초기화합니다.\n(선수 명단은 유지됩니다.)`)) return;
      const id = m.id;
      if (isTimerRunning) stopTimer({ persist: false });
      delete LF.draft[id]; lfPersist(); LF.undo = LF.undo.filter(u => u.matchId !== id);
      LF.ignoreUntil = Date.now() + 2500;
      const res = await Promise.all([
        supabaseClient.from('player_stats').delete().eq('match_id', id),
        supabaseClient.from('logs').delete().eq('match_id', id),
        supabaseClient.from('lineups').delete().eq('match_id', id)
      ]);
      const failed = res.find(r => r.error);
      if (failed) { alert('초기화 일부 실패: ' + failed.error.message); await loadFromSupabase(); return; }
      const { error } = await supabaseClient.from('matches').update({ quarter: 1, timer_seconds: (m.quarterDuration || 10) * 60 }).eq('id', id);
      if (error) alert('쿼터 초기화 저장 실패: ' + error.message);
      await loadFromSupabase();
    }
    async function deleteCurrentMatch() {
      if (Object.keys(matches).length <= 1) { alert('최소 1개의 경기는 유지되어야 합니다.'); return; }
      if (!confirm('현재 경기를 삭제하시겠습니까? (미저장 기록도 함께 삭제됩니다)')) return;
      const id = currentMatchId;
      const { error } = await supabaseClient.from('matches').delete().eq('id', id);
      if (error) { alert('경기 삭제 실패: ' + error.message); return; }
      delete LF.draft[id]; lfPersist();
      currentMatchId = Object.keys(matches).find(k => k !== id);
      await loadFromSupabase();
    }

    /* ---------- [저장]: 변경분을 한 번에 서버로 ---------- */
    function lfCheck(res) { if (res && res.error) throw res.error; return res; }

    async function lfSave({ silent = false } = {}) {
      if (LF.saving) return false;
      const matchId = currentMatchId;
      const m = matches[matchId];
      const d = LF.draft[matchId];
      if (!m) return false;
      if (!d || !lfCount(matchId)) { if (!silent) lfToast('저장할 변경사항이 없습니다'); return true; }
      if (LF.remoteChanged[matchId] && !confirm('저장하지 않은 사이 다른 기기에서 이 경기가 변경됐습니다.\n지금 저장하면 같은 선수·쿼터의 스탯은 이 기기의 값으로 덮어씁니다. 계속할까요?')) return false;

      LF.saving = true; LF.error = null; lfRenderBar();
      const snap = JSON.parse(JSON.stringify(d));
      LF.ignoreUntil = Date.now() + 4000;
      try {
        const logRows = Object.values(snap.logsAdd);
        const statRows = Object.values(snap.stats).map(s => buildStatsDbRow(matchId, s.playerId, s.quarter, s.values));
        const lineupOps = Object.entries(snap.lineups).map(([k, ids]) => { const [q, team] = k.split('|'); return { q: Number(q), team, ids }; });
        const timer = Math.max(0, Math.floor(Number(m.timerSeconds) || 0));

        if (LF.USE_RPC) {
          lfCheck(await supabaseClient.rpc('save_match_batch', {
            p_match_id: matchId, p_logs_add: logRows, p_logs_del: snap.logsDel, p_stats: statRows,
            p_lineups: lineupOps, p_quarter: Number(m.quarter), p_timer: timer
          }));
        } else {
          // 전부 멱등(idempotent) 연산이라 중간에 실패해도 다시 [저장]하면 안전
          if (logRows.length) lfCheck(await supabaseClient.from('logs').upsert(logRows, { onConflict: 'id' }));
          if (snap.logsDel.length) lfCheck(await supabaseClient.from('logs').delete().in('id', snap.logsDel));
          if (statRows.length) lfCheck(await supabaseClient.from('player_stats').upsert(statRows, { onConflict: 'match_id,player_id,quarter' }));
          for (const op of lineupOps) {
            lfCheck(await supabaseClient.from('lineups').delete().eq('match_id', matchId).eq('quarter', op.q).eq('team_type', op.team));
            if (op.ids.length) lfCheck(await supabaseClient.from('lineups').insert(op.ids.map(player_id => ({ match_id: matchId, quarter: op.q, team_type: op.team, player_id }))));
          }
          lfCheck(await supabaseClient.from('matches').update({ quarter: Number(m.quarter), timer_seconds: timer }).eq('id', matchId));
        }

        // 저장 중에 새로 입력된 변경분은 남기고, 보낸 것만 제거
        const cur = LF.draft[matchId];
        if (cur) {
          Object.keys(snap.logsAdd).forEach(id => delete cur.logsAdd[id]);
          cur.logsDel = cur.logsDel.filter(id => !snap.logsDel.includes(id));
          Object.entries(snap.stats).forEach(([k, s]) => { if (cur.stats[k] && JSON.stringify(cur.stats[k].values) === JSON.stringify(s.values)) delete cur.stats[k]; });
          Object.entries(snap.lineups).forEach(([k, ids]) => { if (cur.lineups[k] && JSON.stringify(cur.lineups[k]) === JSON.stringify(ids)) delete cur.lineups[k]; });
          if (cur.meta && snap.meta && cur.meta.quarter === snap.meta.quarter) cur.meta = null;
          if (!lfCount(matchId) && !Object.keys(cur.stats).length) delete LF.draft[matchId];
        }
        m.logs.forEach(l => { delete l._local; });
        delete LF.remoteChanged[matchId];
        LF.lastSavedAt = new Date();
        LF.ignoreUntil = Date.now() + 2500;
        lfPersist();
        if (!silent) lfToast('저장 완료');
        return true;
      } catch (e) {
        console.error('저장 실패:', e);
        LF.error = e.message || String(e);
        lfToast('저장 실패 — 기록은 이 기기에 보관 중입니다. 다시 [저장]을 눌러주세요.', true);
        return false;
      } finally {
        LF.saving = false; lfRenderBar();
      }
    }

    /* ---------- 렌더링 (한 프레임에 한 번만) ---------- */
    function lfAfterChange() {
      lfPersist();
      if (LF.renderQueued) return;
      LF.renderQueued = true;
      requestAnimationFrame(() => {
        LF.renderQueued = false;
        if (!matches[currentMatchId]) return;
        renderPlayerRoster('HOME'); renderAwayPanel(); updateScoresAndBoxScore(); renderTimelineLogs(); lfRenderBar();
      });
    }

    function lfPlayerTotals(m, id) {
      const t = { PTS: 0, REB: 0, AST: 0, FOUL: 0 };
      for (let q = 1; q <= 4; q++) {
        const s = m.stats[`${id}_q${q}`];
        if (!s) continue;
        t.PTS += (s['2PT_MADE'] || 0) * 2 + (s['3PT_MADE'] || 0) * 3 + (s['FT_MADE'] || 0);
        t.REB += (s.DEF_REB || 0) + (s.OFF_REB || 0); t.AST += s.AST || 0; t.FOUL += s.FOUL || 0;
      }
      return t;
    }

    function renderPlayerRoster(team) {
      const m = matches[currentMatchId];
      const isHome = team === 'HOME';
      const container = document.getElementById(isHome ? 'homePlayerList' : 'awayPlayerList');
      if (!container || !m) return;
      const players = isHome ? m.homePlayers : m.awayPlayers;
      const onIds = (m.lineups && m.lineups[m.quarter] && m.lineups[m.quarter][isHome ? 'home' : 'away']) || [];
      const onCourt = players.filter(p => onIds.includes(p.id));
      const bench = players.filter(p => !onIds.includes(p.id));
      const html = [];
      const card = (p, on) => {
        const t = lfPlayerTotals(m, p.id);
        const foulCls = t.FOUL >= LF.FOUL_LIMIT ? 'bg-red-600 text-white' : t.FOUL === LF.FOUL_LIMIT - 1 ? 'bg-amber-400 text-slate-950' : 'bg-slate-700 text-slate-200';
        const quick = on ? `
          <div class="grid grid-cols-4 gap-1.5 mt-2">
            <button onclick="event.stopPropagation();lfQuick('${esc(p.id)}','${team}','2PT_MADE')" class="lf-q bg-emerald-600 text-white">2P ✓</button>
            <button onclick="event.stopPropagation();lfQuick('${esc(p.id)}','${team}','2PT_MISS')" class="lf-q bg-rose-900/70 text-rose-200">2P ✕</button>
            <button onclick="event.stopPropagation();lfQuick('${esc(p.id)}','${team}','3PT_MADE')" class="lf-q bg-emerald-700 text-white">3P ✓</button>
            <button onclick="event.stopPropagation();lfQuick('${esc(p.id)}','${team}','3PT_MISS')" class="lf-q bg-rose-900/70 text-rose-200">3P ✕</button>
          </div>` : '';
        return `<div onclick="openStatModal(lfFind('${esc(p.id)}','${team}'),'${team}')" class="lf-card ${on ? 'lf-on' : 'lf-bench'}">
          <div class="flex items-center gap-3">
            <span class="lf-num">${esc(p.number)}</span>
            <div class="min-w-0 flex-1">
              <div class="font-extrabold text-slate-100 truncate text-base">${esc(p.name)}</div>
              <div class="text-xs text-slate-400 mt-0.5"><b class="text-orange-400 text-sm">${t.PTS}</b>점 · REB ${t.REB} · AST ${t.AST}</div>
            </div>
            <span class="px-2 py-1 rounded-md text-xs font-black ${foulCls}">PF ${t.FOUL}</span>
          </div>${quick}</div>`;
      };
      if (onCourt.length) html.push(`<p class="lf-sec">🟡 코트 (${onCourt.length})</p>`, ...onCourt.map(p => card(p, true)));
      if (!onCourt.length) html.push(`<div class="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2 text-center">출전선수 5명을 먼저 선택하세요 (가운데 '출전선수' 버튼)</div>`);
      if (bench.length) html.push(`<p class="lf-sec">벤치 (${bench.length})</p>`, ...bench.map(p => card(p, false)));
      container.innerHTML = html.join('');
    }
    function lfFind(id, team) {
      const m = matches[currentMatchId];
      return (team === 'HOME' ? m.homePlayers : m.awayPlayers).find(p => p.id === id);
    }

    function renderTimelineLogs() {
      const m = matches[currentMatchId];
      const box = document.getElementById('timelineLog'), cnt = document.getElementById('logCount');
      if (!m || !box || !cnt) return;
      cnt.textContent = `총 ${m.logs.length}개`;
      const name = (id) => { const p = m.homePlayers.find(x => x.id === id) || m.awayPlayers.find(x => x.id === id); return p ? `#${p.number} ${p.name}` : ''; };
      box.innerHTML = m.logs.slice(0, 60).map(l => {
        let txt = l.text;
        if (l.statType === 'SUB') {
          try { const d = JSON.parse(l.text); txt = `${l.quarter}Q [교체] OUT ${name(d.outId)} → IN ${name(d.inId)} (${String(Math.floor(d.timeSec / 60)).padStart(2, '0')}:${String(d.timeSec % 60).padStart(2, '0')})`; } catch (_) {}
        }
        return `<div class="text-[11px] p-1.5 bg-slate-900 border ${l._local ? 'border-amber-500/50' : 'border-slate-700'} rounded-lg flex justify-between items-center text-slate-300">
          <span class="truncate pr-1">${l._local ? '<span class="text-amber-400">●</span> ' : ''}${esc(txt)}</span>
          <button onclick="deleteLog('${esc(l.id)}')" class="text-slate-500 hover:text-rose-400 px-2"><i class="fa-solid fa-xmark"></i></button></div>`;
      }).join('') || '<div class="text-center text-xs text-slate-500 py-3">선수를 터치하여 스탯을 기록해보세요.</div>';
      if (m.logs.length > 60) box.insertAdjacentHTML('beforeend', `<div class="text-center text-[10px] text-slate-500 py-1">최근 60개만 표시 (전체 ${m.logs.length}개)</div>`);
    }

    // 어시스트/리바운드 후보를 코트 위 선수 먼저 보여준다
    function lfOnCourtFirst(m, team, list) {
      const ids = (m.lineups[m.quarter] && m.lineups[m.quarter][team === 'HOME' ? 'home' : 'away']) || [];
      return list.slice().sort((a, b) => (ids.includes(b.id) ? 1 : 0) - (ids.includes(a.id) ? 1 : 0));
    }
    function lfChainBtn(p, cls, tag, onclick, on) {
      return `<button onclick="${onclick}" class="w-full ${cls} p-3 rounded-xl font-bold text-sm text-left border flex items-center justify-between">
        <span>${on ? '🟡 ' : ''}#${esc(p.number)} ${esc(p.name)}</span><span class="text-[10px] px-2 py-0.5 rounded bg-white/10">${tag}</span></button>`;
    }
    function triggerAssistChain(scorer) {
      const m = matches[currentMatchId];
      if (!m || (scorer.team === 'AWAY' && m.mode === '교류전')) return;
      const isHome = scorer.team === 'HOME';
      const q = m.quarter;
      const ids = (m.lineups[q] && m.lineups[q][isHome ? 'home' : 'away']) || [];
      const mates = lfOnCourtFirst(m, scorer.team, (isHome ? m.homePlayers : m.awayPlayers).filter(p => p.id !== scorer.id));
      if (!mates.length) return;
      document.getElementById('assistScorerName').textContent = `#${scorer.number} ${scorer.name}`;
      document.getElementById('assistPlayerOptions').innerHTML = mates.map(p =>
        lfChainBtn(p, 'bg-indigo-900/60 text-indigo-100 border-indigo-500/30', '어시스트',
          `closeModal('assistModal');lfRecord('${esc(p.id)}','${scorer.team}','AST',${esc(JSON.stringify(`${q}Q [${scorer.team}] #${p.number} ${p.name} - 어시스트 (#${scorer.number} ${scorer.name} 득점 연계)`))})`,
          ids.includes(p.id))).join('');
      document.getElementById('assistModal').classList.remove('hidden');
    }
    function triggerReboundChain(shooter) {
      const m = matches[currentMatchId];
      if (!m) return;
      const q = m.quarter, shooterHome = shooter.team === 'HOME';
      const oppType = shooterHome ? 'AWAY' : 'HOME';
      const oppName = shooterHome ? m.awayTeam : m.homeTeam;
      document.getElementById('reboundShooterName').textContent = `#${shooter.number} ${shooter.name}`;
      const msg = (p, kind, t) => esc(JSON.stringify(`${q}Q [${t}] #${p.number} ${p.name} - ${kind} (#${shooter.number} ${shooter.name} 슛 실패 연계)`));
      const own = lfOnCourtFirst(m, shooter.team, shooterHome ? m.homePlayers : m.awayPlayers);
      const ownIds = (m.lineups[q] && m.lineups[q][shooterHome ? 'home' : 'away']) || [];
      let h = `<div class="text-[11px] font-bold text-teal-400 mt-1">⚡ 공격 리바운드 (${esc(shooterHome ? m.homeTeam : m.awayTeam)})</div>`;
      h += own.map(p => lfChainBtn(p, 'bg-teal-950/60 text-teal-100 border-teal-500/30', '공격 REB', `closeModal('reboundChainModal');lfRecord('${esc(p.id)}','${shooter.team}','OFF_REB',${msg(p, '공격 리바운드', shooter.team)})`, ownIds.includes(p.id))).join('');
      h += `<div class="text-[11px] font-bold text-cyan-400 mt-3">🛡️ 수비 리바운드 (${esc(oppName)})</div>`;
      if (m.mode === '교류전' && oppType === 'AWAY') {
        h += `<button onclick="closeModal('reboundChainModal');applyAwayStat('DEF_REB')" class="w-full bg-cyan-950/60 text-cyan-100 p-3 rounded-xl font-bold text-sm text-left border border-cyan-500/30">[상대팀] ${esc(oppName)} 전체</button>`;
      } else {
        const opp = lfOnCourtFirst(m, oppType, shooterHome ? m.awayPlayers : m.homePlayers);
        const oppIds = (m.lineups[q] && m.lineups[q][oppType === 'HOME' ? 'home' : 'away']) || [];
        h += opp.map(p => lfChainBtn(p, 'bg-cyan-950/60 text-cyan-100 border-cyan-500/30', '수비 REB', `closeModal('reboundChainModal');lfRecord('${esc(p.id)}','${oppType}','DEF_REB',${msg(p, '수비 리바운드', oppType)})`, oppIds.includes(p.id))).join('');
      }
      document.getElementById('reboundPlayerOptions').innerHTML = h;
      document.getElementById('reboundChainModal').classList.remove('hidden');
    }
    // 스틸→턴오버 연계: 원본이 applyStatAndSave/applyAwayStat 을 호출하므로 그대로 사용 (이미 로컬 처리됨)

    /* ---------- 하단 상태바 (스코어 · 쿼터/시계 · 되돌리기 · 저장) ---------- */
    function lfToast(msg, isErr = false) {
      let t = document.getElementById('lfToast');
      if (!t) { t = document.createElement('div'); t.id = 'lfToast'; document.body.appendChild(t); }
      t.textContent = msg; t.className = 'lf-toast ' + (isErr ? 'lf-toast-err' : '') + ' show';
      clearTimeout(lfToast._t); lfToast._t = setTimeout(() => t.classList.remove('show'), isErr ? 4500 : 1800);
    }
    function lfSetBanner(msg) {
      let b = document.getElementById('lfBanner');
      if (!msg) { if (b) b.remove(); return; }
      if (!b) { b = document.createElement('div'); b.id = 'lfBanner'; b.className = 'lf-banner'; document.body.prepend(b); }
      b.textContent = msg;
    }
    function lfInitBar() {
      if (document.getElementById('lfBar')) return;
      document.body.style.paddingBottom = '84px';
      const bar = document.createElement('div');
      bar.id = 'lfBar';
      bar.innerHTML = `
        <div class="lf-score"><span id="lfHomeName" class="text-blue-400"></span> <b id="lfHome">0</b> <span class="text-slate-500">:</span> <b id="lfAway">0</b> <span id="lfAwayName" class="text-red-400"></span></div>
        <div class="lf-clock"><span id="lfQ">1Q</span> <span id="lfTime" class="font-mono">10:00</span></div>
        <button onclick="lfUndo()" class="lf-btn bg-slate-700 text-slate-100"><i class="fa-solid fa-rotate-left"></i> 되돌리기</button>
        <label class="lf-auto"><input type="checkbox" id="lfAuto" onchange="lfToggleAuto(this.checked)"> 자동저장 60초</label>
        <div id="lfStatus" class="lf-status"></div>
        <button id="lfSaveBtn" onclick="lfSave()" class="lf-btn lf-save"><i class="fa-solid fa-cloud-arrow-up"></i> 저장</button>`;
      document.body.appendChild(bar);
      const auto = localStorage.getItem(LF.AUTO_KEY) === '1';
      document.getElementById('lfAuto').checked = auto; lfToggleAuto(auto);
    }
    let lfAutoTimer = null;
    function lfToggleAuto(on) {
      try { localStorage.setItem(LF.AUTO_KEY, on ? '1' : '0'); } catch (_) {}
      clearInterval(lfAutoTimer);
      if (on) lfAutoTimer = setInterval(() => {
        const id = currentMatchId;
        if (navigator.onLine && !LF.saving && lfCount(id) && !LF.remoteChanged[id]) lfSave({ silent: true });
      }, 60000);
    }
    function lfRenderBar() {
      lfInitBar();
      const m = matches[currentMatchId];
      if (!m) return;
      const set = (id, v) => { const el = document.getElementById(id); if (el && el.textContent !== String(v)) el.textContent = v; };
      set('lfHomeName', m.homeTeam); set('lfAwayName', m.awayTeam);
      set('lfHome', document.getElementById('homeScoreDisplay')?.textContent || '0');
      set('lfAway', document.getElementById('awayScoreDisplay')?.textContent || '0');
      set('lfQ', (m.quarter || 1) + 'Q');
      set('lfTime', `${String(Math.floor(m.timerSeconds / 60)).padStart(2, '0')}:${String(m.timerSeconds % 60).padStart(2, '0')}`);
      const n = lfCount(currentMatchId), st = document.getElementById('lfStatus'), btn = document.getElementById('lfSaveBtn');
      let cls = 'lf-ok', txt = LF.lastSavedAt ? `✓ 저장됨 ${LF.lastSavedAt.toTimeString().slice(0, 8)}` : '✓ 서버와 동일';
      if (LF.saving) { cls = 'lf-wait'; txt = '저장 중…'; }
      else if (LF.error) { cls = 'lf-err'; txt = '✕ 저장 실패 · 재시도'; }
      else if (!navigator.onLine && n) { cls = 'lf-err'; txt = `오프라인 · 미저장 ${n}건 보관 중`; }
      else if (LF.remoteChanged[currentMatchId] && n) { cls = 'lf-err'; txt = `⚠ 다른 기기 변경 감지 · 미저장 ${n}건`; }
      else if (n) { cls = 'lf-dirty'; txt = `● 미저장 ${n}건`; }
      st.className = 'lf-status ' + cls; st.textContent = txt;
      btn.disabled = LF.saving; btn.classList.toggle('lf-pulse', n > 0 && !LF.saving);
    }

    window.addEventListener('beforeunload', (e) => { if (lfTotalDirty()) { e.preventDefault(); e.returnValue = ''; } });
    window.addEventListener('online', () => { lfRenderBar(); if (localStorage.getItem(LF.AUTO_KEY) === '1' && lfCount(currentMatchId)) lfSave({ silent: true }); });
    window.addEventListener('offline', lfRenderBar);
    document.addEventListener('visibilitychange', () => { if (document.hidden) lfPersist(); });
    window.addEventListener('DOMContentLoaded', () => {
      const css = document.createElement('style');
      css.textContent = `
        .lf-card{border-radius:14px;padding:12px;cursor:pointer;transition:transform .05s;user-select:none;-webkit-user-select:none}
        .lf-card:active{transform:scale(.985)}
        .lf-on{background:rgba(23,37,84,.8);border:2px solid #fbbf24}
        .lf-bench{background:rgba(15,23,42,.8);border:1px solid #334155;opacity:.8;padding:9px 12px}
        .lf-num{width:42px;height:42px;border-radius:10px;background:rgba(37,99,235,.3);color:#93c5fd;font-weight:900;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .lf-bench .lf-num{width:34px;height:34px;font-size:15px}
        .lf-q{min-height:44px;border-radius:10px;font-weight:800;font-size:14px}
        .lf-q:active{filter:brightness(1.3)}
        .lf-sec{font-size:11px;font-weight:800;color:#94a3b8;margin:6px 2px 2px}
        #homePlayerList,#awayPlayerList{max-height:none!important}
        #statModal .grid button{min-height:52px;font-size:16px!important}
        #lfBar{position:fixed;left:0;right:0;bottom:0;z-index:45;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:rgba(15,23,42,.96);backdrop-filter:blur(8px);border-top:1px solid #334155}
        #lfBar .lf-score{font-weight:800;font-size:15px;color:#fff}.lf-score b{font-size:22px;padding:0 4px}
        #lfBar .lf-clock{font-weight:800;color:#fbbf24;font-size:16px}
        #lfBar .lf-auto{font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:4px;margin-left:auto}
        .lf-btn{min-height:44px;padding:0 14px;border-radius:12px;font-weight:800;font-size:14px}
        .lf-save{background:#ea580c;color:#fff}.lf-save:disabled{opacity:.5}
        .lf-pulse{animation:lfp 1.4s infinite}@keyframes lfp{50%{box-shadow:0 0 0 6px rgba(234,88,12,.35)}}
        .lf-status{font-size:12px;font-weight:700;padding:4px 8px;border-radius:8px}
        .lf-ok{color:#34d399}.lf-dirty{color:#fbbf24;background:rgba(251,191,36,.12)}.lf-err{color:#fff;background:#dc2626}.lf-wait{color:#93c5fd}
        .lf-toast{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);background:#0f172a;color:#fff;border:1px solid #475569;padding:8px 14px;border-radius:12px;font-size:13px;font-weight:700;z-index:80;opacity:0;pointer-events:none;transition:opacity .2s}
        .lf-toast.show{opacity:1}.lf-toast-err{background:#7f1d1d;border-color:#ef4444}
        .lf-banner{position:sticky;top:0;z-index:70;background:#b45309;color:#fff;font-size:12px;font-weight:700;text-align:center;padding:6px}
      `;
      document.head.appendChild(css);
      lfInitBar();
      setTimeout(() => { const n = lfTotalDirty(); if (n) lfToast(`이전에 저장하지 못한 기록 ${n}건을 복원했습니다. [저장]을 눌러주세요.`, true); }, 1500);
    });
    /* ===================== /LOCAL-FIRST PATCH ===================== */