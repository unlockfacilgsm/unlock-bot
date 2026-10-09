# Unlock Fácil — bot administrativo do Discord

Controle de contas, vendas, renovações, vencimentos e receitas para Unlock Tool, Borneo Schematics, TSM Tool, AMT Tool e TFM Tool.

**Sem banco local.** O Discord guarda o histórico de eventos em anexos autenticados com HMAC de um canal privado. As senhas ficam criptografadas; os eventos podem conter valores e outros dados administrativos em texto. Backups e checkpoints são criptografados por completo. O bot reconstrói o estado em memória ao iniciar. Não há SQLite nem arquivos locais com contas, vendas ou senhas. O `.env` contém somente configuração e segredos necessários para acessar os dados.

## Instalação e atualização

Use **Node.js 22.13 ou superior**, uma aplicação de bot do Discord e um servidor em que você possa gerenciar canais e permissões.

1. Execute `npm ci` nesta pasta.
2. Copie `.env.example` para `.env` e preencha `DISCORD_TOKEN`, `CLIENT_ID` e `GUILD_ID`. `ADMIN_ROLE_ID` e `SELLER_ROLE_ID` são opcionais e fornecem os cargos iniciais; `/configurar` pode defini-los depois.
3. Execute `npm run keygen`, copie a chave gerada para `ENCRYPTION_KEY` no `.env` e guarde uma segunda cópia em um local seguro fora do servidor. A chave tem 32 bytes codificados em base64.
4. Execute `npm run check` e `npm test` para verificar a instalação.
5. Execute `npm run deploy` para registrar os comandos **no servidor indicado por `GUILD_ID`**.
6. Execute `npm start` e, no Discord, use `/configurar administrador:<cargo Administração> vendedor:<cargo Vendedores>`. Esses campos selecionam cargos do servidor, não usuários.

Após alterar os comandos, rode `npm run deploy` novamente. Após atualizar o código, reinicie o processo. Mantenha **uma única instância do bot por servidor**, para que reservas e operações sejam serializadas.

O bot precisa ver os canais administrativos, ler o histórico, enviar mensagens e anexos, gerenciar canais e ajustar suas permissões. O convite precisa dos escopos `bot` e `applications.commands`. Os intents usados são `Guilds`, `GuildMessages` e `MessageContent`. Habilite **Message Content Intent** na aplicação do bot para permitir a leitura do histórico legado durante a migração.

Após criar a estrutura, copie o ID do canal privado `dados-bot` para `DISCORD_DATA_CHANNEL_ID` no `.env`. Assim o bot encontra o histórico mesmo se o canal for renomeado. Ao reiniciar uma instalação existente, mantenha esse ID apontando para o canal original.

**Preserve a mesma `ENCRYPTION_KEY` em atualizações e reinícios.** Uma chave diferente não consegue ler o histórico existente. Não envie o `.env`, o token ou a chave para canais do Discord, Git ou logs. O bot valida a chave ao iniciar sem imprimir seu conteúdo.

## Ferramentas e preços

| Ferramenta | Planos |
| --- | --- |
| 🔓 Unlock Tool | 12 horas — R$ 20,00; 3 meses — R$ 60,00; 6 meses — R$ 90,00 |
| 🔧 Borneo Schematics | 3 dias — R$ 40,00 (2 HWIDs) |
| 🛠️ TSM Tool | 12 horas — R$ 25,00 |
| ⚙️ AMT Tool | 12 horas — R$ 25,00 |
| 🔩 TFM Tool | 12 horas — R$ 25,00 |

O catálogo fica em `src/catalog.js`. A sugestão de planos mostra apenas os válidos para a ferramenta, com seu preço. Alterar a tabela afeta novas operações; cada venda e renovação preserva o valor registrado na ocasião.

## Permissões e canais

`/configurar` cria ou atualiza canais privados sem excluir canais antigos. Os campos `administrador` e `vendedor` são **cargos do servidor**; seu `@` pessoal não aparece nessa lista. Crie um cargo **Administração** nas configurações de cargos do servidor e atribua esse cargo a você. Se outras pessoas forem vender, crie **Vendedores** e atribua a elas. Selecione esses cargos no comando. Quem tem o cargo de administrador também pode vender, sem precisar de um segundo cargo.

Se você é o proprietário do servidor ou tem **Gerenciar servidor**, pode executar `/configurar` sem escolher cargos adicionais e defini-los depois. Se a lista mostra apenas `@everyone` e o cargo do bot, ainda não existe um cargo de equipe para selecionar. O bot rejeita `@everyone`, pois daria acesso a todas as pessoas, e cargos gerenciados por integrações.

O bot usa sua própria conta e seu cargo de integração, como **Unlock Fácil**. Não escolha esse cargo em `administrador` ou `vendedor` e não tente atribuí-lo a você. As permissões do bot são configuradas nesse cargo; o comando seleciona cargos das pessoas da equipe.

Cada comando também verifica a autorização no bot; consultas e operações devem ser feitas nos canais administrativos configurados.

`/configurar`, `/migrar`, `/backup`, `/restaurar`, `/auditoria`, `/alertas` e `/excluir` têm a permissão padrão **Gerenciar servidor** no registro do Discord. Para um cargo de administrador que não tenha essa permissão, libere esses comandos em **Configurações do servidor → Integrações → bot → comandos**. A validação de cargo no bot continua sendo necessária. Vendedores podem usar os demais comandos com o cargo escolhido na configuração e acesso aos canais privados.

Os dados estruturados ficam em um canal privado separado. Preserve seus anexos e o histórico: apagar eventos ou o canal remove a fonte persistente do bot. Os canais visuais são uma interface para acompanhar a operação.

Se `/configurar` retornar **50013 / Missing Permissions**, confira as permissões do cargo do bot. Ele precisa de **Gerenciar canais** para criar a estrutura e **Gerenciar cargos** para editar as permissões dos canais, além de ver os canais, ler o histórico e enviar mensagens e anexos. Em uma instalação em que apenas Gerenciar cargos esteja ausente, habilite essa permissão no cargo **Unlock Fácil** e execute `/configurar` novamente. Se a permissão já estiver habilitada e um cargo escolhido não puder ser gerenciado pelo bot, confira a posição desses cargos na hierarquia.

Use `npm run doctor` para consultar o acesso do bot, os cargos e as permissões do servidor sem alterar a configuração no Discord. O diagnóstico e os erros do console mostram o código e o motivo da falha sem imprimir tokens ou senhas. Depois de corrigir a permissão indicada, repita `/configurar`.

## Contas e vendas

1. Cadastre o estoque com `/conta adicionar ferramenta:<ferramenta> login:<login> senha:<senha>`.
2. Consulte `/estoque` ou `/conta listar`, com filtros opcionais de ferramenta e situação.
3. Venda com `/vender cliente:<cliente> ferramenta:<ferramenta> plano:<plano> conta:<ACC-...>`.

`/vender` é o único comando de venda; `/venda` foi removido. Se a conta ainda não estiver no estoque, use `login` e `senha` juntos, omitindo `conta`. As alternativas são exclusivas. A conta fica reservada à venda e um login ocupado não pode ser vendido novamente para a mesma ferramenta.

`valor` é o preço **antes do desconto**, em reais; omitido, usa o catálogo. `desconto` é subtraído desse preço e não pode superar o valor. Por exemplo: `valor:55 desconto:5` registra R$ 50,00. A operação registra responsável, data, preço e desconto.

`data` (`DD/MM/AAAA`) e `hora` (`HH:MM`) são opcionais. O fuso é `America/Sao_Paulo`. Planos em meses mantêm o dia do mês quando possível e usam o último dia válido quando necessário.

Renove com `/renovar venda:<VEN-...> plano:<plano>`. O plano é sugerido a partir da ferramenta dessa venda. `valor` e `desconto` também são opcionais. A renovação gera uma receita e um registro próprios; preserva os dados originais da venda.

## Vencimentos e senhas

Para corrigir uma venda, use `/editar-venda venda:VEN-...` e preencha apenas os campos que deseja alterar: cliente, plano, valor, desconto, data/hora do registro, vencimento/hora do vencimento, login ou senha. O ID é mantido, a mensagem é atualizada e a edição fica na auditoria. Alterar o plano não muda o valor cobrado automaticamente; alterar plano ou data do registro recalcula o vencimento, salvo quando informado diretamente. Vendas renovadas ou trocadas aceitam correção direta do vencimento, preservando o histórico dos períodos. Credenciais só podem ser corrigidas enquanto a conta continuar vinculada à venda.

Para substituir a conta, use `/troca venda:VEN-... plano_anterior:<plano atual> plano_novo:<novo plano> login:<novo login> senha:<nova senha>`. Cliente e ferramenta vêm da venda. Motivo e observação são opcionais. O registro mostra os dois planos e somente as novas credenciais. A troca mantém o ID da venda e o valor cobrado; o prazo do novo plano começa no momento da troca, sem criar receita de renovação. A conta anterior fica aguardando troca de senha; depois de alterar sua senha externamente, use `/conta senha conta:<ACC antigo> nova_senha:<senha> confirmada:true` para devolvê-la ao estoque. As credenciais anteriores permanecem criptografadas no histórico da troca.

Após atualizar o código no Railway, execute `npm run deploy` com o `.env` do mesmo servidor para publicar `/editar-venda` e as novas opções de `/troca` no Discord.

O bot acompanha os vencimentos e mantém as contas ocupadas até que a troca externa de senha seja confirmada. `/vencidas` entrega um arquivo `vencidas.txt` com uma conta por linha no formato `login:senha`, agrupadas pelo nome da ferramenta e com uma linha em branco entre os grupos; o filtro de ferramenta continua disponível. O arquivo contém a senha histórica da venda e é entregue somente ao operador autorizado. Consulte os próximos vencimentos com `/vencimentos-proximos dias:7`.

**O bot não altera senhas nas ferramentas externas.** Primeiro faça a troca na ferramenta; depois registre a confirmação no Discord:

- `/conta senha conta:<ACC-...> nova_senha:<senha> confirmada:true` atualiza a credencial. Contas vinculadas continuam ocupadas; uma conta substituída por `/troca` volta ao estoque após essa confirmação.
- `/troca-senha vencimento:<VENC-...> nova_senha:<senha> confirmada:true` registra a troca para um vencimento, sem liberar a conta.
- `/trocar-senhas vencimentos:<VENC-...,VENC-...> nova_senha:<senha> confirmada:true` registra a troca e libera as contas elegíveis para o estoque. Também aceita um único ID.

O lote aceita até 100 IDs e utiliza a mesma nova senha em todas as contas indicadas. Conta com outra venda ativa não é liberada por um vencimento antigo. A operação retorna o resultado por conta; pendências de publicação são retomadas pelo bot. Repetir um vencimento concluído não cria outra conta disponível. Contas disponíveis publicam um anexo de credenciais no canal privado da ferramenta. Vendas exibem a senha no canal privado e nas consultas autorizadas; exportações e auditoria continuam sem senhas.

Os registros têm linhas de separação no início e no fim. Novas vendas preservam a senha original da venda, criptografada no armazenamento, mesmo após trocar a senha da conta. Em vendas anteriores sem essa cópia, a senha só é exibida se a conta ainda pertence à mesma venda; caso contrário, aparece “não disponível no histórico”.

Para aplicar o formato às mensagens já publicadas, execute `npm run refresh-records` para conferir as quantidades e `npm run refresh-records -- --apply` para atualizar. Essa operação altera somente mensagens visuais do próprio bot em canais privados, mantendo IDs, marcadores, valores históricos e anexos das contas. Registros dos canais arquivados recebem separadores e título em negrito, preservando todos os campos do formato antigo para continuar permitindo a migração. Não reescreve os eventos do canal de dados.

Senhas são preservadas exatamente, incluindo símbolos e espaços. Evite enviar esses dados em canais públicos ou mensagens de suporte.

## Consultas, receitas e auditoria

| Comando | Uso |
| --- | --- |
| `/ver tipo:<tipo> id:<ID>` | Consulta um registro; sem ID, mostra o mais recente do tipo |
| `/buscar termo:<texto> tipo:<tipo>` | Busca por cliente, login, ID ou texto; tipo é opcional |
| `/listar tipo:<tipo> quantidade:100` | Consulta até 100 registros recentes, com páginas |
| `/estoque ferramenta:<ferramenta>` | Mostra contas disponíveis, ocupadas e aguardando troca |
| `#⚙️・painel` | Canal de leitura automática com resumo financeiro, estoque, catálogo e instruções; atualiza enquanto o bot está online |
| `/troca venda:<VEN-...> plano_anterior:<plano> plano_novo:<plano> login:<login> senha:<senha>` | Substitui a conta da venda; motivo e observação são opcionais |
| `/editar-venda venda:<VEN-...>` | Corrige somente os campos opcionais informados |
| `/auditoria quantidade:100` | Mostra ações e responsáveis; exclusivo de administradores |
| `/exportar tipo:<tipo> inicio:<DD/MM/AAAA> fim:<DD/MM/AAAA>` | Envia CSV de registros sem senhas; todos os filtros são opcionais |

`/excluir tipo:<tipo> id:<ID> confirmar:true` permite que administradores excluam uma conta ou registro. A exclusão é permanente e auditada; contas ocupadas/pendentes são protegidas; ao excluir uma venda, seus vencimentos, renovações e trocas vinculados também são removidos e contabilizados na auditoria. Os tipos são `vendas`, `renovacoes`, `trocas`, `vencimentos` e `contas`. Respostas longas são paginadas para respeitar os limites do Discord. Exportações podem conter logins e contatos; mantenha os arquivos nas mãos das pessoas autorizadas.

Para avisos antecipados, use `/alertas habilitado:true antecedencia:1440` para avisar com um dia de antecedência. O intervalo aceito é de 1 a 43.200 minutos. `/alertas habilitado:false` desativa; sem opções, consulta a configuração. O bot precisa estar conectado para enviar avisos.

## Histórico antigo

Depois da configuração, execute `/migrar` como administrador para importar mensagens do formato anterior. A importação aceita apenas mensagens escritas pelo próprio bot e preserva os canais antigos. Se a aplicação do bot tiver sido trocada, mensagens de outra aplicação não são importadas automaticamente.

Registros antigos podem não conter o preço efetivamente cobrado. Nesses casos, os valores importados são estimativas pelo catálogo, identificadas no registro. Descontos ausentes e valores sobrescritos por renovações no código antigo não podem ser reconstruídos com precisão a partir dessas mensagens. Confira o resultado após a migração antes de usar os números como fechamento financeiro.

Conflitos encontrados na migração são indicados para conferência. O bot mantém a vinculação mais recente da conta e impede que um vencimento antigo libere uma conta com outra venda ativa. Erros de importação mantêm novas operações bloqueadas até concluir a migração.

O histórico legado pode conter senhas em texto aberto. A migração não apaga essas mensagens; mantenha as categorias antigas privadas.

## Backup e recuperação

Para conferir os canais antigos, execute `npm run audit-legacy`. O relatório compara a origem de cada registro, cliente, ferramenta, login, plano, datas e senha, sem imprimir credenciais. `npm run audit-legacy -- --cleanup` preserva senhas históricas verificadas que faltavam, sem trocar a senha atual das contas, e só remove os canais antigos quando a comparação passa. Antes da exclusão, envia ao canal privado de backups o estado atual e uma cópia criptografada completa das mensagens antigas, baixa os anexos e verifica seus hashes. Canais atuais são protegidos; categorias antigas só são removidas se estiverem vazias. Nenhum banco local é criado.

O arquivo `unlock-backup-*.json` usa o formato de restauração do bot. O arquivo `unlock-legacy-*.json` é um arquivo histórico separado, com mensagens e anexos originais: sua leitura exige a mesma `ENCRYPTION_KEY` e o contexto indicado no arquivo; ele não é uma entrada para `/restaurar`.

`/backup` envia um arquivo JSON criptografado ao canal privado. O bot também gera um backup diário enquanto está conectado, configurado e com a migração concluída. Baixe uma cópia e guarde-a fora do Discord, junto de uma cópia segura e separada da chave. O arquivo não inclui `ENCRYPTION_KEY`.

A cada 250 transações, o bot pode registrar um checkpoint criptografado no próprio Discord. Esse ponto permite reconstruir o estado sem reaplicar todas as transações antigas. O checkpoint preserva o histórico; não substitui uma cópia de backup fora do Discord.

Para recuperar:

1. Configure o bot para o mesmo `GUILD_ID` e com a mesma `ENCRYPTION_KEY` do backup.
2. Inicie uma instância limpa, com o canal de dados vazio e sem executar `/configurar` antes da restauração.
3. Como administrador, use `/restaurar arquivo:<backup.json> confirmada:true`.
4. Execute `/configurar` depois de restaurar para revisar cargos e canais.

A restauração rejeita dados existentes para evitar sobrescrever operações. O backup contém credenciais criptografadas e depende da chave original. Faça backups regularmente: a cópia mantida apenas no próprio Discord não protege contra perda do servidor ou da conta.

## Verificação e organização

- `npm test`: testes locais das regras de negócio, persistência, comandos, migração e recuperação; não depende de um servidor Discord real.
- `npm run check`: verificação de sintaxe.
- `npm run doctor`: consulta de acesso, cargos e permissões no Discord, sem alterações.
- `npm run deploy`: publicação dos comandos no servidor; requer token e acesso ao Discord.
- `npm start`: inicia o bot.
- `npm run keygen`: gera uma chave nova para a instalação inicial; não substitua a chave de uma instalação com histórico.

O catálogo, as regras de negócio, a persistência e a definição dos comandos ficam separados em `src/`. O Discord exige conexão ativa para gravar os eventos e entregar as mensagens. Operações registradas podem aguardar a publicação visual e ser retomadas; mantenha o processo ativo para concluir essas pendências.


## Gastos com anúncios

Após atualizar o bot, execute `/configurar` uma vez com um administrador para criar o novo canal privado `📣・gastos-anuncios`. O canal mantém uma mensagem fixa atualizada automaticamente com os lançamentos, enquanto o painel inclui os totais do dia, do mês e acumulado.

- `/anuncio registrar`: informe valor em reais, data `DD/MM/AAAA` (pode ser passada) e, opcionalmente, uma descrição.
- `/anuncio editar`: informe o ID `ADS-...` e somente os campos que deseja corrigir (valor, data e/ou descrição).
- `/anuncio listar`: consulta os lançamentos recentes.

O comando `/anuncio` é restrito à administração. Os lançamentos ficam armazenados no registro durável do bot no Discord, junto com a auditoria, e não em um arquivo local.
