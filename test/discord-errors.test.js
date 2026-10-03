'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDiscordError, safeErrorDetails } = require('../src/discord-errors');

test('Discord permission and role errors offer specific repair instructions', () => {
  assert.match(formatDiscordError({ code: 50013 }), /Gerenciar cargos/);
  assert.match(formatDiscordError({ code: 50001 }), /Ver canais/);
  assert.match(formatDiscordError({ code: 'InvalidType' }), /cargos da equipe/);
  assert.match(formatDiscordError({ code: 'BOT_INVALID_ROLE', message: 'Crie um cargo Administração.' }), /Crie um cargo/);
  assert.match(formatDiscordError(new Error('O bot já recebe acesso próprio aos canais.')), /bot já recebe/);
});

test('console reports error details and stage without request bodies or secrets', () => {
  const env = { DISCORD_TOKEN: 'my-very-secret-bot-token', ENCRYPTION_KEY: 'my-very-secret-encryption-key' };
  const error = Object.assign(new Error(`Missing Permissions ${env.DISCORD_TOKEN}\n${env.ENCRYPTION_KEY} Authorization: Bot another-secret-token`), {
    code: 50013,
    botContext: 'acesso ao canal de dados',
    requestBody: { password: 'command-password' },
    headers: { Authorization: env.DISCORD_TOKEN }
  });
  const logged = safeErrorDetails(error, { env });
  assert.match(logged, /50013/);
  assert.match(logged, /Missing Permissions/);
  assert.match(logged, /acesso ao canal de dados/);
  for (const secret of [...Object.values(env), 'command-password', 'another-secret-token']) assert.ok(!logged.includes(secret));
  assert.ok(!logged.includes('\n'));
  const reply = formatDiscordError(new Error(`Configuration rejected ${env.ENCRYPTION_KEY}`), { env });
  assert.ok(!reply.includes(env.ENCRYPTION_KEY));
});
