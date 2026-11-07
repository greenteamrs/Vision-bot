const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
const lockFunctions = html.slice(
  html.indexOf('  function dashboardLockIcon('),
  html.indexOf('  function makeDashboardLockButton('),
);

test('lock icons do not rewrite normalized SVG markup on every refresh', () => {
  const context = vm.createContext({});
  vm.runInContext(`
    let dashboardLocks = {};
    let dashboardLocksReady = true;
    let currentDashboardUser = { role: 'admin' };
    ${lockFunctions}
  `, context);
  let writes = 0;
  const button = {
    dataset: {},
    classList: { toggle() {} },
    setAttribute() {},
    get innerHTML() { return '<svg>browser-normalized markup</svg>'; },
    set innerHTML(value) { writes++; },
  };
  context.button = button;
  vm.runInContext(`
    setLockButtonState(button, 'settings.xp');
    setLockButtonState(button, 'settings.xp');
    setLockButtonState(button, 'settings.xp');
  `, context);
  assert.equal(writes, 1);
  assert.equal(button.disabled, false);
  vm.runInContext(`
    dashboardLocks['settings.xp'] = true;
    setLockButtonState(button, 'settings.xp');
    setLockButtonState(button, 'settings.xp');
  `, context);
  assert.equal(writes, 2);
  assert.equal(button.dataset.lockIconState, 'locked');
});

test('moderators stay locked while permissions load; admin retains access', () => {
  const context = vm.createContext({});
  vm.runInContext(`
    let dashboardLocks = {};
    let dashboardLocksReady = false;
    let currentDashboardUser = { role: 'mod' };
    ${lockFunctions}
  `, context);
  assert.equal(vm.runInContext("lockIsActive('settings.xp')", context), true);
  vm.runInContext("currentDashboardUser = { role: 'admin' }", context);
  assert.equal(vm.runInContext("lockIsActive('settings.xp')", context), false);
});
