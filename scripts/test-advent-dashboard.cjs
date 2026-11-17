// Isolated browser regression test. Uses fixtures only; never connects to
// production, Discord, MongoDB, or the real dashboard authentication service.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { DEFAULT_CHALLENGES, TEST_CHANNEL_ID } = require('../artifacts/discord-bot/advent-domain');
const { createCanvas } = require('../artifacts/discord-bot/node_modules/@napi-rs/canvas');

async function main() {
  const fixture = {
    config: { year: 2026, challenges: [...DEFAULT_CHALLENGES], dayDurationSeconds: 60, channelId: TEST_CHANNEL_ID, calendarImages: [] },
    run: { id: 'browser-fixture', state: 'idle', day: 0, opened: 0, dayEndsAt: null },
    submissions: [{
      _id: '000000000000000000000001', day: 1, username: 'Test member', challenge: DEFAULT_CHALLENGES[0],
      status: 'pending', note: 'Test screenshot', proofUrl: '', createdAt: '2026-12-01T12:00:00Z',
    }],
    announcements: [],
  };
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/dashboard') {
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(path.resolve('artifacts/discord-bot/dashboard.html')));
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
      fixture.config.calendarImages = fixture.config.calendarImages.filter(image => image.day !== day);
      if (req.method === 'POST') {
        assert.equal(req.headers['content-type'], 'image/png');
        assert.equal(raw.subarray(1, 4).toString(), 'PNG');
        fixture.config.calendarImages.push({ day, size: raw.length, updatedAt: new Date().toISOString() });
      }
    } else if (req.method === 'PATCH' && req.url.includes('/challenges/')) {
      fixture.config.challenges[Number(req.url.split('/').at(-1)) - 1] = body.text;
    } else if (req.method === 'PATCH') {
      Object.assign(fixture.config, body);
    } else if (req.url.endsWith('/actions')) {
      if (body.action === 'start') fixture.run = { ...fixture.run, state: 'running', day: 1, opened: 1 };
      if (body.action === 'advance') fixture.run = { ...fixture.run, state: 'running', day: 2, opened: 2 };
      if (body.action === 'reset') fixture.run = { ...fixture.run, state: 'idle', day: 0, opened: 0 };
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
    await evaluate(`selectAdventDay(3); document.getElementById('advent-challenge-text').value='Browser edited challenge';
      document.getElementById('advent-challenge-text').dataset.dirty='true'; saveAdventChallenge();`);
    assert.equal(fixture.config.challenges[2], 'Browser edited challenge');
    await evaluate(`document.getElementById('advent-challenge-text').value='Unsaved draft';
      document.getElementById('advent-challenge-text').dataset.dirty='true'; loadAdvent();`);
    assert.equal(await evaluate(`document.getElementById('advent-challenge-text').value`), 'Unsaved draft');
    await evaluate(`document.getElementById('advent-challenge-text').dataset.dirty='false'; adventAction('start');`);
    assert.equal(await evaluate(`document.getElementById('advent-year').disabled`), true);
    assert.equal(await evaluate(`document.querySelectorAll('.advent-door.today').length`), 1);
    await evaluate(`document.getElementById('advent-review-000000000000000000000001').value='Approved in browser test';
      reviewAdventSubmission('000000000000000000000001','approved');`);
    assert.equal(fixture.submissions[0].status, 'approved');
    assert.equal(fixture.submissions[0].reviewNote, 'Approved in browser test');
    await evaluate(`adventAction('advance')`);
    assert.equal(await evaluate(`document.querySelectorAll('.advent-door.opened,.advent-door.today').length`), 2);
    const outputDir = path.resolve('generated-artifacts/advent');
    fs.mkdirSync(outputDir, { recursive: true });
    const desktop = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, 'dashboard-desktop.png'), Buffer.from(desktop.data, 'base64'));
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
    await evaluate(`window.prompt=()=> 'RESET TEST'; adventAction('reset')`);
    assert.equal(await evaluate(`document.getElementById('advent-year').disabled`), false);
    assert.equal(fixture.run.state, 'idle');
    assert.ok(requests.some(req => req.url.endsWith('/challenges/3') && req.body.text === 'Browser edited challenge'));
    assert.deepEqual(errors, []);
    console.log('PASS: Advent desktop/mobile browser flows, 26 image slots, image upload/removal, editable challenge, polling draft, start, day advance, review and reset.');
  } finally {
    socket?.close();
    browser.kill('SIGTERM');
    server.close();
    // Browser shutdown releases the profile asynchronously; it lives in /tmp.
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
