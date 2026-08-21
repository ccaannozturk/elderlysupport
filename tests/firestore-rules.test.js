const fs = require('fs');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const ADMIN = 'can.ozturk1907@gmail.com';

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-esl-full',
    firestore: { host: '127.0.0.1', port: 8085, rules: fs.readFileSync('current.rules', 'utf8') }
  });
  await env.clearFirestore();
  const { Timestamp } = require('firebase/firestore');

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.collection('fixtures').doc('f_sched').set({ status: 'scheduled' });
    await db.collection('fixtures').doc('f_draft').set({ status: 'draft' });
    await db.collection('roasts').doc('r_pub').set({ status: 'published', roastText: 'x' });
    await db.collection('roasts').doc('r_draft').set({ status: 'draft' });
    await db.collection('config').doc('gemini_meta').set({ last4: '1234' });
    await db.collection('config').doc('gemini').set({ key: 'SECRET' });
    await db.collection('matches_v2').doc('m1').set({ date: new Date(), type: 'Standard', teams: [{}, {}] });
    await db.collection('players_v2').doc('can').set({ displayName: 'Can' });
    await db.collection('locations').doc('l1').set({ name: 'Zuid' });
    await db.collection('awards').doc('2026-7').set({ citation: 'x' });
    await db.collection('matches').doc('legacy').set({ x: 1 });
    await db.collection('players').doc('legacy').set({ x: 1 });
  });

  const anon  = env.unauthenticatedContext().firestore();
  const admin = env.authenticatedContext('a', { email: ADMIN, email_verified: true }).firestore();
  const rando = env.authenticatedContext('b', { email: 'someone@else.com', email_verified: true }).firestore();

  const rows = [];
  const t = async (group, name, p, expect) => {
    let ok; try { await (expect === 'allow' ? assertSucceeds(p) : assertFails(p)); ok = true; } catch { ok = false; }
    rows.push({ group, name, expect, ok });
  };
  const goodMatch = { date: Timestamp.now(), type: 'Standard', teams: [{ a: 1 }, { b: 2 }] };
  const badMatch  = { date: 'not-a-timestamp', type: 'Standard', teams: [{ a: 1 }, { b: 2 }] };

  await t('matches_v2', 'public read',              anon.collection('matches_v2').get(), 'allow');
  await t('matches_v2', 'admin create (valid)',     admin.collection('matches_v2').doc('n1').set(goodMatch), 'allow');
  await t('matches_v2', 'admin create (bad date)',  admin.collection('matches_v2').doc('n2').set(badMatch), 'deny');
  await t('matches_v2', 'admin create (1 team)',    admin.collection('matches_v2').doc('n3').set({ ...goodMatch, teams: [{ a: 1 }] }), 'deny');
  await t('matches_v2', 'admin create (4 teams)',   admin.collection('matches_v2').doc('n4').set({ ...goodMatch, teams: [1,2,3,4].map(i => ({ i })) }), 'deny');
  await t('matches_v2', 'non-admin create',         rando.collection('matches_v2').doc('n5').set(goodMatch), 'deny');
  await t('matches_v2', 'anon create',              anon.collection('matches_v2').doc('n6').set(goodMatch), 'deny');
  await t('matches_v2', 'admin delete',             admin.collection('matches_v2').doc('m1').delete(), 'allow');
  await t('matches_v2', 'non-admin delete',         rando.collection('matches_v2').doc('m1').delete(), 'deny');

  await t('players_v2', 'public read',              anon.collection('players_v2').get(), 'allow');
  await t('players_v2', 'admin write',              admin.collection('players_v2').doc('p2').set({ displayName: 'X' }), 'allow');
  await t('players_v2', 'non-admin write',          rando.collection('players_v2').doc('p3').set({ displayName: 'X' }), 'deny');
  await t('players_v2', 'anon delete',              anon.collection('players_v2').doc('can').delete(), 'deny');

  await t('legacy',     'matches read ok',          anon.collection('matches').get(), 'allow');
  await t('legacy',     'matches write denied even for admin', admin.collection('matches').doc('legacy').set({ x: 2 }), 'deny');
  await t('legacy',     'players write denied even for admin', admin.collection('players').doc('legacy').set({ x: 2 }), 'deny');

  await t('locations',  'public read',              anon.collection('locations').get(), 'allow');
  await t('locations',  'admin write',              admin.collection('locations').doc('l2').set({ name: 'New' }), 'allow');
  await t('locations',  'non-admin write',          rando.collection('locations').doc('l3').set({ name: 'New' }), 'deny');

  await t('awards',     'public read',              anon.collection('awards').doc('2026-7').get(), 'allow');
  await t('awards',     'admin write',              admin.collection('awards').doc('2026-8').set({ citation: 'y' }), 'allow');
  await t('awards',     'non-admin write',          rando.collection('awards').doc('2026-8').set({ citation: 'y' }), 'deny');

  await t('fixtures',   'public where(scheduled)',  anon.collection('fixtures').where('status','==','scheduled').get(), 'allow');
  await t('fixtures',   'public unconstrained',     anon.collection('fixtures').get(), 'deny');
  await t('fixtures',   'public get(draft)',        anon.collection('fixtures').doc('f_draft').get(), 'deny');
  await t('fixtures',   'admin unconstrained',      admin.collection('fixtures').get(), 'allow');
  await t('fixtures',   'non-admin write',          rando.collection('fixtures').doc('f_sched').set({ status: 'scheduled' }), 'deny');

  await t('roasts',     'public where(published)',  anon.collection('roasts').where('status','==','published').get(), 'allow');
  await t('roasts',     'public unconstrained',     anon.collection('roasts').get(), 'deny');
  await t('roasts',     'public get(published)',    anon.collection('roasts').doc('r_pub').get(), 'allow');
  await t('roasts',     'public get(draft)',        anon.collection('roasts').doc('r_draft').get(), 'deny');
  await t('roasts',     'admin unconstrained',      admin.collection('roasts').get(), 'allow');
  await t('roasts',     'ADMIN DELETE (new)',       admin.collection('roasts').doc('r_pub').delete(), 'allow');
  await t('roasts',     'non-admin delete',         rando.collection('roasts').doc('r_draft').delete(), 'deny');
  await t('roasts',     'anon delete',              anon.collection('roasts').doc('r_draft').delete(), 'deny');

  await t('config',     'ADMIN read gemini_meta',   admin.collection('config').doc('gemini_meta').get(), 'allow');
  await t('config',     'public read gemini_meta',  anon.collection('config').doc('gemini_meta').get(), 'deny');
  await t('config',     'admin write gemini_meta',  admin.collection('config').doc('gemini_meta').set({ last4: '9' }), 'deny');
  await t('config',     'API KEY secret from public', anon.collection('config').doc('gemini').get(), 'deny');
  await t('config',     'API KEY secret from admin',  admin.collection('config').doc('gemini').get(), 'deny');
  await t('config',     'admin roast_settings rw',  admin.collection('config').doc('roast_settings').set({ intensity: 3 }), 'allow');
  await t('config',     'public roast_settings',    anon.collection('config').doc('roast_settings').get(), 'deny');

  await t('default',    'unknown collection read',  anon.collection('whatever').get(), 'deny');
  await t('default',    'unknown collection admin write', admin.collection('whatever').doc('x').set({ a: 1 }), 'deny');

  let group = '', fails = 0;
  rows.forEach(r => {
    if (r.group !== group) { group = r.group; console.log(`\n  ${group.toUpperCase()}`); }
    if (!r.ok) fails++;
    console.log(`    [${r.ok ? ' ok ' : 'FAIL'}] ${r.expect.padEnd(5)}  ${r.name}`);
  });
  console.log(`\n  ${rows.length} checks, ${fails} mismatch(es)`);
  await env.cleanup();
  process.exit(fails ? 1 : 0);
})();
