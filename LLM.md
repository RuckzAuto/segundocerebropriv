# LLM.md — guia técnico pra outra IA/dev entender este projeto rápido

Este arquivo existe pra qualquer IA (Claude, Gemini, GPT, etc.) ou dev humano conseguir entender a arquitetura sem precisar ler todo o código nem reconstruir o histórico da conversa que criou isso.

## O que é

**Segundo Cérebro**: bot pessoal no Telegram que funciona como sistema de notas em pastas/subpastas dinâmicas e ilimitadas, com um "cérebro" de IA (Groq) que decide sozinho onde encaixar cada mensagem (ou cria uma pasta nova), sem exigir que o usuário navegue manualmente. Também tem um dashboard web simples pra gerenciar tudo na mão.

Não é um app genérico — é pensado pra uso pessoal de um único usuário (não tem multi-tenant). O dashboard web pode ser protegido por senha (configurada pela própria interface, ver seção "Autenticação do dashboard"), mas o bot no Telegram/WhatsApp continua acessível a qualquer um que souber o link/número — não tem autenticação de usuário nesses canais.

## Stack

- **Node.js + Express** (`type: module`, ESM, sem TypeScript, sem framework de frontend).
- **Turso** (`@libsql/client`, versão `^0.14.0` — **NÃO** volte pra `^0.6.0`, tem um bug real de incompatibilidade com o Turso remoto, ver "Bugs já resolvidos" abaixo). Fallback automático pra arquivo local `file:local.db` quando `TURSO_URL` não está setado — assim dá pra rodar e testar 100% offline sem nenhuma credencial de nuvem.
- **Groq** (`https://api.groq.com/openai/v1/...`, API compatível com formato OpenAI) pra chat (function-calling) e transcrição de áudio (Whisper).
- **Telegram Bot API** via webhook (não polling) — o Render (plano free) "dorme" quando não tem tráfego, e o próprio POST do Telegram no webhook é o que acorda o serviço.
- **WhatsApp via Baileys** (`baileys`, conexão WebSocket direta com o WhatsApp Web, sem API oficial paga) — diferente do Telegram, precisa manter uma conexão viva o tempo todo (não é webhook), e a sessão de login (equivalente a estar "logado" no WhatsApp Web) fica persistida no Turso pra sobreviver ao Render dormir/acordar. Ver seção própria abaixo.
- Deploy: Docker no Render (`Dockerfile` + `render.yaml`).

## Estrutura de arquivos

```
segundo-cerebro/
├── server.mjs          # Express: rotas de API, dashboard HTML inline (com painel WhatsApp e senha embutidos), webhook do Telegram, boot
├── lib/
│   ├── db.mjs           # cliente Turso/libSQL + initDb() (cria as 5 tabelas se não existirem)
│   ├── brain.mjs        # o "cérebro": processMessage(userText, chatId) — chama a Groq com function-calling
│   ├── telegram.mjs     # telegramRequest/sendMessage/sendChatAction/handleUpdate + transcrição de áudio
│   ├── whatsapp.mjs     # connectWhatsapp()/getWhatsappStatus() — conexão Baileys, filtro por número, plugado no brain.mjs
│   └── whatsapp-auth.mjs # useTursoAuthState() — adapter que salva a sessão do Baileys no Turso em vez de arquivo local
├── Dockerfile
├── render.yaml
├── .env.example
├── .dockerignore
└── .gitignore
```

## Modelo de dados (Turso/SQLite)

```sql
folders (id TEXT PK, parent_id TEXT NULL, name TEXT, path TEXT, created_at)
  -- path é materializado (ex: "Financeiro/Cofre"), calculado na hora de criar, concatenando com o path do pai.
  -- parent_id NULL = pasta raiz.

notes (id TEXT PK, folder_id TEXT, content TEXT, created_at)
  -- content é texto livre, sem estrutura. Uma nota pertence a exatamente uma pasta.

agent_state (id TEXT PK, data TEXT, updated_at)
  -- linha única com id='main_brain_state', data é um JSON { chatHistories: { [chatId]: [{role, content}, ...] } }
  -- guarda as últimas ~4 mensagens de histórico por chat, pra dar contexto sem gastar token à toa.

whatsapp_auth (file_key TEXT PK, data TEXT, updated_at)
  -- uma linha por "arquivo" de sessão do Baileys (creds, cada pre-key, cada session key, etc.)
  -- espelha exatamente o que o useMultiFileAuthState do Baileys salvaria em disco, só que em linha de banco.

app_settings (key TEXT PK, value TEXT, updated_at)
  -- configuracoes gerais do app, key-value generico, tudo configurado pela propria interface (nunca env var):
  --   'dashboard_password_hash'   -> formato "salt:hash" em hex (crypto.scryptSync, NUNCA senha em texto puro)
  --   'whatsapp_allowed_number'   -> so digitos + codigo do pais, ex: "5511999999999"
```

## O "cérebro" (`lib/brain.mjs`) — como funciona o roteamento

Fluxo em 2 etapas, pensado pra gastar o mínimo de token possível (não manda o conteúdo de todas as notas em toda mensagem, só quando realmente precisa):

1. **Roteamento**: monta um system prompt com a LISTA de caminhos de pastas existentes (só os nomes/paths, sem conteúdo) e manda pra Groq com 8 tools via function-calling:
   - `salvar_nota(pasta_path, conteudo)` — cria a pasta automaticamente se não existir (via `ensureFolder`, que cria cada nível do caminho que faltar).
   - `criar_pasta(pasta_pai_path, nome)`
   - `consultar_pasta(pasta_path, pergunta)` — dispara uma SEGUNDA chamada à Groq, agora só com o conteúdo daquela pasta específica + a pergunta, pra gerar a resposta final.
   - `editar_nota(pasta_path, busca, novo_conteudo)` — acha a nota por busca parcial (case-insensitive) no conteúdo; se achar mais de uma, edita a mais recente.
   - `remover_nota(pasta_path, busca)` — mesma lógica de busca da edição, mas remove.
   - `remover_pasta(pasta_path)` — só remove se não tiver subpasta.
   - `visao_geral()` — sem parâmetros, retorna lista de pastas + contagem de notas (sem conteúdo), pra perguntas genéricas tipo "o que você tem anotado?".
   - `responder_direto(texto)` — papo genérico sem mexer em pasta/nota.
2. **Execução**: o código roda a tool escolhida e monta a resposta final.

**Importante — resolução de pasta é robusta, não texto livre solto**: os parâmetros `pasta_path` de `consultar_pasta`/`editar_nota`/`remover_nota`/`remover_pasta` usam `enum` no JSON schema da function-call, com a lista REAL de `folderPaths` existentes — isso força a IA a escolher um caminho que existe de verdade, em vez de aproximar/inventar (ex: "Link" vs "link" vs "Links"). Além disso, toda busca de pasta por path tenta primeiro exata (`WHERE path = ?`) e cai pra `LOWER(path) = LOWER(?)` como rede de segurança. Isso foi um bug real em produção (ver "Bugs já resolvidos").

Se a segunda chamada da `consultar_pasta` falhar (erro de rede, rate limit da Groq, etc.), o erro é logado (`console.error` com status + corpo) E o usuário recebe o conteúdo cru das notas em vez de só uma mensagem de erro — informação nunca se perde silenciosamente.

## Telegram (`lib/telegram.mjs`)

- `handleUpdate(update, token)` é o ponto de entrada, chamado pelo webhook.
- Detecta `message.voice || message.audio` ANTES de checar texto — se tiver áudio, baixa o arquivo do Telegram (`getFile` + download via `https` nativo do Node, não `fetch`) e manda pra Groq Whisper (`whisper-large-v3-turbo`, `language: pt`) via `FormData`. O texto transcrito é tratado EXATAMENTE como se fosse digitado (passa por `/start`, `/reset`, `processMessage` normalmente).
- Toda resposta que veio de um áudio é prefixada com `🎙️ _Ouvi:_ "<transcrição>"` antes do conteúdo real, pra o usuário conferir se a transcrição saiu certa (ver `reply()` dentro de `handleUpdate`).
- `/start` confirma que o bot está ativo. `/reset` apaga o histórico daquele `chat_id` em `agent_state`.
- O secret do webhook é o próprio `TELEGRAM_BOT_TOKEN` na URL (`/webhook/:secret`, 404 se não bater).

## WhatsApp (`lib/whatsapp.mjs` + `lib/whatsapp-auth.mjs`)

Tanto a sessão de login quanto o número autorizado são configurados **direto pela interface, não por env var** (mesma decisão de design da senha do dashboard — ver seção abaixo). Isso significa que a conexão Baileys não depende de nenhuma configuração prévia: sobe o servidor e ela já tenta conectar sozinha.

- `connectWhatsapp()` é chamado incondicionalmente no boot do servidor (`server.mjs`) — SEM checar nenhuma env var. Ele carrega o número autorizado atual do banco (`getAllowedNumber()`, pode ser `null` se ainda não foi configurado) pra uma variável em memória (`allowedNumber`) usada no filtro de mensagens.
- Usa `useTursoAuthState()` (em vez do `useMultiFileAuthState` padrão do Baileys) pra ler/gravar a sessão de login no Turso — assim a sessão sobrevive ao Render dormir/acordar sem precisar escanear QR de novo toda vez. Cada "arquivo" que o Baileys normalmente salvaria em disco vira uma linha na tabela `whatsapp_auth`, serializada com `BufferJSON` (do próprio pacote `baileys`) pra preservar `Buffer`/`Uint8Array` corretamente.
- O número autorizado fica na tabela `app_settings` (chave `whatsapp_allowed_number`), lido/escrito via `getAllowedNumber()`/`setAllowedNumber(number)` exportados de `lib/whatsapp.mjs`. `setAllowedNumber` atualiza o banco E a variável em memória junto (pra valer imediatamente na próxima mensagem, sem precisar reiniciar a conexão — pareamento do WhatsApp e "quem pode falar com o bot" são coisas independentes).
- Quando precisa de um novo login, gera um QR Code (PNG em base64, biblioteca `qrcode`) e guarda em memória, exposto via `GET /api/whatsapp/status` (JSON `{status, qr, allowedNumber}`). O dashboard principal (`/`) tem um painel "WhatsApp" na barra lateral que faz polling nessa rota a cada 5s, mostra o QR Code/status, e tem um formulário pra definir/trocar o número (pré-preenchido com o valor atual, `POST /api/whatsapp/set-number`) — tudo direto ali, sem página separada nem env var.
- No evento `messages.upsert`, só processa a mensagem se `allowedNumber` estiver definido E o número remetente bater exatamente com ele — qualquer outro número, grupo (`@g.us`), ou nenhum número configurado ainda, é ignorado silenciosamente.
- **Cuidado com JIDs `@lid`.** O WhatsApp vem migrando contatos pro sistema de privacidade "Linked ID", onde o `remoteJid` chega como `<id-opaco>@lid` em vez de `<numero>@s.whatsapp.net` — um número de conta interno do WhatsApp, SEM relação nenhuma com o número de telefone real (bug real em produção, ver "Bugs já resolvidos"). A função `resolveRemoteNumber(sock, jid)` detecta esse caso (`jid.endsWith('@lid')`) e resolve o número de telefone de verdade via `sock.signalRepository.lidMapping.getPNForLID(jid)` (API interna do Baileys, mesma usada em `lib/Socket/chats.js` e `messages-recv.js` do próprio pacote) antes de comparar com `allowedNumber`. Isso é assíncrono, então o loop de `messages.upsert` precisa dar `await` nessa resolução pra cada mensagem.
- Mensagem válida vai direto pro mesmo `processMessage()` do `brain.mjs` que o Telegram usa (mesmas pastas/notas), com `chatId` prefixado `whatsapp_<numero>` pra manter o histórico de conversa separado do Telegram.
- **Áudio/voz**: se a mensagem não tem texto mas tem `msg.message.audioMessage`, baixa e transcreve via `transcribeWhatsappAudio()` — usa `downloadMediaMessage` do próprio Baileys (decripta e baixa o áudio direto pra um Buffer em memória, sem precisar de download HTTP manual como o Telegram precisa) e manda pro Groq Whisper (`whisper-large-v3-turbo`, `language: pt`), mesmo padrão do `lib/telegram.mjs`. Resposta prefixada com `🎙️ _Ouvi:_ "<transcrição>"`, igual o Telegram. Falha na transcrição ou áudio vazio avisa o usuário sem quebrar (mesmas mensagens de erro do Telegram).
- Se a conexão cair, reconecta sozinho automaticamente, EXCETO se foi um logout explícito (`DisconnectReason.loggedOut`) — nesse caso precisa escanear um QR Code novo.

## Autenticação do dashboard (`server.mjs`)

A senha do dashboard **não é env var nem arquivo de config** — fica guardada com hash (`crypto.scryptSync`, nunca texto puro) na tabela `app_settings` (chave `dashboard_password_hash`), configurada pela própria interface web. Isso foi decisão explícita do usuário: como o repositório pode ir pro GitHub, ele não queria nenhuma senha em variável de ambiente/arquivo versionado, e queria configurar tudo pela UI depois de já estar rodando.

- Middleware global (função anônima em `app.use`, async porque consulta o banco) protege TODAS as rotas exceto `/health`, `/webhook/:secret` e `/api/auth/status`. Os dois primeiros precisam ficar abertos (health check é usado por monitoramento externo; o Telegram não manda header de autenticação ao chamar o webhook — a proteção dele já é o secret na própria URL). `/api/auth/status` fica público de propósito, pra o frontend saber se deve mostrar o aviso de "configurar senha" ANTES de qualquer autenticação acontecer.
- Se `app_settings.dashboard_password_hash` não existir ainda, o middleware deixa passar tudo (dashboard 100% aberto) — é o estado inicial logo após o primeiro deploy.
- `GET /api/auth/status` → `{ passwordSet: boolean }` (sempre público).
- `POST /api/auth/set-password` → `{ password }`, salva o hash. Como essa rota passa pelo middleware normal, só é acessível sem autenticação enquanto NENHUMA senha existe ainda (primeira configuração); depois de definida, trocar a senha exige já estar autenticado com a senha atual (Basic Auth do navegador) — não tem bypass.
- Autenticação em si continua sendo **HTTP Basic Auth** (usuário fixo `admin`, senha = a que foi configurada) — o navegador mostra o popup nativo dele sozinho quando uma rota protegida retorna 401 com `WWW-Authenticate`.
- A conexão do WhatsApp via Baileys é um WebSocket de saída, não passa por rota HTTP nenhuma, então não é afetada por essa auth de jeito nenhum.
- No dashboard (`/`), a seção "🔒 Segurança"/"⚠️ Configure uma senha" na barra lateral chama `/api/auth/status` no carregamento da página pra decidir se mostra o formulário de definir senha (nenhuma senha ainda) ou só um botão "Trocar senha" que revela o mesmo formulário (senha já definida).

## Rotas HTTP (`server.mjs`)

```
GET  /health                        — healthcheck
GET  /api/folders                   — lista todas as pastas
POST /api/folders                   — cria pasta {name, parent_id?}
GET  /api/folders/:id/notes         — lista notas de uma pasta
POST /api/folders/:id/notes         — cria nota {content}
PUT  /api/notes/:id                 — edita nota {content}
DELETE /api/notes/:id               — remove uma nota
DELETE /api/folders/:id             — remove pasta (400 se tiver subpasta)
GET  /                              — dashboard HTML inline (vanilla JS, sem build step; inclui painel WhatsApp e senha)
POST /api/chat                      — {message, chat_id} → processMessage direto, sem Telegram (útil pra testar)
POST /webhook/:secret               — webhook do Telegram (secret = TELEGRAM_BOT_TOKEN)
GET  /api/whatsapp/status           — {status, qr, allowedNumber} do WhatsApp, consumido pelo painel do dashboard
POST /api/whatsapp/set-number       — {number} — define/troca o número autorizado do WhatsApp (banco, não env var)
GET  /api/auth/status               — {passwordSet: boolean} — sempre público, mesmo com senha configurada
POST /api/auth/set-password         — {password} — define/troca a senha do dashboard (hash no banco)
```

Todas as rotas acima (exceto `/health`, `/webhook/:secret` e `/api/auth/status`) exigem HTTP Basic Auth quando uma senha já foi configurada — ver seção "Autenticação do dashboard".

## Variáveis de ambiente (`.env.example`)

```
TELEGRAM_BOT_TOKEN=   # token do BotFather
GROQ_API_KEY=         # console.groq.com
GROQ_MODEL=           # default no código: openai/gpt-oss-20b (whisper-large-v3-turbo é fixo pra áudio, não vem de env)
TURSO_URL=            # se vazio, usa file:local.db (sem nenhuma credencial)
TURSO_TOKEN=
RENDER_EXTERNAL_URL=  # só necessário em produção, pra auto-registrar o webhook no boot
```

Nenhuma credencial real está hardcoded em nenhum arquivo. Nunca hardcode. A senha do dashboard e o número autorizado do WhatsApp NÃO são env vars — ficam no banco (`app_settings`), configurados pela própria UI (ver seções "Autenticação do dashboard" e "WhatsApp").

## Bugs já resolvidos (não reintroduzir)

1. **`@libsql/client` tem que ser `^0.14.0`, não `^0.6.0`.** A 0.6.x dá erro `Unexpected status code while fetching migration jobs: 400` ao conectar num Turso remoto de verdade — só não aparece testando com `file:local.db` local porque é um caminho de código completamente diferente (sem HTTP nenhum). Sempre testar contra Turso real antes de considerar uma mudança de dependência "pronta", ou pelo menos saber que o fallback local não cobre esse caminho.
2. **Resolução de pasta por texto livre é frágil.** Não deixe nenhuma tool nova aceitar `pasta_path` como string livre sem `enum` dos paths reais — foi a causa de um bug real em produção onde o bot dizia "não encontrei" pra notas que existiam.
3. **Modelo da Groq pode ser descontinuado sem aviso.** Já aconteceu 2x nesta sessão (`llama-3.3-70b-versatile` e `llama3-70b-8192`, ambos não existem mais). Antes de fixar um modelo novo, testar com `GET https://api.groq.com/openai/v1/models` (usando uma chave real) pra confirmar que existe. Hoje validado: `openai/gpt-oss-20b` (chat) e `whisper-large-v3-turbo` (áudio).
4. **NUNCA use `\d`, `\w` ou `\s` em atributos HTML (ex: `pattern="..."`) dentro do HTML inline de `server.mjs`.** Todo esse HTML é uma template literal JS comum (não-tagged), e `\d` não é um escape reconhecido em string/template literal — o JS remove a barra invertida antes de gerar a string, então `pattern="\d{8,15}"` vira `pattern="d{8,15}"` no HTML de verdade enviado ao navegador (a letra "d" literal, nunca um dígito), fazendo a validação falhar pra qualquer valor, sempre. Aconteceu de verdade no campo de número do WhatsApp (Etapa 14) — corrigido trocando por `pattern="[0-9]{8,15}"` (colchetes, sem barra invertida). Use sempre a forma com colchetes (`[0-9]`, `[a-zA-Z0-9_]`, etc.) em qualquer regex dentro desse HTML inline.

## Como rodar localmente

```bash
npm install
npm start
```

Sobe em `http://localhost:3000`, usa `local.db` (SQLite em arquivo), sem precisar de nenhuma env var. Pra testar o cérebro sem Telegram: `POST /api/chat` com `{"message": "...", "chat_id": "teste"}`.

## Como testar sem gastar API de verdade

Todo o histórico de desenvolvimento deste projeto foi testado via mocks de `global.fetch` (interceptando `api.groq.com` e `api.telegram.org`) e, pro download de áudio especificamente, mockando `https.get` do Node nativo (porque `downloadFile` em `lib/telegram.mjs` não usa `fetch`). Ver o padrão de teste usado nos scripts temporários da sessão de desenvolvimento (não versionados) se precisar recriar.

## Referência de arquitetura

Esse projeto foi inspirado num projeto irmão do mesmo usuário, chamado `agente` (fora deste repositório — Telegram + Groq + Turso + Render, só que com categorias fixas — "Cofrinho" e "Calendário" — em vez de pastas dinâmicas). Vale olhar lá se precisar resolver algo relacionado a Telegram/Turso/Render que não seja específico da lógica de pastas.

## Deploy (Render)

Já configurado via `render.yaml` (web service, plano free, `env: docker`). Checklist completo de deploy está no `README.md` deste projeto.
