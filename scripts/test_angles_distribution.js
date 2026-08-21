const fs = require('fs');

const rawMatches = JSON.parse(fs.readFileSync('data/legacy-export/matches.json', 'utf8'));
const matches = rawMatches.map(m => ({
  id: m.id,
  location: m.data.location,
  colors: m.data.colors,
  type: m.data.type,
  teams: m.data.teams,
  date: m.data.date
}));

const STARTING_ELO = 1200;
const K_STANDARD_REG = 32;
const K_STANDARD_NEW = 48;
const K_TOURN_REG = 16;
const K_TOURN_NEW = 24;
const MIN_GAMES_RANKED_ELO = 5;
const RECAP_SILENCE_THRESHOLD = 65;

function getMatchTime(m) {
  if (!m || !m.date) return 0;
  if (m.date.value) return new Date(m.date.value).getTime();
  if (m.date.toDate) return m.date.toDate().getTime();
  return new Date(m.date).getTime();
}

function getMatchDate(m) {
  if (!m || !m.date) return new Date(0);
  if (m.date.value) return new Date(m.date.value);
  if (m.date.toDate) return m.date.toDate();
  return new Date(m.date);
}

function computeExpectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function computeEloRatings(matchList) {
  const sorted = [...matchList].sort((a, b) => {
    const tA = getMatchTime(a);
    const tB = getMatchTime(b);
    if (tA !== tB) return tA - tB;
    return (a.id || '').localeCompare(b.id || '');
  });

  const ratings = {};
  const matchCounts = {};

  const getRating = (p) => ratings[p] !== undefined ? ratings[p] : STARTING_ELO;
  const getCount = (p) => matchCounts[p] !== undefined ? matchCounts[p] : 0;

  for (const m of sorted) {
    if (!m.teams || m.teams.length < 2) continue;

    if (m.type === 'Standard') {
      const tA = m.teams[0], tB = m.teams[1];
      const pA = tA.players || [], pB = tB.players || [];
      const avgA = pA.length ? (pA.reduce((sum, p) => sum + getRating(p), 0) / pA.length) : STARTING_ELO;
      const avgB = pB.length ? (pB.reduce((sum, p) => sum + getRating(p), 0) / pB.length) : STARTING_ELO;
      const expA = computeExpectedScore(avgA, avgB);
      const expB = 1 - expA;
      let actA = 0.5, actB = 0.5;
      const sA = tA.score || 0, sB = tB.score || 0;
      if (sA > sB) { actA = 1; actB = 0; }
      else if (sB > sA) { actA = 0; actB = 1; }

      for (const p of pA) {
        const k = getCount(p) < 10 ? K_STANDARD_NEW : K_STANDARD_REG;
        ratings[p] = getRating(p) + k * (actA - expA);
        matchCounts[p] = getCount(p) + 1;
      }
      for (const p of pB) {
        const k = getCount(p) < 10 ? K_STANDARD_NEW : K_STANDARD_REG;
        ratings[p] = getRating(p) + k * (actB - expB);
        matchCounts[p] = getCount(p) + 1;
      }
    } else if (m.type === 'Tournament' && m.teams.length >= 3) {
      const r1 = m.teams.find(t => t.rank === 1) || m.teams[0];
      const r2 = m.teams.find(t => t.rank === 2) || m.teams[1];
      const r3 = m.teams.find(t => t.rank === 3) || m.teams[2];

      const p1 = r1.players || [], p2 = r2.players || [], p3 = r3.players || [];
      const avg1 = p1.length ? (p1.reduce((sum, p) => sum + getRating(p), 0) / p1.length) : STARTING_ELO;
      const avg2 = p2.length ? (p2.reduce((sum, p) => sum + getRating(p), 0) / p2.length) : STARTING_ELO;
      const avg3 = p3.length ? (p3.reduce((sum, p) => sum + getRating(p), 0) / p3.length) : STARTING_ELO;

      const pairs = [
        { teamA: p1, teamB: p2, avgA: avg1, avgB: avg2, actA: 1, actB: 0 },
        { teamA: p1, teamB: p3, avgA: avg1, avgB: avg3, actA: 1, actB: 0 },
        { teamA: p2, teamB: p3, avgA: avg2, avgB: avg3, actA: 1, actB: 0 }
      ];

      const deltas = {};
      for (const { teamA, teamB, avgA, avgB, actA, actB } of pairs) {
        const expA = computeExpectedScore(avgA, avgB);
        const expB = 1 - expA;
        for (const p of teamA) {
          const k = getCount(p) < 10 ? K_TOURN_NEW : K_TOURN_REG;
          deltas[p] = (deltas[p] || 0) + k * (actA - expA);
        }
        for (const p of teamB) {
          const k = getCount(p) < 10 ? K_TOURN_NEW : K_TOURN_REG;
          deltas[p] = (deltas[p] || 0) + k * (actB - expB);
        }
      }

      for (const p of [...p1, ...p2, ...p3]) {
        ratings[p] = getRating(p) + (deltas[p] || 0);
        matchCounts[p] = getCount(p) + 1;
      }
    }
  }

  return { ratings, matchCounts };
}

function computeMatchAngles(allMatches, targetMatchId, nameResolver = (id) => id) {
  const sorted = [...allMatches].sort((a, b) => {
    const tA = getMatchTime(a);
    const tB = getMatchTime(b);
    if (tA !== tB) return tA - tB;
    return (a.id || '').localeCompare(b.id || '');
  });

  const targetIndex = sorted.findIndex(m => m.id === targetMatchId);
  if (targetIndex === -1) return { topAngle: null, allAngles: [], silenceReason: "Match not found" };

  const targetMatch = sorted[targetIndex];
  const priorMatches = sorted.slice(0, targetIndex);

  const preEloData = computeEloRatings(priorMatches);
  const getPreElo = (pId) => (preEloData.ratings && preEloData.ratings[pId]) ? preEloData.ratings[pId] : STARTING_ELO;

  const preCaps = {};
  const preStreaks = {};
  const lastPlayedDate = {};
  const venueStats = {};
  const duoRecords = {};
  const h2hHistory = {};

  for (const m of priorMatches) {
    const mDate = getMatchDate(m);
    const mVenue = m.location || '';
    if (!m.teams || m.teams.length < 2) continue;

    if (m.type === 'Standard') {
      const tA = m.teams[0], tB = m.teams[1];
      const pA = tA.players || [], pB = tB.players || [];
      const sA = tA.score || 0, sB = tB.score || 0;
      const resA = sA > sB ? 'W' : (sA === sB ? 'D' : 'L');
      const resB = sB > sA ? 'W' : (sB === sA ? 'D' : 'L');

      [...pA, ...pB].forEach(p => {
        preCaps[p] = (preCaps[p] || 0) + 1;
        lastPlayedDate[p] = mDate;
      });

      pA.forEach(p => {
        if (!venueStats[p]) venueStats[p] = {};
        if (!venueStats[p][mVenue]) venueStats[p][mVenue] = { played: 0, won: 0 };
        venueStats[p][mVenue].played++;
        if (resA === 'W') venueStats[p][mVenue].won++;
      });
      pB.forEach(p => {
        if (!venueStats[p]) venueStats[p] = {};
        if (!venueStats[p][mVenue]) venueStats[p][mVenue] = { played: 0, won: 0 };
        venueStats[p][mVenue].played++;
        if (resB === 'W') venueStats[p][mVenue].won++;
      });

      pA.forEach(p => {
        if (!preStreaks[p]) preStreaks[p] = { w: 0, u: 0 };
        if (resA === 'W') { preStreaks[p].w++; preStreaks[p].u++; }
        else if (resA === 'D') { preStreaks[p].w = 0; preStreaks[p].u++; }
        else { preStreaks[p].w = 0; preStreaks[p].u = 0; }
      });
      pB.forEach(p => {
        if (!preStreaks[p]) preStreaks[p] = { w: 0, u: 0 };
        if (resB === 'W') { preStreaks[p].w++; preStreaks[p].u++; }
        else if (resB === 'D') { preStreaks[p].w = 0; preStreaks[p].u++; }
        else { preStreaks[p].w = 0; preStreaks[p].u = 0; }
      });

      [ { team: pA, res: resA }, { team: pB, res: resB } ].forEach(({ team, res }) => {
        const sortedP = [...team].sort();
        for (let i = 0; i < sortedP.length; i++) {
          for (let j = i + 1; j < sortedP.length; j++) {
            const key = `${sortedP[i]}__${sortedP[j]}`;
            if (!duoRecords[key]) duoRecords[key] = { played: 0, won: 0 };
            duoRecords[key].played++;
            if (res === 'W') duoRecords[key].won++;
          }
        }
      });

      pA.forEach(p1 => {
        pB.forEach(p2 => {
          const key1 = `${p1}__${p2}`;
          const key2 = `${p2}__${p1}`;
          if (!h2hHistory[key1]) h2hHistory[key1] = [];
          if (!h2hHistory[key2]) h2hHistory[key2] = [];
          h2hHistory[key1].push(resA);
          h2hHistory[key2].push(resB);
        });
      });
    } else if (m.type === 'Tournament') {
      const r1 = m.teams.find(t => t.rank === 1) || m.teams[0];
      m.teams.forEach(t => {
        const isWin = (t === r1 || t.rank === 1);
        (t.players || []).forEach(p => {
          preCaps[p] = (preCaps[p] || 0) + 1;
          lastPlayedDate[p] = mDate;
          if (!preStreaks[p]) preStreaks[p] = { w: 0, u: 0 };
          if (isWin) { preStreaks[p].w++; preStreaks[p].u++; }
          else { preStreaks[p].w = 0; preStreaks[p].u = 0; }
        });
      });
    }
  }

  const candidates = [];
  const targetDate = getMatchDate(targetMatch);
  const targetVenue = targetMatch.location || '';
  const isStd = targetMatch.type === 'Standard';

  if (isStd && targetMatch.teams && targetMatch.teams.length >= 2) {
    const tA = targetMatch.teams[0];
    const tB = targetMatch.teams[1];
    const pA = tA.players || [];
    const pB = tB.players || [];
    const sA = tA.score || 0;
    const sB = tB.score || 0;
    const resA = sA > sB ? 'W' : (sA === sB ? 'D' : 'L');
    const resB = sB > sA ? 'W' : (sB === sA ? 'D' : 'L');
    const isDraw = sA === sB;

    const avgEloA = pA.length ? Math.round(pA.reduce((sum, p) => sum + getPreElo(p), 0) / pA.length) : STARTING_ELO;
    const avgEloB = pB.length ? Math.round(pB.reduce((sum, p) => sum + getPreElo(p), 0) / pB.length) : STARTING_ELO;

    // Angle 1: Upset
    if (!isDraw) {
      const winningTeam = resA === 'W' ? tA : tB;
      const losingTeam = resA === 'W' ? tB : tA;
      const winElo = resA === 'W' ? avgEloA : avgEloB;
      const loseElo = resA === 'W' ? avgEloB : avgEloA;
      const eloGap = loseElo - winElo;

      if (eloGap >= 25) {
        const score = Math.min(100, Math.round(45 + eloGap * 0.6));
        candidates.push({
          type: 'upset',
          score,
          winnerTeamName: winningTeam.teamName || 'Underdog',
          loserTeamName: losingTeam.teamName || 'Favorites',
          winnerElo: winElo,
          loserElo: loseElo,
          eloGap,
          winnerScore: winningTeam.score,
          loserScore: losingTeam.score,
          facts: `${winningTeam.teamName || 'Underdog'} (${winElo} Elo) defeated higher-rated ${losingTeam.teamName || 'Opponents'} (${loseElo} Elo, gap: ${eloGap} points)`
        });
      }
    }

    // Angle 2: Blowout (Margin >= 5)
    const margin = Math.abs(sA - sB);
    if (margin >= 5) {
      const winningTeam = sA > sB ? tA : tB;
      const losingTeam = sA > sB ? tB : tA;
      const score = Math.min(95, 45 + (margin - 4) * 15);
      candidates.push({
        type: 'blowout',
        score,
        winnerTeamName: winningTeam.teamName || 'Winners',
        loserTeamName: losingTeam.teamName || 'Losers',
        winnerScore: winningTeam.score,
        loserScore: losingTeam.score,
        margin,
        facts: `${winningTeam.teamName || 'Winners'} won by a commanding ${margin}-goal margin (${winningTeam.score}-${losingTeam.score})`
      });
    }

    // Angle 3: High Scoring (Combined Goals >= 12)
    const totalGoals = sA + sB;
    if (totalGoals >= 12) {
      const score = Math.min(95, 50 + (totalGoals - 11) * 12);
      candidates.push({
        type: 'high_scoring',
        score,
        totalGoals,
        teamAName: tA.teamName || 'Team A',
        teamBName: tB.teamName || 'Team B',
        scoreA: sA,
        scoreB: sB,
        facts: `High-scoring encounter featuring ${totalGoals} combined goals (${tA.teamName || 'Team A'} ${sA}-${sB} ${tB.teamName || 'Team B'})`
      });
    }

    // Angle 4: Streaks Broken & Extended
    [ { team: pA, res: resA, oppTeam: pB }, { team: pB, res: resB, oppTeam: pA } ].forEach(({ team, res }) => {
      team.forEach(p => {
        const prior = preStreaks[p] || { w: 0, u: 0 };
        const pName = nameResolver(p);

        if (res !== 'W' && prior.w >= 3) {
          const score = Math.min(100, 45 + prior.w * 12);
          candidates.push({
            type: 'streak_broken',
            score,
            playerName: pName,
            playerId: p,
            streakLength: prior.w,
            streakType: 'winning run',
            facts: `${pName}'s ${prior.w}-game winning streak ended with this result`
          });
        } else if (res === 'L' && prior.u >= 4) {
          const score = Math.min(100, 45 + prior.u * 10);
          candidates.push({
            type: 'streak_broken',
            score,
            playerName: pName,
            playerId: p,
            streakLength: prior.u,
            streakType: 'unbeaten run',
            facts: `${pName}'s ${prior.u}-game unbeaten streak was snapped`
          });
        }

        if (res === 'W' && (prior.w + 1) >= 4) {
          const newLen = prior.w + 1;
          const score = Math.min(95, 40 + newLen * 10);
          candidates.push({
            type: 'streak_extended',
            score,
            playerName: pName,
            playerId: p,
            streakLength: newLen,
            streakType: 'consecutive wins',
            facts: `${pName} won their ${newLen}th consecutive match`
          });
        }
      });
    });

    // Angle 5: Milestones Hit
    [...pA, ...pB].forEach(p => {
      const priorC = preCaps[p] || 0;
      const currentC = priorC + 1;
      const pName = nameResolver(p);
      const won = (pA.includes(p) && resA === 'W') || (pB.includes(p) && resB === 'W');

      if (currentC % 25 === 0) {
        const baseScore = currentC === 100 ? 95 : (currentC === 50 ? 85 : 75);
        const score = won ? baseScore + 5 : baseScore;
        candidates.push({
          type: 'milestone_hit',
          score,
          playerName: pName,
          playerId: p,
          caps: currentC,
          won,
          facts: `${pName} reached ${currentC} career caps (${won ? 'celebrated with a win' : 'marked in this match'})`
        });
      }
    });

    // Angle 6: Nemesis Broken
    [ { team: pA, oppTeam: pB, res: resA }, { team: pB, oppTeam: pA, res: resB } ].forEach(({ team, oppTeam, res }) => {
      if (res === 'W') {
        team.forEach(p1 => {
          oppTeam.forEach(p2 => {
            const h2h = h2hHistory[`${p1}__${p2}`] || [];
            let trailingLosses = 0;
            for (let i = h2h.length - 1; i >= 0; i--) {
              if (h2h[i] === 'L') trailingLosses++;
              else break;
            }
            if (trailingLosses >= 3) {
              const score = Math.min(95, 50 + trailingLosses * 12);
              candidates.push({
                type: 'nemesis_broken',
                score,
                winnerName: nameResolver(p1),
                loserName: nameResolver(p2),
                priorLosses: trailingLosses,
                facts: `${nameResolver(p1)} earned their first victory over ${nameResolver(p2)} after ${trailingLosses} straight losses against them`
              });
            }
          });
        });
      }
    });

    // Angle 7: Notable Duo
    [ { team: pA, res: resA }, { team: pB, res: resB } ].forEach(({ team, res }) => {
      const sortedP = [...team].sort();
      for (let i = 0; i < sortedP.length; i++) {
        for (let j = i + 1; j < sortedP.length; j++) {
          const key = `${sortedP[i]}__${sortedP[j]}`;
          const prior = duoRecords[key] || { played: 0, won: 0 };
          const newPlayed = prior.played + 1;
          const newWon = prior.won + (res === 'W' ? 1 : 0);

          if (newPlayed >= 4) {
            const winRate = Math.round((newWon / newPlayed) * 100);
            if (winRate >= 80 && res === 'W') {
              const score = Math.min(90, 45 + newPlayed * 7);
              candidates.push({
                type: 'duo_notable',
                score,
                player1Name: nameResolver(sortedP[i]),
                player2Name: nameResolver(sortedP[j]),
                played: newPlayed,
                won: newWon,
                winRatePct: winRate,
                status: 'dominant partners',
                facts: `${nameResolver(sortedP[i])} and ${nameResolver(sortedP[j])} have now won ${newWon} of their ${newPlayed} matches as teammates (${winRate}%)`
              });
            }
          }
        }
      }
    });

    // Angle 8: Return after Long Absence
    [...pA, ...pB].forEach(p => {
      const caps = preCaps[p] || 0;
      const lastDate = lastPlayedDate[p];
      if (caps >= 5 && lastDate && targetDate) {
        const diffMs = targetDate.getTime() - lastDate.getTime();
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays >= 60) {
          const months = Math.round(diffDays / 30);
          const score = Math.min(90, 40 + Math.round(diffDays / 20) * 6);
          candidates.push({
            type: 'return',
            score,
            playerName: nameResolver(p),
            daysAbsent: diffDays,
            monthsAbsent: months,
            facts: `${nameResolver(p)} returned to the league after ${diffDays} days (${months} months) since their last match`
          });
        }
      }
    });

    // Angle 9: First Time Teammates (Both >= 10 caps, 0 prior games together)
    [ { team: pA }, { team: pB } ].forEach(({ team }) => {
      const sortedP = [...team].sort();
      for (let i = 0; i < sortedP.length; i++) {
        for (let j = i + 1; j < sortedP.length; j++) {
          const p1 = sortedP[i], p2 = sortedP[j];
          const c1 = preCaps[p1] || 0, c2 = preCaps[p2] || 0;
          const key = `${p1}__${p2}`;
          const prior = duoRecords[key] || { played: 0, won: 0 };
          if (c1 >= 10 && c2 >= 10 && prior.played === 0) {
            const score = Math.min(85, 45 + Math.min(c1, c2) * 1.5);
            candidates.push({
              type: 'first_together',
              score: Math.round(score),
              player1Name: nameResolver(p1),
              player2Name: nameResolver(p2),
              p1Caps: c1 + 1,
              p2Caps: c2 + 1,
              facts: `Veterans ${nameResolver(p1)} (${c1 + 1} caps) and ${nameResolver(p2)} (${c2 + 1} caps) shared a team for the first time in league history`
            });
          }
        }
      }
    });

    // Angle 10: Venue Mastery
    [ { team: pA, res: resA }, { team: pB, res: resB } ].forEach(({ team, res }) => {
      if (res === 'W' && targetVenue) {
        team.forEach(p => {
          const vData = (venueStats[p] && venueStats[p][targetVenue]) ? venueStats[p][targetVenue] : { played: 0, won: 0 };
          const newPlayed = vData.played + 1;
          const newWon = vData.won + 1;
          if (newPlayed >= 4) {
            const rate = Math.round((newWon / newPlayed) * 100);
            if (rate >= 80) {
              const score = Math.min(85, 40 + newWon * 8);
              candidates.push({
                type: 'venue',
                score,
                playerName: nameResolver(p),
                venueName: targetVenue,
                venueWins: newWon,
                venuePlayed: newPlayed,
                venueWinRatePct: rate,
                facts: `${nameResolver(p)} has won ${newWon} of ${newPlayed} games at ${targetVenue} (${rate}% win rate)`
              });
            }
          }
        });
      }
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const topAngle = candidates.length > 0 ? candidates[0] : null;
  const isSilent = !topAngle || topAngle.score < RECAP_SILENCE_THRESHOLD;

  return {
    matchId: targetMatchId,
    date: targetDate,
    topAngle: isSilent ? null : topAngle,
    highestScore: topAngle ? topAngle.score : 0,
    isSilent,
    allCandidates: candidates
  };
}

// Run test over all 65 matches
console.log('Testing angle selection across all 65 matches:\n');

const angleCounts = {};
let silentCount = 0;
let activeCount = 0;

matches.forEach((m, idx) => {
  const res = computeMatchAngles(matches, m.id);
  if (res.isSilent) {
    silentCount++;
    angleCounts['(silent / no recap)'] = (angleCounts['(silent / no recap)'] || 0) + 1;
  } else {
    activeCount++;
    const aType = res.topAngle.type;
    angleCounts[aType] = (angleCounts[aType] || 0) + 1;
  }
});

console.log('Total matches:', matches.length);
console.log(`Active recaps: ${activeCount} (${Math.round((activeCount / matches.length) * 100)}%)`);
console.log(`Silent matches (recap: null): ${silentCount} (${Math.round((silentCount / matches.length) * 100)}%)`);
console.log('\nAngle Distribution:');
console.table(angleCounts);
