/**
 * stats-core.js — the league's statistical engines, and the ONLY copy of them.
 *
 * WHY THIS FILE EXISTS
 *   These functions used to live in app.js, which meant anything outside the
 *   browser (the public JSON export, any future consumer) had to reimplement
 *   them and would quietly drift out of step with the website. The website is
 *   the source of truth for what a rating means, so the website's code is what
 *   everything else has to run.
 *
 * HOW IT LOADS
 *   Browser: plain <script> before app.js. It attaches everything to window,
 *   so app.js keeps calling the same names it always did. No build step, no
 *   modules, no bundler — same constraints as the rest of the project.
 *   Node:    require('./stats-core.js') for scripts/export-public.js.
 *
 * WHAT BELONGS HERE
 *   Pure computation only. No DOM, no Firestore, no globals beyond the name
 *   resolver injected below. If a function needs document or db, it stays in
 *   app.js.
 *
 * NOTE ON NAME RESOLUTION
 *   These engines label their output with display names. The registry lives in
 *   app.js (it is populated from Firestore), so it is injected here via
 *   setNameResolver(). Node callers pass their own. Default is identity, which
 *   keeps ids readable if nobody sets one.
 */
(function (root) {
  'use strict';

  /* ---------- tunables (shared by the site and every consumer) ---------- */

  const MIN_GAMES_RANKED_ELO   = 5;  // below this, rating is marked provisional (?)
  const MIN_GAMES_PAIR         = 3;  // chemistry, duo, nemesis, rivalry threshold
  const MIN_GAMES_IMPROVED     = 3;  // matches in current period for "most improved"
  const MILESTONE_INTERVAL     = 25; // badges at 25, 50, 75, 100, ... indefinitely
  const MIN_APPEARANCES_PPG    = 10; // Stage A item 13 qualifier for PPG ranking

  const STARTING_ELO           = 1200;
  const K_STANDARD_REG         = 32;
  const K_STANDARD_NEW         = 48; // for player's first 10 matches (< 10)
  const K_TOURN_REG            = 16;
  const K_TOURN_NEW            = 24;

  /* ---------- shared state ---------- */

  // computeEloRatings() rebuilds this as a side effect; app.js reads it directly
  // (latestEloMap.get(id)) in several places, so it is mirrored onto the host
  // global on every rebuild rather than being returned.
  let latestEloMap = new Map();

  /* ---------- name resolution, injected by the host ---------- */

  let resolveName = (idOrName) => idOrName;

  // The canonical registry (playerId -> { id, displayName, aliases, active }).
  // app.js creates this Map once and only ever mutates it, so holding the same
  // reference keeps this module permanently in step — no syncing required.
  let playersRegistry = new Map();

  /** Host supplies how a player id becomes a display name. */
  function setNameResolver(fn) {
    if (typeof fn === 'function') resolveName = fn;
  }

  /** Host supplies the canonical registry Map (by reference, not a copy). */
  function setPlayerRegistry(map) {
    if (map && typeof map.get === 'function') playersRegistry = map;
  }

  // The engines below call getPlayerDisplayName; route it through the resolver.
  function getPlayerDisplayName(idOrName) {
    return resolveName(idOrName);
  }

  /* ---------- engines ---------- */


  function getMatchTime(m) {
      if (!m || !m.date) return 0;
      if (m.date.toMillis && typeof m.date.toMillis === 'function') return m.date.toMillis();
      if (m.date.toDate && typeof m.date.toDate === 'function') return m.date.toDate().getTime();
      if (m.date.__type === 'timestamp') return new Date(m.date.value).getTime();
      return new Date(m.date).getTime();
  }

  function computeExpectedScore(rA, rB) {
      return 1 / (1 + Math.pow(10, (rB - rA) / 400));
  }

  function computeEloRatings(matches) {
      const sorted = [...matches].sort((a, b) => {
          const tA = getMatchTime(a);
          const tB = getMatchTime(b);
          if (tA !== tB) return tA - tB;
          return (a.id || '').localeCompare(b.id || '');
      });

      const ratings = {}; // playerId -> current rating
      const matchCounts = {}; // playerId -> matches count prior to this match
      const ratingHistory = {}; // playerId -> array of { matchId, delta, rating, date }

      const getRating = (id) => ratings[id] !== undefined ? ratings[id] : STARTING_ELO;
      const getCount = (id) => matchCounts[id] || 0;

      for (const m of sorted) {
          if (!m.teams || m.teams.length < 2) continue;

          if (m.type === 'Standard') {
              const tA = m.teams[0];
              const tB = m.teams[1];
              const pA = tA.players || [];
              const pB = tB.players || [];

              const avgA = pA.length ? (pA.reduce((sum, p) => sum + getRating(p), 0) / pA.length) : STARTING_ELO;
              const avgB = pB.length ? (pB.reduce((sum, p) => sum + getRating(p), 0) / pB.length) : STARTING_ELO;

              const expA = computeExpectedScore(avgA, avgB);
              const expB = 1 - expA;

              let actA = 0.5, actB = 0.5;
              const sA = tA.score || 0;
              const sB = tB.score || 0;
              if (sA > sB) { actA = 1; actB = 0; }
              else if (sB > sA) { actA = 0; actB = 1; }

              for (const p of pA) {
                  const k = getCount(p) < 10 ? K_STANDARD_NEW : K_STANDARD_REG;
                  const delta = k * (actA - expA);
                  const newR = getRating(p) + delta;
                  ratings[p] = newR;
                  matchCounts[p] = getCount(p) + 1;
                  if (!ratingHistory[p]) ratingHistory[p] = [];
                  ratingHistory[p].push({ matchId: m.id, delta, rating: newR, date: m.date });
              }

              for (const p of pB) {
                  const k = getCount(p) < 10 ? K_STANDARD_NEW : K_STANDARD_REG;
                  const delta = k * (actB - expB);
                  const newR = getRating(p) + delta;
                  ratings[p] = newR;
                  matchCounts[p] = getCount(p) + 1;
                  if (!ratingHistory[p]) ratingHistory[p] = [];
                  ratingHistory[p].push({ matchId: m.id, delta, rating: newR, date: m.date });
              }
          } else if (m.type === 'Tournament' && m.teams.length >= 3) {
              // 3-team tournament: 1st beats 2nd, 1st beats 3rd, 2nd beats 3rd.
              const r1 = m.teams.find(t => t.rank === 1) || m.teams[0];
              const r2 = m.teams.find(t => t.rank === 2) || m.teams[1];
              const r3 = m.teams.find(t => t.rank === 3) || m.teams[2];

              const p1 = r1.players || [];
              const p2 = r2.players || [];
              const p3 = r3.players || [];

              const avg1 = p1.length ? (p1.reduce((sum, p) => sum + getRating(p), 0) / p1.length) : STARTING_ELO;
              const avg2 = p2.length ? (p2.reduce((sum, p) => sum + getRating(p), 0) / p2.length) : STARTING_ELO;
              const avg3 = p3.length ? (p3.reduce((sum, p) => sum + getRating(p), 0) / p3.length) : STARTING_ELO;

              // 3 pairwise comparisons using pre-tournament team ratings
              const exp1_2 = computeExpectedScore(avg1, avg2);
              const exp2_1 = 1 - exp1_2;

              const exp1_3 = computeExpectedScore(avg1, avg3);
              const exp3_1 = 1 - exp1_3;

              const exp2_3 = computeExpectedScore(avg2, avg3);
              const exp3_2 = 1 - exp2_3;

              for (const p of p1) {
                  const k = getCount(p) < 10 ? K_TOURN_NEW : K_TOURN_REG;
                  const delta = (k * (1 - exp1_2)) + (k * (1 - exp1_3));
                  const newR = getRating(p) + delta;
                  ratings[p] = newR;
                  matchCounts[p] = getCount(p) + 1;
                  if (!ratingHistory[p]) ratingHistory[p] = [];
                  ratingHistory[p].push({ matchId: m.id, delta, rating: newR, date: m.date });
              }

              for (const p of p2) {
                  const k = getCount(p) < 10 ? K_TOURN_NEW : K_TOURN_REG;
                  const delta = (k * (0 - exp2_1)) + (k * (1 - exp2_3));
                  const newR = getRating(p) + delta;
                  ratings[p] = newR;
                  matchCounts[p] = getCount(p) + 1;
                  if (!ratingHistory[p]) ratingHistory[p] = [];
                  ratingHistory[p].push({ matchId: m.id, delta, rating: newR, date: m.date });
              }

              for (const p of p3) {
                  const k = getCount(p) < 10 ? K_TOURN_NEW : K_TOURN_REG;
                  const delta = (k * (0 - exp3_1)) + (k * (0 - exp3_2));
                  const newR = getRating(p) + delta;
                  ratings[p] = newR;
                  matchCounts[p] = getCount(p) + 1;
                  if (!ratingHistory[p]) ratingHistory[p] = [];
                  ratingHistory[p].push({ matchId: m.id, delta, rating: newR, date: m.date });
              }
          }
      }

      const sortedList = Object.keys(ratings).map(id => {
          const matchesCount = matchCounts[id] || 0;
          return {
              id,
              name: getPlayerDisplayName(id),
              rating: Math.round(ratings[id]),
              rawRating: ratings[id],
              matches: matchesCount,
              isProvisional: matchesCount < MIN_GAMES_RANKED_ELO
          };
      }).sort((a, b) => b.rawRating - a.rawRating);

      latestEloMap = new Map();
      sortedList.forEach(item => latestEloMap.set(item.id, item));
      root.latestEloMap = latestEloMap;   // keep the host's global in step

      return { ratings, matchCounts, ratingHistory, sortedList };
  }

  function computePlayerStreaksAndForm(matches, targetIdOrName) {
      const sorted = [...matches].sort((a, b) => {
          const tA = getMatchTime(a);
          const tB = getMatchTime(b);
          if (tA !== tB) return tA - tB;
          return (a.id || '').localeCompare(b.id || '');
      });

      const isMatchPlayer = (p) => {
          if (!p) return false;
          if (p === targetIdOrName) return true;
          if (playersRegistry.has(targetIdOrName)) {
              const reg = playersRegistry.get(targetIdOrName);
              if (p === reg.id || p.toLowerCase() === reg.displayName.toLowerCase()) return true;
              if ((reg.aliases || []).map(a => a.toLowerCase()).includes(p.toLowerCase())) return true;
          }
          return p.toLowerCase() === targetIdOrName.toLowerCase();
      };

      let curW = 0, maxW = 0;
      let curL = 0, maxL = 0;
      let curU = 0, maxU = 0;
      const history = []; // array of { result: 'W'|'D'|'L', pts, date, matchId }

      for (const m of sorted) {
          let participated = false;
          let result = 'L';
          let pts = 0;

          if (m.type === 'Standard') {
              const tA = m.teams[0], tB = m.teams[1];
              const inA = (tA.players || []).some(isMatchPlayer);
              const inB = (tB.players || []).some(isMatchPlayer);
              if (inA || inB) {
                  participated = true;
                  const myS = inA ? tA.score : tB.score;
                  const opS = inA ? tB.score : tA.score;
                  if (myS > opS) { result = 'W'; pts = 3; }
                  else if (myS === opS) { result = 'D'; pts = 1; }
                  else { result = 'L'; pts = 0; }
              }
          } else if (m.type === 'Tournament') {
              const myTeam = (m.teams || []).find(t => (t.players || []).some(isMatchPlayer));
              if (myTeam) {
                  participated = true;
                  pts = myTeam.points !== undefined ? myTeam.points : (myTeam.rank === 1 ? 3 : (myTeam.rank === 2 ? 1 : 0));
                  if (pts >= 3) result = 'W';
                  else if (pts === 1) result = 'D';
                  else result = 'L';
              }
          }

          if (participated) {
              history.push({ result, pts, date: m.date, matchId: m.id });

              // Win streak
              if (result === 'W') { curW++; if (curW > maxW) maxW = curW; }
              else { curW = 0; }

              // Loss streak
              if (result === 'L') { curL++; if (curL > maxL) maxL = curL; }
              else { curL = 0; }

              // Unbeaten streak (W or D)
              if (result === 'W' || result === 'D') { curU++; if (curU > maxU) maxU = curU; }
              else { curU = 0; }
          }
      }

      // Rolling 5-game PPG trajectory
      const rollingPpgHistory = [];
      for (let i = 0; i < history.length; i++) {
          const windowStart = Math.max(0, i - 4);
          const windowSlice = history.slice(windowStart, i + 1);
          const sumPts = windowSlice.reduce((sum, h) => sum + h.pts, 0);
          const ppg = sumPts / windowSlice.length;
          const dObj = history[i].date ? (history[i].date.toDate ? history[i].date.toDate() : new Date(history[i].date)) : null;
          const dateStr = dObj ? `${dObj.getDate()}/${dObj.getMonth() + 1}` : `Match ${i + 1}`;
          rollingPpgHistory.push({ index: i + 1, ppg, dateStr });
      }

      const form5 = history.slice(-5).map(h => h.result); // most recent last

      return {
          curW, maxW,
          curL, maxL,
          curU, maxU,
          form5,
          rollingPpgHistory,
          history
      };
  }

  function computeNemesisAndRivalry(matches, targetIdOrName) {
      const isMatchPlayer = (p) => {
          if (!p) return false;
          if (p === targetIdOrName) return true;
          if (playersRegistry.has(targetIdOrName)) {
              const reg = playersRegistry.get(targetIdOrName);
              if (p === reg.id || p.toLowerCase() === reg.displayName.toLowerCase()) return true;
              if ((reg.aliases || []).map(a => a.toLowerCase()).includes(p.toLowerCase())) return true;
          }
          return p.toLowerCase() === targetIdOrName.toLowerCase();
      };

      const opposed = {}; // otherPlayerId -> { played: 0, won: 0, drawn: 0, lost: 0 }
      const teammates = {}; // otherPlayerId -> { played: 0, won: 0, drawn: 0, lost: 0 }

      for (const m of matches) {
          if (m.type === 'Standard') {
              const tA = m.teams[0], tB = m.teams[1];
              const inA = (tA.players || []).some(isMatchPlayer);
              const inB = (tB.players || []).some(isMatchPlayer);
              if (!inA && !inB) continue;

              const myTeam = inA ? tA : tB;
              const oppTeam = inA ? tB : tA;
              const isWin = myTeam.score > oppTeam.score;
              const isDraw = myTeam.score === oppTeam.score;
              const isLoss = myTeam.score < oppTeam.score;

              // Teammates
              (myTeam.players || []).forEach(p => {
                  if (!isMatchPlayer(p)) {
                      if (!teammates[p]) teammates[p] = { played: 0, won: 0, drawn: 0, lost: 0 };
                      teammates[p].played++;
                      if (isWin) teammates[p].won++;
                      else if (isDraw) teammates[p].drawn++;
                      else teammates[p].lost++;
                  }
              });

              // Opponents
              (oppTeam.players || []).forEach(p => {
                  if (!opposed[p]) opposed[p] = { played: 0, won: 0, drawn: 0, lost: 0 };
                  opposed[p].played++;
                  if (isWin) opposed[p].won++;
                  else if (isDraw) opposed[p].drawn++;
                  else opposed[p].lost++;
              });
          } else if (m.type === 'Tournament') {
              const myTeam = (m.teams || []).find(t => (t.players || []).some(isMatchPlayer));
              if (!myTeam) continue;

              const myRank = myTeam.rank !== undefined ? myTeam.rank : 2;

              // Teammates
              (myTeam.players || []).forEach(p => {
                  if (!isMatchPlayer(p)) {
                      if (!teammates[p]) teammates[p] = { played: 0, won: 0, drawn: 0, lost: 0 };
                      teammates[p].played++;
                      if (myRank === 1) teammates[p].won++;
                      else if (myRank === 2) teammates[p].drawn++;
                      else teammates[p].lost++;
                  }
              });

              // Opponents (two teams in same tournament count as opponents)
              (m.teams || []).forEach(otherTeam => {
                  if (otherTeam === myTeam) return;
                  const oppRank = otherTeam.rank !== undefined ? otherTeam.rank : 2;
                  const isWin = myRank < oppRank;
                  const isDraw = myRank === oppRank;
                  const isLoss = myRank > oppRank;

                  (otherTeam.players || []).forEach(p => {
                      if (!opposed[p]) opposed[p] = { played: 0, won: 0, drawn: 0, lost: 0 };
                      opposed[p].played++;
                      if (isWin) opposed[p].won++;
                      else if (isDraw) opposed[p].drawn++;
                      else opposed[p].lost++;
                  });
              });
          }
      }

      // Nemesis: Opponent lost to most often with played >= MIN_GAMES_PAIR (3)
      let nemesis = null;
      Object.entries(opposed).forEach(([oppId, rec]) => {
          if (rec.played >= MIN_GAMES_PAIR) {
              if (!nemesis || rec.lost > nemesis.lost || (rec.lost === nemesis.lost && rec.played > nemesis.played)) {
                  nemesis = {
                      id: oppId,
                      name: getPlayerDisplayName(oppId),
                      ...rec
                  };
              }
          }
      });

      // Duo splits: For all players, gather together vs opposed records
      const allRivals = new Set([...Object.keys(teammates), ...Object.keys(opposed)]);
      const duoSplits = [];
      allRivals.forEach(id => {
          const t = teammates[id] || { played: 0, won: 0, drawn: 0, lost: 0 };
          const o = opposed[id] || { played: 0, won: 0, drawn: 0, lost: 0 };
          const showTogether = t.played >= MIN_GAMES_PAIR;
          const showOpposed = o.played >= MIN_GAMES_PAIR;

          if (showTogether || showOpposed) {
              duoSplits.push({
                  id,
                  name: getPlayerDisplayName(id),
                  together: showTogether ? { ...t, wr: Math.round((t.won / t.played) * 100) } : null,
                  opposed: showOpposed ? { ...o, wr: Math.round((o.won / o.played) * 100) } : null,
                  totalMeetings: t.played + o.played
              });
          }
      });

      duoSplits.sort((a, b) => b.totalMeetings - a.totalMeetings);

      return { nemesis, duoSplits };
  }

  function computeAttendanceAndMilestones(matches) {
      const sorted = [...matches].sort((a, b) => {
          const tA = getMatchTime(a);
          const tB = getMatchTime(b);
          if (tA !== tB) return tA - tB;
          return (a.id || '').localeCompare(b.id || '');
      });

      const totalGroupMatches = sorted.length;
      const playerDebutIndex = {}; // pId -> earliest match index
      const playerDebutDate = {}; // pId -> debut date string
      const playerTotalPlayed = {}; // pId -> total matches
      const playerConsecutive = {}; // pId -> { cur: 0, max: 0 }

      sorted.forEach((m, matchIdx) => {
          const matchPlayerIds = new Set();
          (m.teams || []).forEach(t => {
              (t.players || []).forEach(p => matchPlayerIds.add(p));
          });

          const allKnownPlayers = new Set([...Object.keys(playerDebutIndex), ...matchPlayerIds]);

          allKnownPlayers.forEach(pId => {
              if (matchPlayerIds.has(pId)) {
                  if (playerDebutIndex[pId] === undefined) {
                      playerDebutIndex[pId] = matchIdx;
                      const dObj = m.date ? (m.date.toDate ? m.date.toDate() : new Date(m.date)) : new Date();
                      playerDebutDate[pId] = `${dObj.getDate()}/${dObj.getMonth() + 1}/${dObj.getFullYear()}`;
                  }
                  playerTotalPlayed[pId] = (playerTotalPlayed[pId] || 0) + 1;

                  if (!playerConsecutive[pId]) playerConsecutive[pId] = { cur: 0, max: 0 };
                  playerConsecutive[pId].cur++;
                  if (playerConsecutive[pId].cur > playerConsecutive[pId].max) {
                      playerConsecutive[pId].max = playerConsecutive[pId].cur;
                  }
              } else {
                  if (playerDebutIndex[pId] !== undefined) {
                      if (!playerConsecutive[pId]) playerConsecutive[pId] = { cur: 0, max: 0 };
                      playerConsecutive[pId].cur = 0;
                  }
              }
          });
      });

      const attendanceStats = {};
      const oneCapWonders = [];
      const milestoneAchievers = [];

      Object.keys(playerDebutIndex).forEach(pId => {
          const played = playerTotalPlayed[pId] || 0;
          const debutIdx = playerDebutIndex[pId];
          const possibleMatches = totalGroupMatches - debutIdx;
          const rate = possibleMatches > 0 ? Math.round((played / possibleMatches) * 100) : 0;
          const maxConsecutive = playerConsecutive[pId] ? playerConsecutive[pId].max : 0;

          // Milestones derived dynamically via MILESTONE_INTERVAL = 25 indefinitely
          const badges = [];
          for (let m = MILESTONE_INTERVAL; m <= played; m += MILESTONE_INTERVAL) {
              badges.push(`${m} Caps`);
          }

          const data = {
              id: pId,
              name: getPlayerDisplayName(pId),
              played,
              debutDate: playerDebutDate[pId] || 'Unknown',
              possibleSinceDebut: possibleMatches,
              attendanceRate: rate,
              attendanceText: `${played} of ${possibleMatches} since debut`,
              maxConsecutive,
              badges
          };

          attendanceStats[pId] = data;

          if (played === 1) oneCapWonders.push(data);
          if (badges.length > 0) milestoneAchievers.push(data);
      });

      milestoneAchievers.sort((a, b) => b.played - a.played);
      const ironMen = Object.values(attendanceStats).sort((a, b) => b.maxConsecutive - a.maxConsecutive).slice(0, 5);

      return {
          attendanceStats,
          oneCapWonders,
          milestoneAchievers,
          ironMen
      };
  }

  function computeOptimalLineupAndCurse(matches, eloMap) {
      // 1. Optimal Lineup: Top 5 players by Elo with >= 5 games (non-provisional)
      const eligibleEloList = Array.from(eloMap.values())
          .filter(p => !p.isProvisional && p.matches >= MIN_GAMES_RANKED_ELO)
          .sort((a, b) => b.rawRating - a.rawRating);

      const optimal5 = eligibleEloList.slice(0, 5);
      const avgElo = optimal5.length ? Math.round(optimal5.reduce((sum, p) => sum + p.rawRating, 0) / optimal5.length) : STARTING_ELO;

      // 2. Curse Stat: Standard matches only, >= 5 standard matches
      const stdMatches = matches.filter(m => m.type === 'Standard');
      let totalGoals = 0;
      let totalTeamAppearances = 0;

      stdMatches.forEach(m => {
          totalGoals += (m.teams[0].score || 0) + (m.teams[1].score || 0);
          totalTeamAppearances += 2;
      });

      const leagueAvgGF = totalTeamAppearances > 0 ? (totalGoals / totalTeamAppearances) : 0;

      const playerStdStats = {}; // pId -> { games: 0, gf: 0, ga: 0 }

      stdMatches.forEach(m => {
          m.teams.forEach(t => {
              const gf = t.score || 0;
              const opp = m.teams.find(other => other !== t);
              const ga = opp ? (opp.score || 0) : 0;

              (t.players || []).forEach(p => {
                  if (!playerStdStats[p]) playerStdStats[p] = { games: 0, gf: 0, ga: 0 };
                  playerStdStats[p].games++;
                  playerStdStats[p].gf += gf;
                  playerStdStats[p].ga += ga;
              });
          });
      });

      const curseList = Object.keys(playerStdStats)
          .filter(pId => playerStdStats[pId].games >= 5)
          .map(pId => {
              const s = playerStdStats[pId];
              const avgGF = s.gf / s.games;
              const deltaGF = avgGF - leagueAvgGF;
              const avgGD = (s.gf - s.ga) / s.games;
              return {
                  id: pId,
                  name: getPlayerDisplayName(pId),
                  games: s.games,
                  avgGF: avgGF.toFixed(2),
                  deltaGF: deltaGF.toFixed(2),
                  avgGD: avgGD.toFixed(2),
                  rawDeltaGF: deltaGF,
                  rawAvgGD: avgGD
              };
          });

      curseList.sort((a, b) => a.rawDeltaGF - b.rawDeltaGF);

      const cursed = curseList.length > 0 ? curseList[0] : null;
      const blessed = curseList.length > 0 ? curseList[curseList.length - 1] : null;
      const topGD = [...curseList].sort((a, b) => b.rawAvgGD - a.rawAvgGD)[0] || null;

      return {
          optimal5,
          avgElo,
          cursed,
          blessed,
          topGD,
          leagueAvgGF: leagueAvgGF.toFixed(2)
      };
  }

  function computeChemistryMatrix(matches) {
      const duos = {};

      matches.forEach(m => {
          if (!m.teams || m.teams.length < 2) return;

          m.teams.forEach(t => {
              let isWin = false;
              let pts = 0;
              if (m.type === 'Standard') {
                  const opp = m.teams.find(other => other !== t);
                  if (t.score > opp.score) { isWin = true; pts = 3; }
                  else if (t.score === opp.score) { pts = 1; }
              } else {
                  pts = t.points !== undefined ? t.points : (t.rank === 1 ? 3 : (t.rank === 2 ? 1 : 0));
                  if (pts >= 3) isWin = true;
              }

              const cleanPlayers = (t.players || []).map(p => ({ id: p, name: getPlayerDisplayName(p) })).sort((a, b) => a.id.localeCompare(b.id));

              // Item 12: the pair detail sheet lists the matches a duo shared, so
              // record a reference per appearance. Aggregates alone can't do it.
              const res = isWin ? 'W' : (pts === 1 ? 'D' : 'L');
              const md = m.date ? (m.date.toDate ? m.date.toDate() : new Date(m.date)) : null;
              const ref = {
                  id: m.id,
                  ms: md && !isNaN(md.getTime()) ? md.getTime() : 0,
                  res,
                  teamName: t.teamName || '',
                  location: m.location || '',
                  type: m.type || 'Standard'
              };

              for (let i = 0; i < cleanPlayers.length; i++) {
                  for (let j = i + 1; j < cleanPlayers.length; j++) {
                      const p1 = cleanPlayers[i];
                      const p2 = cleanPlayers[j];
                      const key = `${p1.id}__${p2.id}`;
                      if (!duos[key]) {
                          duos[key] = {
                              p1: p1.id,
                              p2: p2.id,
                              names: `${p1.name} & ${p2.name}`,
                              played: 0,
                              won: 0,
                              drawn: 0,
                              lost: 0,
                              pts: 0,
                              refs: []
                          };
                      }
                      duos[key].played++;
                      duos[key].pts += pts;
                      if (isWin) duos[key].won++;
                      else if (pts === 1) duos[key].drawn++;
                      else duos[key].lost++;
                      duos[key].refs.push(ref);
                  }
              }
          });
      });

      const duoList = Object.values(duos).map(d => ({
          ...d,
          wr: (d.won / d.played) * 100,
          ppg: d.pts / d.played
      }));

      const qualifyingDuos = duoList.filter(d => d.played >= MIN_GAMES_PAIR);

      const bestDuos = [...qualifyingDuos].sort((a, b) => b.wr - a.wr || b.played - a.played).slice(0, 10);
      const worstDuos = [...qualifyingDuos].sort((a, b) => a.wr - b.wr || b.played - a.played).slice(0, 10);
      const mostPlayedDuos = [...qualifyingDuos].sort((a, b) => b.played - a.played || b.wr - a.wr).slice(0, 10);

      return { bestDuos, worstDuos, mostPlayedDuos, allDuos: duos };
  }

  /* ---------- export ---------- */

  const api = {
    // tunables
    MIN_GAMES_RANKED_ELO, MIN_GAMES_PAIR, MIN_GAMES_IMPROVED,
    MILESTONE_INTERVAL, MIN_APPEARANCES_PPG,
    STARTING_ELO, K_STANDARD_REG, K_STANDARD_NEW, K_TOURN_REG, K_TOURN_NEW,
    // engines
    getMatchTime,
    computeExpectedScore,
    computeEloRatings,
    computePlayerStreaksAndForm,
    computeNemesisAndRivalry,
    computeAttendanceAndMilestones,
    computeOptimalLineupAndCurse,
    computeChemistryMatrix,
    // wiring
    getLatestEloMap: () => latestEloMap,
    setNameResolver,
    setPlayerRegistry
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;           // Node: scripts/export-public.js
  } else {
    Object.keys(api).forEach(k => { root[k] = api[k]; });  // browser: globals for app.js
    root.StatsCore = api;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);

