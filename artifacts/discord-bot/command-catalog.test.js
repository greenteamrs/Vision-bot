const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { SlashCommandBuilder } = require('discord.js');
const { buildCommandCatalog } = require('./command-catalog');

const source = fs.readFileSync(`${__dirname}/bot.js`, 'utf8');
function actualDefinitions() {
  return vm.runInNewContext(source.slice(source.indexOf('function addRecipientOptions('),
    source.indexOf('async function registerSlashCommands(')) + '\nSLASH_COMMANDS;', { SlashCommandBuilder });
}

test('catalog uses all actual slash definitions and documents subcommands, with no retired prefix commands', () => {
  const definitions = actualDefinitions();
  const rows = buildCommandCatalog(definitions);
  const names = rows.map(row => row.name);
  for (const root of definitions) assert.ok(names.some(name => name === root.name || name.startsWith(`${root.name} `)), root.name);
  for (const name of ['approve', 'adventsubmit', 'pricealert add', 'pricealert list', 'pricealert remove',
    'event list', 'event join', 'event submit', 'event progress', 'event leaderboard', 'help']) assert.ok(names.includes(name), name);
  for (const name of ['fixlp', 'importmee6', 'cleanduplicates', 'testaward', 'total']) assert.ok(!names.includes(name), name);
  assert.ok(rows.every(row => row.usage.startsWith('/') && !row.usage.startsWith('!')));
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  assert.equal(rows.find(row => row.name === 'approve').description, definitions.find(root => root.name === 'approve').description);
});

test('usage, option descriptions, choices and access labels come directly from slash JSON', () => {
  const rows = buildCommandCatalog(actualDefinitions());
  const approve = rows.find(row => row.name === 'approve');
  assert.match(approve.usage, /^\/approve picture:<text> \[team:<text>\] \[tile:<text>\]$/);
  assert.equal(approve.access, 'Moderator');
  assert.equal(approve.options[0].autocomplete, true);
  assert.equal(rows.find(row => row.name === 'addxp').access, 'Admin');
  const submit = rows.find(row => row.name === 'adventsubmit');
  assert.match(submit.usage, /screenshot:<picture> \[note:<text>\]/);
  const alert = rows.find(row => row.name === 'pricealert add');
  assert.deepEqual(alert.options.find(option => option.name === 'direction').choices,
    ['at or below the target', 'at or above the target']);
  assert.equal(alert.access, 'Moderator', 'Subcommands inherit root restrictions');
});

test('new commands, subcommands and options appear automatically without category metadata or database rows', () => {
  const definitions = actualDefinitions();
  const before = buildCommandCatalog(definitions);
  const added = new SlashCommandBuilder().setName('future-command').setDescription('An automatically documented command')
    .addBooleanOption(option => option.setName('notify').setDescription('Notify the member'));
  definitions.push(added);
  const after = buildCommandCatalog(definitions);
  assert.equal(after.length, before.length + 1);
  assert.equal(after.find(row => row.name === 'future-command').usage, '/future-command [notify:<true/false>]');
  assert.equal(after.find(row => row.name === 'future-command').category, 'Other slash commands');
  const event = definitions.find(command => command.name === 'event');
  event.options.push({ type:1, name:'future-action', description:'New event action' });
  assert.ok(buildCommandCatalog(definitions).some(row => row.name === 'event future-action'));
  event.options.pop(); definitions.pop();
  assert.equal(buildCommandCatalog(definitions).length, before.length);
});

test('nested subcommand groups are flattened with correct full command paths', () => {
  const command = new SlashCommandBuilder().setName('manage').setDescription('Management')
    .addSubcommandGroup(group => group.setName('events').setDescription('Events')
      .addSubcommand(sub => sub.setName('open').setDescription('Open an event')
        .addStringOption(option => option.setName('event').setDescription('Event name').setRequired(true))));
  const [row] = buildCommandCatalog([command]);
  assert.equal(row.name, 'manage events open');
  assert.equal(row.usage, '/manage events open event:<text>');
  assert.equal(row.description, 'Open an event');
});

test('authenticated API returns derived definitions without looking up stale command settings', async () => {
  const start = source.indexOf("    // GET /api/commands");
  const end = source.indexOf("    // PATCH /api/commands/:key", start);
  let response;
  const run = vm.runInNewContext(`(async () => { ${source.slice(start, end)} })`, {
    pathname:'/api/commands', req:{method:'GET'}, res:{},
    ALL_COMMANDS:[{name:'approve',category:'Events'}], SLASH_COMMANDS:actualDefinitions(),
    CommandConfig:{find() { throw new Error('Must not use old prefix command rows'); }},
    buildCommandCatalog, sendJson:(_,status,data)=>{response={status,data};},
  });
  await run();
  assert.equal(response.status,200);
  assert.ok(response.data.some(row => row.name === 'approve'));
  assert.ok(source.indexOf('const authUser = checkAuth(req)') < start);
});

test('dashboard renders slash commands and no longer offers ineffective prefix renaming', () => {
  const html = fs.readFileSync(`${__dirname}/dashboard.html`, 'utf8');
  const commands = html.slice(html.indexOf('// ---- COMMANDS ----'), html.indexOf('async function saveLevelSettings('));
  assert.ok(commands.includes('/${esc(c.name)}'));
  assert.doesNotMatch(commands, /saveCommandName|cmdinput-|api\('PATCH'/);
  assert.match(commands,/if \(!res\.ok\) throw/);
  const patch = source.slice(source.indexOf('    // PATCH /api/commands/:key'), source.indexOf('    // GET /api/bingo', source.indexOf('    // PATCH /api/commands/:key')));
  assert.match(patch,/sendJson\(res, 409/);
  assert.doesNotMatch(patch,/CommandConfig\.findOneAndUpdate/);
});
