// Derive documentation from the exact JSON sent to Discord. No second list of
// commands, usage strings or subcommands needs to be maintained.
function buildCommandCatalog(definitions, categories = {}) {
  const rows = [];
  const types = { 3:'text', 4:'number', 5:'true/false', 6:'user', 7:'channel', 8:'role',
    9:'user-or-role', 10:'number', 11:'picture' };
  for (const definition of definitions) {
    const root = typeof definition.toJSON === 'function' ? definition.toJSON() : definition;
    const access = /\(admins?\)/i.test(root.description) || String(root.default_member_permissions) === '8'
      ? 'Admin' : /\(mods?\)/i.test(root.description) ? 'Moderator' :
        root.default_member_permissions != null && String(root.default_member_permissions) !== '0' ? 'Restricted' : '';
    function visit(command, path) {
      const children = (command.options || []).filter(option => option.type === 1 || option.type === 2);
      if (children.length) {
        for (const child of children) visit(child, [...path, child.name]);
        return;
      }
      const options = (command.options || []).map(option => ({
        name:option.name, description:option.description || '', required:Boolean(option.required),
        type:types[option.type] || 'value', autocomplete:Boolean(option.autocomplete),
        choices:(option.choices || []).map(choice => String(choice.name)),
      }));
      const name = path.join(' ');
      rows.push({
        key:path.join('.'), name, category:categories[root.name] || 'Other slash commands',
        description:command.description || root.description, access, isMod:Boolean(access), options,
        usage:`/${name}${options.length ? ' ' : ''}${options.map(option => {
          const parameter = `${option.name}:<${option.type}>`;
          return option.required ? parameter : `[${parameter}]`;
        }).join(' ')}`,
      });
    }
    visit(root, [root.name]);
  }
  return rows.sort((a,b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}
module.exports = { buildCommandCatalog };
