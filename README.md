# Unlock Fácil — Discord Bot v3

Bot administrativo para o Unlock Fácil. **Não usa banco de dados externo.** Os registros ficam armazenados em mensagens nos canais do Discord.

## Comandos

- `/configurar` — cria a estrutura
- `/venda` — registra vendas
- `/vencimento` — registra vencimentos
- `/troca` — registra trocas
- `/troca-senha` — registra trocas de senha
- `/renovar` — registra renovações
- `/ver` — consulta um registro ou mostra o mais recente de um tipo
- `/buscar` — busca por cliente, login, ID ou texto
- `/listar` — lista registros recentes de um tipo
- `/vencimentos-proximos` — mostra vencimentos próximos
- `/painel` — resumo geral

## Instalação

1. Instale Node.js LTS.
2. Abra o terminal nesta pasta.
3. Execute `npm install`.
4. Copie `.env.example` para `.env`.
5. Preencha `DISCORD_TOKEN`, `CLIENT_ID` e `GUILD_ID`.
6. Execute `node deploy.js`.
7. Execute `node index.js`.

Depois de alterar os comandos, execute `node deploy.js` novamente.

## Importante

O bot não guarda dados de negócio em arquivo, JSON, MySQL, Supabase ou Firebase. Os registros são mensagens no Discord.

Como trocas de senha podem conter credenciais, mantenha a categoria/canais administrativos acessíveis somente às pessoas autorizadas.
