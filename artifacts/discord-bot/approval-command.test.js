const test = require('node:test');
const assert = require('node:assert/strict');
const { createApprovalCommand } = require('./approval-command');
const fs = require('node:fs');
const ID = '111111111111111111111111';
const TEAM = '222222222222222222222222';
const EVENT = '333333333333333333333333';
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(part => matches(row, part));
    if (key === '$expr') {
      const expr = value.$regexMatch;
      return expr.regex.test(String(row[expr.input.$toString.slice(1)] || ''));
    }
    if (value instanceof RegExp) return value.test(row[key] || '');
    if (value && typeof value === 'object') {
      if ('$ne' in value) return row[key] !== value.$ne;
      if ('$in' in value) return value.$in.includes(row[key]);
    }
    return String(row[key]) === String(value);
  });
}
function model(rows = []) {
  const query = value => ({
    sort() { if (Array.isArray(value)) value.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)); return this; },
    limit(n) { if (Array.isArray(value)) value = value.slice(0,n); return this; },
    select() { return this; },
    async lean() { return structuredClone(value); },
    then(resolve,reject) { return Promise.resolve(structuredClone(value)).then(resolve,reject); },
  });
  return {
    rows,
    find: filter => query(rows.filter(row => matches(row, filter))),
    findOne: filter => query(rows.find(row => matches(row, filter)) || null),
    findById: id => query(rows.find(row => String(row._id) === String(id)) || null),
    findOneAndUpdate(filter, update, options = {}) {
      let row = rows.find(row => matches(row, filter));
      if (!row && options.upsert) { row = { ...filter, ...update.$setOnInsert }; rows.push(row); }
      if (row) {
        Object.assign(row, update.$set);
        for (const [key, value] of Object.entries(update.$addToSet || {})) row[key] = [...new Set([...(row[key] || []), ...value.$each])];
      }
      return query(row || null);
    },
    async bulkWrite(updates) {
      for (const entry of updates) {
        const row = rows.find(row => matches(row, entry.updateOne.filter));
        if (row) Object.assign(row, entry.updateOne.update.$set);
      }
    },
  };
}
function fixture({ type = 'advent', steps = [] } = {}) {
  const sub = { _id: ID, status:'pending', runId:'run1', day:3, userId:'member', username:'Alice',
    submittedBy:'Alice', submittedById:'member', proofUrl:'https://cdn.example/proof.png', imageUrl:'https://cdn.example/proof.png',
    tileId:'tile1', teamId:TEAM, eventId:EVENT, goalName:'Dragon drop', kind:'goal', challenge:'Boss challenge',
    createdAt:'2026-12-03T12:00:00Z', note:'My screenshot' };
  const deps = {
    BingoSubmission:model(type === 'bingo' ? [sub] : []), BingoTeam:model([{_id:TEAM,name:'Red team'}]),
    BingoTileConfig:model([{tileId:'tile1',steps}]), BingoProgress:model(), BingoCompletion:model(),
    BINGO_TILES:[{id:'tile1',name:'Boss tile'}], OsrsEvent:model([{_id:EVENT,name:'Winter race'}]),
    EventSubmission:model(type === 'event' ? [sub] : []), AdventTest:model([{_id:'test',runId:'run1'}]),
    AdventSubmission:model(type === 'advent' ? [sub] : []),
    isAllowed: interaction => interaction.allowed !== false && interaction.guildId === 'clan',
  };
  const dms = [], approvals = [];
  let time = 1000;
  deps.client = { users:{ fetch:async () => ({send:async payload => dms.push(payload)}) } };
  deps.adventService = {
    freshProof:async () => {},
    approveSubmission:async id => {
      if (sub.status !== 'pending' || deps.AdventTest.rows[0].runId !== sub.runId) throw new Error('Already reviewed or old test');
      approvals.push(['advent',id]); sub.status='approved'; return sub;
    },
  };
  deps.eventService = { approveSubmission:async (id, reviewer) => { approvals.push(['event',id,reviewer]); sub.status='approved'; } };
  const service = createApprovalCommand({...deps,now:()=>time});
  function interaction({ allowed=true, value=`${type}:${ID}`, focus='picture', search='', userId='mod', customId, values=[] } = {}) {
    const replies = [];
    return {
      allowed,guildId:'clan',user:{id:userId,username:'Staff',tag:'Staff#0001'},customId,values,replies,
      options:{getString:name=>name==='picture'?value:null,getFocused:()=>({name:focus,value:search})},
      async respond(payload) { replies.push(payload); },
      async reply(payload) { replies.push(payload); },
      async deferReply(payload) { replies.push(payload); },
      async deferUpdate() {},
      async editReply(payload) { replies.push(payload); },
    };
  }
  async function preview() {
    const i = interaction(); await service.command(i);
    const payload = i.replies.at(-1);
    return {payload,token:payload.components.at(-1).toJSON().components[0].custom_id.split(':')[2]};
  }
  return { service, deps, sub, dms, approvals, interaction, preview, expire:()=>{time += 600001;} };
}
test('moderator-only autocomplete and preview do not leak pictures or change results', async () => {
  const f = fixture();
  const denied = f.interaction({allowed:false});
  await f.service.autocomplete(denied);
  assert.deepEqual(denied.replies,[[]]);
  await f.service.command(denied);
  assert.equal(denied.replies.at(-1).ephemeral,true);
  const {payload} = await f.preview();
  assert.equal(payload.embeds[0].image.url,'https://cdn.example/proof.png');
  assert.match(payload.embeds[0].title,/Advent test.*Day 3.*Alice/);
  assert.equal(f.sub.status,'pending');
});
test('autocomplete searches older pending pictures before applying the Discord choice limit', async () => {
  const f = fixture({type:'bingo'});
  for (let i=0;i<30;i++) f.deps.BingoSubmission.rows.push({...f.sub,_id:String(i).padStart(24,'0'),submittedBy:`New member ${i}`,createdAt:'2026-12-04'});
  const i = f.interaction({search:'Alice'});
  await f.service.autocomplete(i);
  assert.equal(i.replies[0].length,1);
  assert.equal(i.replies[0][0].value,`bingo:${ID}`);
  const byDate = f.interaction({search:'2026-12-03'});
  await f.service.autocomplete(byDate);
  assert.equal(byDate.replies[0].length,1);
  const byId = f.interaction({search:ID.slice(-6)});
  await f.service.autocomplete(byId);
  assert.equal(byId.replies[0].length,1);
});
test('autocomplete includes bingo, current advent and named events, but not old tests', async () => {
  const f = fixture();
  f.deps.BingoSubmission.rows.push({...f.sub});
  f.deps.EventSubmission.rows.push({...f.sub});
  f.deps.AdventSubmission.rows.push({...f.sub,_id:'444444444444444444444444',runId:'oldrun'});
  const all = f.interaction();
  await f.service.autocomplete(all);
  assert.deepEqual(all.replies[0].map(choice=>choice.value.split(':')[0]),['bingo','advent','event']);
  const named = f.interaction({search:'Winter'});
  await f.service.autocomplete(named);
  assert.equal(named.replies[0][0].value,`event:${ID}`);
});
for (const type of ['advent','event','bingo']) test(`${type} approval saves once and repeated confirmation cannot duplicate approval`, async () => {
  const f = fixture({type});
  const {token} = await f.preview();
  const i = f.interaction({customId:`approve:confirm:${token}`});
  await f.service.component(i);
  assert.equal(f.sub.status,'approved');
  assert.match(i.replies.at(-1).content,/^Approved:/);
  await f.service.component(i);
  assert.match(i.replies.at(-1).content,/expired/);
  if (type === 'event') assert.deepEqual(f.approvals,[['event',ID,'Staff#0001']]);
  if (type === 'bingo') assert.equal(f.deps.BingoCompletion.rows.length,1);
});
test('cancel, wrong moderator, expired preview and revoked permission never approve', async () => {
  const f = fixture();
  const {token} = await f.preview();
  for (const options of [{userId:'other'},{allowed:false}]) {
    await f.service.component(f.interaction({...options,customId:`approve:confirm:${token}`}));
    assert.equal(f.sub.status,'pending');
  }
  await f.service.component(f.interaction({customId:`approve:cancel:${token}`}));
  assert.equal(f.sub.status,'pending');
  const second = await f.preview(); f.expire();
  await f.service.component(f.interaction({customId:`approve:confirm:${second.token}`}));
  assert.equal(f.sub.status,'pending');
});
test('stale review and advent reset invalidate an open approval preview', async () => {
  for (const stale of ['review','reset']) {
    const f = fixture(); const {token} = await f.preview();
    if (stale === 'review') f.sub.status='rejected';
    else f.deps.AdventTest.rows[0].runId='newrun';
    const i = f.interaction({customId:`approve:confirm:${token}`});
    await f.service.component(i);
    assert.match(i.replies.at(-1).content,/Could not approve/);
    assert.equal(f.approvals.length,0);
  }
});
test('bingo requires valid assignment and records only selected steps until the entire tile is complete', async () => {
  const f = fixture({type:'bingo',steps:['Claws','Pet']});
  const {token,payload} = await f.preview();
  assert.equal(payload.components.at(-1).toJSON().components[0].disabled,true);
  await f.service.component(f.interaction({customId:`approve:steps:${token}`,values:['0']}));
  await f.service.component(f.interaction({customId:`approve:confirm:${token}`}));
  assert.deepEqual(f.deps.BingoProgress.rows[0].completedSteps,['Claws']);
  assert.equal(f.deps.BingoCompletion.rows.length,0);
  assert.equal(f.sub.status,'approved');
  assert.equal(f.dms.length,1);
  const invalid = fixture({type:'bingo'});
  invalid.sub.teamId='000000000000000000000001';
  const i = invalid.interaction(); await invalid.service.command(i);
  assert.match(i.replies.at(-1).content,/choose its team and tile/);
});
test('malformed selection, missing pictures and changing bingo steps fail explicitly', async () => {
  const f = fixture({type:'bingo',steps:['Claws']});
  const bad = f.interaction({value:'bad'}); await f.service.command(bad);
  assert.match(bad.replies.at(-1).content,/autocomplete/);
  const {token} = await f.preview();
  await f.service.component(f.interaction({customId:`approve:steps:${token}`,values:['0']}));
  f.deps.BingoTileConfig.rows[0].steps=['Different'];
  const i = f.interaction({customId:`approve:confirm:${token}`}); await f.service.component(i);
  assert.match(i.replies.at(-1).content,/settings changed/);
  assert.equal(f.sub.status,'pending');
});
test('bingo marks the tile complete when the selected step completes its existing progress', async () => {
  const f = fixture({type:'bingo',steps:['Claws','Pet']});
  f.deps.BingoProgress.rows.push({tileId:'tile1',teamId:TEAM,completedSteps:['Claws']});
  const {token} = await f.preview();
  await f.service.component(f.interaction({customId:`approve:steps:${token}`,values:['1']}));
  await f.service.component(f.interaction({customId:`approve:confirm:${token}`}));
  assert.deepEqual(f.deps.BingoProgress.rows[0].completedSteps,['Claws','Pet']);
  assert.equal(f.deps.BingoCompletion.rows.length,1);
});
test('two previews for the same picture can only approve it once', async () => {
  const f = fixture();
  const first = await f.preview(), second = await f.preview();
  await Promise.all([first,second].map(({token}) =>
    f.service.component(f.interaction({customId:`approve:confirm:${token}`}))));
  assert.equal(f.approvals.length,1);
  assert.equal(f.dms.length,1);
});
test('approval stays saved if the member has DMs closed', async () => {
  const f = fixture();
  f.deps.client.users.fetch = async () => { throw new Error('DMs disabled'); };
  const {token} = await f.preview();
  const i = f.interaction({customId:`approve:confirm:${token}`});
  await f.service.component(i);
  assert.equal(f.sub.status,'approved');
  assert.match(i.replies.at(-1).content,/^Approved:/);
});
test('shared event approval awards real task points and blocks a second result after the target', async () => {
  const { createEventService } = require('./event-service');
  const submissions = model([{_id:ID,eventId:EVENT,kind:'goal',goalId:'goal1',targetId:'member',
    targetType:'solo',status:'pending',value:1,pointsAwarded:0,submittedById:'member',goalName:'Boss'}]);
  const goal = {_id:'goal1',targetValue:1,points:25};
  const event = {_id:EVENT,goals:[goal],scoringMode:'task-points'};
  event.goals.id = id => event.goals.find(item=>item._id===id);
  const dms = [];
  const service = createEventService({
    client:{users:{fetch:async()=>({send:async message=>dms.push(message)})}},
    OsrsEvent:{findById:async()=>event},EventSubmission:submissions,
  });
  const saved = await service.approveSubmission(ID,'Staff');
  assert.equal(saved.status,'approved');
  assert.equal(saved.reviewedBy,'Staff');
  assert.equal(saved.pointsAwarded,25);
  assert.equal(dms.length,1);
  await assert.rejects(service.approveSubmission(ID,'Other staff'),/already reviewed/);
  const next = '555555555555555555555555';
  submissions.rows.push({...submissions.rows[0],_id:next,status:'pending',pointsAwarded:0});
  await assert.rejects(service.approveSubmission(next,'Staff'),/already reached its target/);
  assert.equal(submissions.rows[1].status,'pending');
});
test('bot registers approve and routes commands, autocomplete and confirmation components', () => {
  const source = fs.readFileSync(`${__dirname}/bot.js`,'utf8');
  assert.match(source,/setName\('approve'\)/);
  assert.match(source,/approvalCommand\.autocomplete\(interaction\)/);
  assert.match(source,/approvalCommand\.command\(interaction\)/);
  assert.match(source,/approvalCommand\.component\(interaction\)/);
  const events = fs.readFileSync(`${__dirname}/event-service.js`,'utf8');
  assert.match(events,/approveSubmission\(submission\._id, 'Dashboard moderator'/);
  assert.match(events,/await refreshAwards\(event\)/);
});
