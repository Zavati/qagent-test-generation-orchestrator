# UI-TD-2 — lotes duráveis de Test Design UI

Este corte acrescenta compilação determinística e publicação de Test Designs UI
ao Orchestrator existente. Não executa navegadores, não declara PASS, não chama
provedores de IA e não depende de Catalog API nem de UI Catalog projetado.
O compilador no `qagent-ui` e o Registry validam seus contratos próprios; o
Gateway autentica acesso às fontes e faz os callbacks internos.

## Implantação

Aplicar `migrations/0003_ui_test_design_jobs.sql` no D1 existente
`TEST_GENERATION_DB`, depois publicar este Worker com os callbacks compatíveis
do Gateway. A migration é aditiva e não modifica jobs API nem o ciclo autônomo.

```sh
npm run db:migrate:local
npm run db:migrate:remote
npm run check
npm test
npm run deploy
```

Os comandos de migration remota e deploy são instruções de aplicação; não foram
executados durante a validação local deste pacote. Não há fila, bucket, segredo
ou deploy de serviço novo: UI reutiliza `qagent-test-design-generation`, o cron
existente, `TEST_DESIGN_GENERATION_SERVICE` e
`TEST_GENERATION_INTERNAL_HMAC_SECRET`.

`GET /v1/test-design-generation/ui-readiness` recebe os três campos de escopo na
query e HMAC de transporte existente. Retorna `schemaReady`, `queueReady`,
`gatewayReady` e migration esperada. Isso verifica configuração e schema local;
não chama os serviços de origem nem comprova implantação remota de seus contratos.
Aplicar a migration não inicia nenhum lote.

## Contrato HTTP

Todas as rotas exigem assinatura interna existente. O Gateway verifica a
autoridade do usuário no projeto/ambiente antes de encaminhar. Organização e
projeto devem coincidir com o HMAC; ambiente pertence ao corpo/query assinados e
é usado em todos os acessos. Uma assinatura válida não permite trocar o escopo
de um job já persistido.

| Método e rota | Entrada / saída |
|---|---|
| `POST /v1/test-design-generation/projects/:projectId/ui-jobs` | Corpo abaixo; 202 na admissão, 200 na repetição idempotente |
| `GET /v1/test-design-generation/projects/:projectId/ui-jobs` | Query `organizationId`, `environmentId`, `projectId` opcional igual à rota; `limit` 1–50 e `cursor` opcionais |
| `GET /v1/test-design-generation/ui-jobs/:jobId` | Query obrigatória `organizationId`, `projectId`, `environmentId` |
| `GET /v1/test-design-generation/ui-jobs/:jobId/items` | Mesmo escopo obrigatório, paginação `limit` 1–50 e `cursor` |
| `POST /v1/test-design-generation/ui-jobs/:jobId/cancel` | Três campos de escopo no corpo ou query; conflito entre ambos é recusado |
| `GET /v1/test-design-generation/ui-readiness` | Três campos de escopo obrigatórios; não inicia trabalho |

```json
{
  "organizationId": "org_example",
  "projectId": "prj_example",
  "environmentId": "env_example",
  "operationId": "operation_chosen_by_client",
  "bundleVersionIds": ["urbv_exact_version"],
  "compilerVersion": "qagent_ui_test_design_compiler_v1",
  "profile": {},
  "createdBy": "usr_example",
  "createdByAccountId": "acct_example"
}
```

`operationId` é obrigatório e deve ser reutilizado ao repetir o mesmo pedido
após timeout. Um pedido deliberadamente novo usa outra operação. O corpo aceita
até 50 referências; fontes repetidas são removidas e a lista é ordenada antes de
calcular `requestHash`. Alterar perfil/fontes/compiler sob a mesma operação
retorna `UI_JOB_OPERATION_CONFLICT`. Metadata de ator não muda o plano semântico.

`profile` omitido ou `{}` é normalizado para o perfil completo e fixado no job:

```json
{
  "contractVersion": "qagent.ui-test-design-profile.v1",
  "revision": 1,
  "comparisonPolicyVersion": "qagent_ui_observed_comparison_v1",
  "layoutTolerancePx": 2,
  "maxChecks": 2000,
  "maxNodes": 25000,
  "maxArtifactBytes": 33554432
}
```

Um perfil personalizado deve conter todos esses campos, dentro dos ranges do
compilador. Campos desconhecidos são recusados, não descartados. Não há consulta
de `latest` durante retry. `bundleVersionId` é a referência imutável admitida;
o compilador e a publicação verificam integridade e acesso vigente à fonte.

O envelope HTTP é `{ "status": "ok", "data": ... }`. O job inclui `jobId`,
escopo, `operationId`, `requestHash`, `compilerVersion`, `profile`, fontes exatas,
`status`, `itemCount`, `counts`, datas e `executionPerformed:false`. Na criação,
também inclui `reused` e `dispatch:{queued,deferred}`. Uma publicação temporária
de fila malsucedida deixa o job admitido e recuperável pelo cron.

Lista de jobs retorna `data.jobs` e `data.nextCursor`. Lista de itens retorna
`data.job`, `data.items` e `data.nextCursor`. Cada item inclui fonte, fases,
contagens e histórico limitado de tentativas, motivo de erro, hashes, resumo de
compilação, prontidão dos dois modos e versão persistida. Os corpos compilados e
tokens de lease não são retornados pela listagem. O resultado imutável completo
é lido pelo contrato UI do Registry.

## Etapas duráveis e recuperação

1. A admissão insere job e snapshot completo de itens numa única transação D1.
2. Uma mensagem contendo apenas IDs/escopo/contrato faz o claim de um item.
3. `compile` chama o Gateway com a fonte/perfil/compiler fixados. A compilação
   devolve contrato, hashes, proveniência, plano e limitações.
4. O Orchestrator verifica escopo, fonte, hash canônico do plano, modos
   `UI_REPLAY`/`UI_LIVE`, `executionPerformed:false` e o limite de 768 KiB do
   candidato. Salva bytes canônicos e hash do envelope em D1 **antes** de publicar.
5. Outra etapa/mensagem chama `publish` com exatamente esse candidato e a
   operação estável `uitdg_` + `jobItemId`. O Registry deduplica operação/conteúdo.
6. ACK perdido é reconciliado repetindo a publicação da mesma operação. Nenhuma
   recompilação é necessária depois do checkpoint durável. A resposta precisa
   manter `contentHash === specificationHash` e `domain:'UI'`.

Callbacks assinados no Gateway:

- `POST /internal/v1/ui-test-design/compile`: escopo, `jobId`, `jobItemId`,
  `generationRequestId`, `bundleVersionId`, `compilerVersion`, perfil completo.
- `POST /internal/v1/ui-test-design/publish`: escopo, `jobId`, `jobItemId`,
  `generationRequestId` e `compilation` persistida.

Cada item limita tentativas por fase (`UI_MAX_ITEM_ATTEMPTS`, padrão 5, 1–10).
Backoff é 30/60/120/300 segundos. Leases usam revisão crescente, token e expiração
em todo commit. `UI_ITEM_LEASE_SECONDS` padrão 240 (180–600) comporta callback de
compilação com timeout de 150 segundos e publicação de 60 segundos. A perda
repetida de workers esgota o contador persistido; redelivery não o reinicia.

`UI_MAX_CONCURRENCY` limita claims UI globalmente e por job, padrão 1 (1–3),
dentro do consumer existente com concorrência 3. API e UI conservam contratos
distintos e o tráfego UI não entra no callback de geração por IA. Essa separação
não promete uma prioridade rígida de mensagens na fila compartilhada.

O cron republica itens já admitidos com fila perdida, retry vencido ou lease
expirado e reconcilia agregados após perda de ACK local. Não cria jobs nem busca
novas observações. Conteúdos de página, respostas de API e mensagens privadas de
erro não são colocados em mensagens de fila ou logs operacionais.

## Estados e cancelamento

Jobs: `QUEUED`, `RUNNING`, `COMPLETED`, `COMPLETED_WITH_FAILURES`, `FAILED`,
`CANCELLING`, `CANCELLED`. Itens: `PENDING`, `COMPILING`, `COMPILED`, `PUBLISHING`,
`RETRY_WAIT`, `SUCCEEDED`, `NO_DESIGN`, `FAILED`, `CANCELLED`.

`SUCCEEDED` significa versão publicada. `NO_DESIGN` é terminal com razão explícita;
não é teste executado, nem passa por Registry. Um job com somente `NO_DESIGN`
pode estar operacionalmente `COMPLETED`, com `counts.succeeded:0` e os motivos
consultáveis. `COMPLETED` nunca significa PASS de testes.

Cancelar interrompe claims novos e invalida compilações em andamento. Candidatos
já salvos permanecem auditáveis e não iniciam uma nova publicação. Uma operação
de publicação já admitida pode ter sido efetivada no Registry; ela termina ou
é reconciliada pelo mesmo identificador, com tentativas limitadas. O job fica
`CANCELLING` durante essa resolução e depois `CANCELLED`, preservando versões
publicadas. Cancelamento não apaga nem reverte versões imutáveis.

Se a publicação continuar sem confirmação até esgotar tentativas, o item mantém
`publicationUncertain:true` e a operação/hash permitem investigação. O serviço
não afirma que nada foi publicado. Revogação/falha permanente da fonte bloqueia
novas tentativas, sem desfazer itens irmãos bem-sucedidos. Não há retomada implícita
de job cancelado; um novo pedido exige nova operação.

## Validação local

```sh
npm run check
npm run test:ui-td2
npm test
```

Os testes UI usam SQLite real em memória, transporte/fila controlados e o código
de rotas, HMAC, repositório e processamento. Cobrem migration/readiness, admissão
atômica e idempotente, escopo, paginação, claim/lease/fencing, backoff/esgotamento,
recuperação de fila, candidato durável, ACK perdido, corrupção/contrato inválido,
`NO_DESIGN`, falhas parciais, cancelamento e callbacks sem IA. Eles não representam
deploy Cloudflare, piloto real, execução de browser ou qualificação dos dados de
uma observação de usuário.
