'use strict';

function redact(value, env = process.env) {
  let text = String(value ?? '');
  for (const [name, secret] of Object.entries(env)) {
    if (/(?:TOKEN|KEY|PASSWORD|SECRET)/i.test(name) && typeof secret === 'string' && secret.length >= 4) {
      text = text.split(secret).join('[segredo oculto]');
    }
  }
  return text
    .replace(/\bAuthorization\s*[:=]\s*(?:Bot|Bearer)\s+[^\s,;"']+/gi, '[autorização oculta]')
    .replace(/\b(?:Bot|Bearer)\s+[A-Za-z0-9_.-]{20,}/g, '[autorização oculta]')
    .replace(/\b(?:mfa\.[\w-]+|[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,})\b/g, '[token oculto]');
}

function formatDiscordError(error, { env = process.env } = {}) {
  const code = String(error?.code ?? '');
  const messages = {
    '50013': 'Falta permissão do bot no Discord (50013). No cargo do bot, habilite Gerenciar canais e Gerenciar cargos; confira também Ver canais, Ler histórico de mensagens, Enviar mensagens, Anexar arquivos e Inserir links nos canais do bot. Depois tente novamente.',
    '50001': 'O bot não tem acesso ao servidor ou canal (50001). Confira Ver canais e Ler histórico de mensagens no cargo do bot e nas permissões do canal. Preserve o canal de dados existente.',
    '50035': 'O Discord rejeitou os dados enviados (50035). Confira os cargos selecionados e consulte o motivo no console.',
    '10003': 'O canal configurado não foi encontrado no Discord (10003). Confira o ID do canal; preserve o histórico existente.',
    '10011': 'O cargo selecionado não existe neste servidor (10011). Selecione um cargo da equipe em /configurar.',
    '10062': 'A interação expirou no Discord (10062). Execute o comando novamente.',
    '40060': 'Essa interação já foi respondida (40060). Execute o comando novamente.',
    InvalidType: 'Não foi possível identificar um cargo ou membro nas permissões. Reinicie o bot com o código atualizado; em /configurar, selecione cargos da equipe, não seu @usuário nem o cargo automático do bot.',
    TokenInvalid: 'DISCORD_TOKEN inválido. Confira o token do bot no .env, sem compartilhar seu conteúdo.',
    '401': 'O Discord recusou a autenticação. Confira DISCORD_TOKEN no .env.',
    '4014': 'O Discord recusou um intent do bot. Habilite Message Content Intent no Developer Portal.'
  };
  if (messages[code]) return messages[code];
  if (code && !code.startsWith('BOT_')) {
    return `Não foi possível concluir a operação no Discord (${redact(code, env)}). Consulte o motivo no console. Os dados já confirmados serão retomados.`;
  }
  return redact(error?.message || 'Ocorreu um erro inesperado.', env).slice(0, 1800);
}

// Deliberately omit request bodies, headers and HTTP error objects: they may
// contain bot tokens or the passwords supplied to a command.
function safeErrorDetails(error, { env = process.env } = {}) {
  const name = redact(error?.name || 'Error', env).replace(/[\r\n]/g, ' ');
  const code = error?.code == null ? '' : ` [${redact(error.code, env)}]`;
  const context = error?.botContext ? ` (${redact(error.botContext, env)})` : '';
  const message = redact(error?.message || 'Sem descrição adicional.', env).replace(/[\r\n]+/g, ' ').slice(0, 1400);
  return `${name}${code}${context}: ${message}`;
}

module.exports = { formatDiscordError, safeErrorDetails };
