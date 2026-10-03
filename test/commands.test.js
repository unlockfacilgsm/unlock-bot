const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const { buildCommands, ADMIN_COMMANDS } = require('../src/commands');
const { deployCommands } = require('../deploy');

function definitions() {
  return buildCommands().map(command => command.toJSON());
}

function named(name) {
  const definition = definitions().find(command => command.name === name);
  assert.ok(definition, `Comando ausente: ${name}`);
  return definition;
}

function option(command, name) {
  const result = command.options.find(value => value.name === name);
  assert.ok(result, `Opção ausente: ${command.name}/${name}`);
  return result;
}

test('o registro serializa sem nomes duplicados e contém todos os fluxos', () => {
  const commands = definitions();
  assert.equal(new Set(commands.map(command => command.name)).size, commands.length);
  assert.deepEqual(commands.map(command => command.name).sort(), [
    'alertas', 'auditoria', 'backup', 'buscar', 'configurar', 'conta', 'estoque',
    'exportar', 'listar', 'migrar', 'painel', 'renovar', 'restaurar', 'troca', 'troca-senha',
    'trocar-senhas', 'vencidas', 'vencimentos-proximos', 'vender', 'ver'
  ].sort());

  // O Discord rejeita opções obrigatórias depois de opcionais, inclusive em subcomandos.
  function checkOptions(options = []) {
    let optionalSeen = false;
    for (const item of options) {
      assert.ok(item.description.length >= 1 && item.description.length <= 100);
      if (item.type === 1 || item.type === 2) {
        checkOptions(item.options);
        continue;
      }
      if (!item.required) optionalSeen = true;
      else assert.equal(optionalSeen, false, `Ordem inválida em ${item.name}`);
      assert.ok(!(item.autocomplete && item.choices), 'Autocomplete não pode ter escolhas estáticas');
    }
  }
  for (const command of commands) checkOptions(command.options);
});

test('/vender é o único comando de venda e permite conta do estoque ou credencial manual', () => {
  const original = named('vender');
  assert.equal(definitions().some(command => command.name === 'venda'), false);
  assert.deepEqual(original.options.filter(item => item.required).map(item => item.name), [
    'cliente', 'ferramenta', 'plano'
  ]);
  for (const name of ['conta', 'login', 'senha']) assert.equal(option(original, name).required, false);
  assert.equal(option(original, 'senha').max_length, 200);
});

test('planos usam autocomplete por ferramenta e renovação identifica a venda', () => {
  for (const name of ['vender', 'renovar']) {
    const plan = option(named(name), 'plano');
    assert.equal(plan.required, true);
    assert.equal(plan.autocomplete, true);
    assert.equal(plan.choices, undefined);
  }
  assert.equal(option(named('renovar'), 'venda').required, true);
  assert.equal(named('renovar').options.some(item => item.name === 'cliente'), false);
  assert.deepEqual(option(named('vender'), 'ferramenta').choices.map(choice => choice.value), [
    'Unlock Tool', 'Borneo Schematics', 'TSM Tool', 'AMT Tool', 'TFM Tool'
  ]);
});

test('mudanças de senha exigem confirmação explícita da alteração externa', () => {
  for (const name of ['troca-senha', 'trocar-senhas']) {
    const confirmation = option(named(name), 'confirmada');
    assert.equal(confirmation.type, 5);
    assert.equal(confirmation.required, true);
    assert.equal(option(named(name), 'nova_senha').max_length, 200);
  }
  const subcommand = option(named('conta'), 'senha');
  assert.equal(option(subcommand, 'confirmada').required, true);
  assert.equal(option(subcommand, 'nova_senha').max_length, 200);
});

test('comandos administrativos têm permissão padrão e vendedores não são bloqueados pelo registro', () => {
  for (const command of definitions()) {
    if (ADMIN_COMMANDS.has(command.name)) {
      assert.equal(command.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
    } else {
      assert.ok(command.default_member_permissions == null, `${command.name} bloqueia o cargo vendedor`);
    }
    // O deploy registra apenas comandos do servidor; não usa a flag DM obsoleta.
    assert.equal(command.dm_permission, undefined);
  }
});

test('valores, limites de lote e períodos de exportação são limitados na interface', () => {
  for (const name of ['vender', 'renovar']) {
    for (const field of ['valor', 'desconto']) {
      assert.equal(option(named(name), field).min_value, 0);
      assert.equal(option(named(name), field).max_value, 1000000);
    }
  }
  assert.equal(option(named('trocar-senhas'), 'vencimentos').max_length, 2000);
  assert.equal(option(named('listar'), 'quantidade').max_value, 100);
  assert.equal(option(named('auditoria'), 'quantidade').max_value, 100);
  assert.equal(option(named('alertas'), 'antecedencia').max_value, 43200);
  for (const field of ['inicio', 'fim']) {
    assert.equal(option(named('exportar'), field).min_length, 10);
    assert.equal(option(named('exportar'), field).max_length, 10);
  }
});

test('restauração aceita anexo e exige confirmação do administrador', () => {
  assert.equal(option(named('restaurar'), 'arquivo').type, 11);
  assert.equal(option(named('restaurar'), 'arquivo').required, true);
  assert.equal(option(named('restaurar'), 'confirmada').required, true);
  assert.equal(named('restaurar').default_member_permissions, String(PermissionFlagsBits.ManageGuild));
});

test('/configurar seleciona cargos da equipe e explica que não aceita usuários ou cargo do bot', () => {
  const configure = named('configurar');
  for (const field of ['administrador', 'vendedor']) {
    const role = option(configure, field);
    assert.equal(role.type, 8);
    assert.equal(role.required, false);
    assert.match(role.description, /Cargo|cargo/);
    assert.match(role.description, /@everyone/);
    assert.match(role.description, /bot/);
  }
  assert.match(configure.description, /cargos, não usuários/);
});

test('importar deploy não registra comandos e credenciais ausentes falham antes da rede', async () => {
  assert.equal(typeof deployCommands, 'function');
  for (const missing of ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID']) {
    const env = { DISCORD_TOKEN: 'unused', CLIENT_ID: 'unused', GUILD_ID: 'unused', [missing]: ' ' };
    await assert.rejects(deployCommands(env), new RegExp(missing));
  }
});
