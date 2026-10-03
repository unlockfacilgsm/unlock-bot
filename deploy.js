const { REST, Routes } = require('discord.js');
const { buildCommands } = require('./src/commands');

async function deployCommands(env = process.env) {
  for (const key of ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID']) {
    if (!env[key]?.trim()) throw new Error(`${key} não foi configurado no .env.`);
  }

  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
  const body = buildCommands().map(command => command.toJSON());
  await rest.put(Routes.applicationGuildCommands(env.CLIENT_ID, env.GUILD_ID), { body });
  return body.length;
}

if (require.main === module) {
  require('dotenv').config();
  deployCommands().then(count => {
    console.log(`${count} comandos registrados/atualizados com sucesso.`);
  }).catch(error => {
    // Não imprimir o objeto HTTP: pode conter credenciais da requisição.
    console.error(`Falha ao registrar comandos: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { deployCommands };
