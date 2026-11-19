// Isolated browser regression test. Uses fixtures only; never connects to
// production, Discord, MongoDB, or the real dashboard authentication service.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { SlashCommandBuilder } = require('../artifacts/discord-bot/node_modules/discord.js');
const { buildCommandCatalog } = require('../artifacts/discord-bot/command-catalog');
const { DEFAULT_CHALLENGES, TEST_CHANNEL_ID, defaultAnnouncement } = require('../artifacts/discord-bot/advent-domain');
const { createCanvas } = require('../artifacts/discord-bot/node_modules/@napi-rs/canvas');
const { normalizeCalendarImage } = require('../artifacts/discord-bot/advent-images');
const { randomFillSync } = require('node:crypto');

async function main() {
  const botSource = fs.readFileSync(path.resolve('artifacts/discord-bot/bot.js'), 'utf8');
  const commandDefinitions = vm.runInNewContext(botSource.slice(botSource.indexOf('function addRecipientOptions('),
    botSource.indexOf('async function registerSlashCommands(')) + '\nSLASH_COMMANDS;', { SlashCommandBuilder });
  let failCommands = false;
  const fixture = {
    config: { year: 2026, challenges: [...DEFAULT_CHALLENGES], dayDurationSeconds: 60, channelId: TEST_CHANNEL_ID, calendarImages: [],
      announcementTemplate: defaultAnnouncement(1), announcementClosingMessage: defaultAnnouncement(26) },
    channels: [
      { id:TEST_CHANNEL_ID, name:'advent-test', type:0 },
      { id:'1572351838823653398', name:'events', type:0 },
    ],
    run: { id: 'browser-fixture', state: 'idle', day: 0, opened: 0, dayEndsAt: null },
    submissions: [{
      _id: '000000000000000000000001', day: 1, userId: 'member-1', username: 'Test member', challenge: DEFAULT_CHALLENGES[0],
      status: 'pending', note: 'Test screenshot', proofUrl: '', createdAt: '2026-12-01T12:00:00Z',
    }],
    announcements: [],
  };
  const requests = [];
  let failImageDay = null;
  const uploadedImages = new Map();
  const server = http.createServer(async (req, res) => {
    if (req.url === '/dashboard') {
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(path.resolve('artifacts/discord-bot/dashboard.html')));
      return;
    }
    if (req.url === '/api/commands') {
      res.writeHead(failCommands ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(failCommands ? { error:'Command list temporarily unavailable' } : buildCommandCatalog(commandDefinitions)));
      return;
    }
    const parts = [];
    for await (const part of req) parts.push(part);
    const raw = Buffer.concat(parts);
    const imageRequest = /^\/api\/advent\/test\/images\/\d+$/.test(req.url);
    const body = parts.length && !imageRequest ? JSON.parse(raw) : {};
    requests.push({ method: req.method, url: req.url, body });
    if (imageRequest) {
      const day = Number(req.url.split('/').at(-1));
      if (req.method === 'POST' && day === failImageDay) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Temporary image storage failure' }));
        return;
      }
      fixture.config.calendarImages = fixture.config.calendarImages.filter(image => image.day !== day);
      if (req.method === 'POST') {
        const asset = await normalizeCalendarImage(raw);
        assert.equal(req.headers['content-type'], asset.contentType);
        uploadedImages.set(day, raw);
        fixture.config.calendarImages.push({ day, size: raw.length, contentType:asset.contentType, updatedAt: new Date().toISOString() });
      }
    } else if (req.method === 'PATCH' && req.url === '/api/advent/test/messages/daily') {
      fixture.config.announcementTemplate = body.text;
    } else if (req.method === 'PATCH' && req.url === '/api/advent/test/messages/closing') {
      fixture.config.announcementClosingMessage = body.text;
    } else if (req.method === 'PATCH' && req.url.includes('/challenges/')) {
      fixture.config.challenges[Number(req.url.split('/').at(-1)) - 1] = body.text;
    } else if (req.method === 'PATCH') {
      Object.assign(fixture.config, body);
    } else if (req.url.endsWith('/actions')) {
      if (body.action === 'start') fixture.run = { ...fixture.run, state: 'running', day: 1, opened: 1 };
      if (body.action === 'advance') fixture.run = { ...fixture.run, state: 'running', day: 2, opened: 2 };
      if (body.action === 'reset') {
        fixture.run = { ...fixture.run, state: 'idle', day: 0, opened: 0 };
        fixture.submissions = [];
      }
    } else if (req.url.endsWith('/review')) {
      fixture.submissions[0].status = body.status;
      fixture.submissions[0].reviewNote = body.note;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(fixture));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advent-browser-'));
  const browser = spawn('chromium', [
    '--headless', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${userDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Chromium did not start')), 20000);
      browser.stderr.on('data', chunk => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      browser.once('error', reject);
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const pending = new Map();
    const errors = [];
    let seq = 0;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id);
        clearTimeout(timer);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cmd = (method, params) => send(method, params, sessionId);
    const evaluate = async expression => {
      const result = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await cmd('Page.enable');
    await cmd('Runtime.enable');
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await cmd('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/dashboard` });
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`document.readyState === 'complete' && typeof loadAdvent === 'function'`)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    // Simulate staff state only inside this fixture browser. Production auth
    // remains untouched, and the fixture server exposes no external interface.
    await evaluate(`currentDashboardUser={role:'admin'}; dashboardLocksReady=true;
      document.getElementById('login-screen').style.display='none';
      document.getElementById('app').style.display='flex';
      showSection('advent',document.querySelector('button[onclick*="showSection(\\'advent\\'"]'));
      loadAdvent();`);
    assert.equal(await evaluate(`document.querySelectorAll('.advent-door').length`), 25);
    assert.equal(await evaluate(`document.getElementById('advent-image-day').options.length`), 26);
    assert.equal(await evaluate(`document.getElementById('advent-broadcast-channel').options.length`), 2);
    await evaluate(`document.getElementById('advent-broadcast-channel').value='1572351838823653398'; saveAdventChannel();`);
    assert.equal(fixture.config.channelId, '1572351838823653398');
    await evaluate(`document.getElementById('advent-message-text').value='My full announcement\\nMy custom rules {challenge}';
      draftAdventMessage(); loadAdvent();`);
    assert.equal(await evaluate(`document.getElementById('advent-message-text').value`),
      'My full announcement\nMy custom rules {challenge}');
    await evaluate(`saveAdventMessage('daily')`);
    assert.equal(fixture.config.announcementTemplate, 'My full announcement\nMy custom rules {challenge}');
    await evaluate(`document.getElementById('advent-closing-message-text').value='Closing announcement edited';
      draftAdventMessage('closing'); saveAdventMessage('closing');`);
    assert.equal(fixture.config.announcementClosingMessage, 'Closing announcement edited');
    const imageBase64 = createCanvas(32, 24).toBuffer('image/png').toString('base64');
    await evaluate(`{
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob('${imageBase64}'), c=>c.charCodeAt(0))], 'calendar.png', {type:'image/png'}));
      document.getElementById('advent-image-file').files=data.files;
    } uploadAdventImage();`);
    assert.equal(fixture.config.calendarImages[0].day, 0);
    assert.equal(await evaluate(`document.getElementById('advent-image-status').textContent.includes('1 / 26')`), true);
    await evaluate(`window.confirm=()=>true; removeAdventImage();`);
    assert.equal(fixture.config.calendarImages.length, 0);
    // Reproduce browsers with no createImageBitmap and blank MIME metadata.
    // Select 25 files together, verify natural ordering and explicit remapping.
    await evaluate(`{
      window.createImageBitmap = undefined;
      const files = Array.from({length:25},(_,i) => new File(
        [Uint8Array.from(atob('${imageBase64}'), c=>c.charCodeAt(0))],
        'calendar-' + (25-i) + '.png', {type:''}));
      stageAdventImages(files);
    }`);
    assert.equal(await evaluate(`adventImageQueue.length`), 25);
    assert.equal(await evaluate(`adventImageQueue[0].file.name`), 'calendar-1.png');
    assert.equal(await evaluate(`adventImageQueue[0].day`), 1);
    assert.equal(await evaluate(`adventImageQueue[24].day`), 25);
    assert.equal(fixture.config.calendarImages.length, 0, 'Selecting files must not save them');
    await evaluate(`assignAdventImage(0,'2')`);
    assert.equal(await evaluate(`document.getElementById('advent-images-save').disabled`), true);
    await evaluate(`assignAdventImage(1,'1'); loadAdvent()`);
    assert.equal(await evaluate(`adventImageQueue[0].day`), 2, 'Polling preserves assignments');
    assert.equal(await evaluate(`document.getElementById('advent-images-save').disabled`), false);
    failImageDay = 3;
    await evaluate(`saveAdventImages()`);
    assert.equal(fixture.config.calendarImages.length, 2);
    assert.equal(await evaluate(`adventImageQueue.length`), 23);
    assert.match(await evaluate(`adventImageQueue[0].status`), /Temporary image storage failure/);
    failImageDay = null;
    await evaluate(`saveAdventImages()`);
    assert.equal(fixture.config.calendarImages.length, 25);
    assert.deepEqual(fixture.config.calendarImages.map(image => image.day).sort((a,b)=>a-b),
      Array.from({length:25},(_,i)=>i+1));
    assert.equal(await evaluate(`adventImageQueue.length`), 0);
    assert.equal(await evaluate(`document.getElementById('advent-images-save').disabled`), true);
    await evaluate(`stageAdventImages([new File([new Uint8Array(10*1024*1024+1)], 'oversize.png', {type:'image/png'})])`);
    assert.equal(await evaluate(`document.getElementById('advent-images-save').disabled`), true);
    assert.match(await evaluate(`document.getElementById('advent-images-queue').textContent`), /exceeds 10 MB/);
    await evaluate(`clearAdventImages()`);
    // Regression for small JPEGs whose lossless PNG representation exceeds
    // 10 MB. Generate fixture pixels only, never load user data in a native decoder.
    const photo = createCanvas(2500, 1800);
    const photoContext = photo.getContext('2d');
    const pixels = photoContext.createImageData(2500, 1800);
    randomFillSync(pixels.data);
    for (let offset=3;offset<pixels.data.length;offset+=4) pixels.data[offset]=255;
    photoContext.putImageData(pixels,0,0);
    const photoJpg = photo.toBuffer('image/jpeg',45);
    assert.ok(photoJpg.length < 10 * 1024 * 1024);
    const photoBase64 = photoJpg.toString('base64');
    const originalExpansion = await evaluate(`(async()=>{
      window.testJpg=new File([Uint8Array.from(atob('${photoBase64}'),c=>c.charCodeAt(0))],'21.jpg',{type:'image/jpeg'});
      const image=new Image(); const url=URL.createObjectURL(testJpg);
      await new Promise(resolve=>{image.onload=resolve;image.src=url});
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      canvas.getContext('2d').drawImage(image,0,0);
      const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      URL.revokeObjectURL(url);return png.size;
    })()`);
    assert.ok(originalExpansion > 10 * 1024 * 1024, `Fixture PNG must reproduce the former error: ${originalExpansion}`);
    await evaluate(`stageAdventImages([testJpg]); assignAdventImage(0,'21'); saveAdventImages()`);
    assert.deepEqual(uploadedImages.get(21), photoJpg, 'Bulk replacement must upload the original JPG without conversion');
    assert.equal(fixture.config.calendarImages.find(image=>image.day===21).contentType,'image/jpeg');
    await evaluate(`{
      const data=new DataTransfer();
      data.items.add(new File([testJpg],'renamed.jpeg',{type:''}));
      document.getElementById('advent-image-file').files=data.files;
      document.getElementById('advent-image-day').value='21';
    } uploadAdventImage()`);
    assert.deepEqual(uploadedImages.get(21), photoJpg, 'Single upload preserves JPG with blank browser MIME metadata');
    // Existing server-side permissions remain authoritative, with matching
    // client-side prevention when staff assign a locked day.
    await evaluate(`currentDashboardUser={role:'mod'}; window.originalLockIsActive=lockIsActive;
      lockIsActive=key=>key==='advent.test.image.1';
      stageAdventImages([new File([Uint8Array.from(atob('${imageBase64}'), c=>c.charCodeAt(0))], 'day1.png', {type:'image/png'})])`);
    assert.equal(await evaluate(`document.getElementById('advent-images-save').disabled`), true);
    await evaluate(`assignAdventImage(0,'2')`);
    assert.equal(await evaluate(`document.getElementById('advent-images-save').disabled`), false);
    await evaluate(`clearAdventImages(); lockIsActive=window.originalLockIsActive; currentDashboardUser={role:'admin'}`);
    await evaluate(`selectAdventDay(3); document.getElementById('advent-challenge-text').value='Browser edited challenge';
      document.getElementById('advent-challenge-text').dataset.dirty='true'; saveAdventChallenge();`);
    assert.equal(fixture.config.challenges[2], 'Browser edited challenge');
    await evaluate(`document.getElementById('advent-challenge-text').value='Unsaved draft';
      document.getElementById('advent-challenge-text').dataset.dirty='true'; loadAdvent();`);
    assert.equal(await evaluate(`document.getElementById('advent-challenge-text').value`), 'Unsaved draft');
    await evaluate(`document.getElementById('advent-challenge-text').dataset.dirty='false'; adventAction('start');`);
    assert.equal(await evaluate(`document.getElementById('advent-year').disabled`), true);
    assert.equal(await evaluate(`document.querySelectorAll('.advent-door.today').length`), 1);
    assert.match(await evaluate(`document.getElementById('advent-scoreboard').textContent`), /0 \/ 25/);
    await evaluate(`document.getElementById('advent-review-000000000000000000000001').value='Approved in browser test';
      reviewAdventSubmission('000000000000000000000001','approved');`);
    assert.equal(fixture.submissions[0].status, 'approved');
    assert.equal(fixture.submissions[0].reviewNote, 'Approved in browser test');
    assert.match(await evaluate(`document.getElementById('advent-scoreboard').textContent`), /1 \/ 25/);
    await evaluate(`loadAdvent(true)`);
    assert.match(await evaluate(`document.getElementById('advent-scoreboard').textContent`), /Day 1: Completed/);
    await evaluate(`adventAction('advance')`);
    assert.equal(await evaluate(`document.querySelectorAll('.advent-door.opened,.advent-door.today').length`), 2);
    const outputDir = path.resolve('generated-artifacts/advent');
    fs.mkdirSync(outputDir, { recursive: true });
    await evaluate(`document.querySelector('#advent-scoreboard details').open=true; document.getElementById('advent-scoreboard').scrollIntoView({block:'center'})`);
    const scoreboard = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, 'scoreboard-desktop.png'), Buffer.from(scoreboard.data, 'base64'));
    const desktop = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, 'dashboard-desktop.png'), Buffer.from(desktop.data, 'base64'));
    await evaluate(`stageAdventImages(Array.from({length:3},(_,i)=>new File(
      [Uint8Array.from(atob('${imageBase64}'), c=>c.charCodeAt(0))], 'preview-day-'+(i+1)+'.png', {type:'image/png'})))`);
    const imagePanel = await evaluate(`(() => {
      const box=document.getElementById('advent-image-day').closest('.card').getBoundingClientRect();
      return {x:box.left+scrollX,y:box.top+scrollY,width:box.width,height:box.height,scale:1};
    })()`);
    const uploads = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: imagePanel });
    fs.writeFileSync(path.join(outputDir, 'calendar-image-uploads.png'), Buffer.from(uploads.data, 'base64'));
    await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 1000, deviceScaleFactor: 1, mobile: true });
    const mobile = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, 'dashboard-mobile.png'), Buffer.from(mobile.data, 'base64'));
    assert.equal(await evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`), false);
    await evaluate(`document.querySelector('#advent-scoreboard details').open=true; document.getElementById('advent-scoreboard').scrollIntoView({block:'center'})`);
    const mobileScoreboard = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, 'scoreboard-mobile.png'), Buffer.from(mobileScoreboard.data, 'base64'));
    assert.equal(await evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`), false);
    await evaluate(`window.prompt=()=> 'RESET TEST'; adventAction('reset')`);
    assert.equal(await evaluate(`document.getElementById('advent-year').disabled`), false);
    assert.equal(fixture.run.state, 'idle');
    assert.match(await evaluate(`document.getElementById('advent-scoreboard').textContent`), /No participants yet/);
    assert.ok(requests.some(req => req.url.endsWith('/challenges/3') && req.body.text === 'Browser edited challenge'));
    await evaluate(`showSection('commands',document.querySelector('button[onclick*="showSection(\\'commands\\'"]')); loadCommands();`);
    assert.equal(await evaluate(`document.querySelectorAll('#commands-sections tbody tr').length`),
      buildCommandCatalog(commandDefinitions).length);
    assert.equal(await evaluate(`document.getElementById('cmdrow-approve').textContent.includes('/approve')`), true);
    assert.equal(await evaluate(`document.getElementById('cmdrow-pricealert.add').textContent.includes('/pricealert add')`), true);
    assert.equal(await evaluate(`document.querySelectorAll('#commands-sections input, #commands-sections button').length`), 0);
    await evaluate(`document.querySelector('#cmdrow-approve details').open=true`);
    assert.equal(await evaluate(`document.getElementById('cmdrow-approve').textContent.includes('picture (required)')`), true);
    commandDefinitions.push(new SlashCommandBuilder().setName('new-command').setDescription('Automatically added command').toJSON());
    await evaluate(`loadCommands()`);
    assert.equal(await evaluate(`Boolean(document.getElementById('cmdrow-new-command'))`), true);
    commandDefinitions.pop();
    await evaluate(`loadCommands()`);
    assert.equal(await evaluate(`Boolean(document.getElementById('cmdrow-new-command'))`), false);
    failCommands = true;
    await evaluate(`loadCommands()`);
    assert.match(await evaluate(`document.getElementById('commands-status').textContent`), /temporarily unavailable/);
    assert.equal(await evaluate(`Boolean(document.getElementById('cmdrow-approve'))`), true);
    failCommands = false;
    await evaluate(`loadCommands()`);
    await cmd('Emulation.setDeviceMetricsOverride', { width:1440, height:1000, deviceScaleFactor:1, mobile:false });
    await evaluate(`document.getElementById('section-commands').scrollIntoView({block:'start'})`);
    const commandsDesktop = await cmd('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(outputDir,'commands-desktop.png'), Buffer.from(commandsDesktop.data,'base64'));
    await cmd('Emulation.setDeviceMetricsOverride', { width:420, height:1000, deviceScaleFactor:1, mobile:true });
    assert.equal(await evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`), false);
    const commandsMobile = await cmd('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(outputDir,'commands-mobile.png'), Buffer.from(commandsMobile.data,'base64'));
    assert.deepEqual(errors, []);
    console.log('PASS: Advent desktop/mobile flows, byte-identical JPG bulk/single replacement despite PNG expansion above 10 MB, and automatic slash command reference.');
  } finally {
    socket?.close();
    browser.kill('SIGTERM');
    server.close();
    // Browser shutdown releases the profile asynchronously; it lives in /tmp.
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
