# Segundo Cérebro

Um assistente pessoal via Telegram funcionando como um "Segundo Cérebro", que permite salvar anotações e organizá-las automaticamente em pastas e subpastas dinâmicas. O bot interpreta a intenção da mensagem e categoriza as informações (Powered by Groq e Turso).

## Como rodar localmente

O projeto pode rodar localmente (inclusive utilizando o SQLite de forma local, sem necessitar credenciais de banco na inicialização).

1. Instale as dependências:
   ```bash
   npm install
   ```
2. Inicie o servidor:
   ```bash
   npm start
   ```

*(Nota: Para integrar com a IA e Telegram, configure um arquivo `.env` localmente com suas chaves caso queira testar a comunicação completa).*

## Checklist para Deploy (Render)

Siga estes passos para fazer o deploy gratuito usando o [Render](https://render.com):

1. **Bot do Telegram:** Crie o seu bot pelo [@BotFather](https://t.me/botfather) no Telegram e pegue o seu **Token**.
2. **Chave da Groq:** Crie uma conta gratuita no console da [Groq](https://console.groq.com/) e gere uma **API Key**.
3. **Banco de Dados Turso:** Crie sua conta gratuita no [Turso](https://turso.tech/), crie um banco de dados e obtenha a **URL do banco** e seu respectivo **Token**.
4. **Deploy no Render:** Conecte o repositório no Render, crie um novo serviço web usando o arquivo `render.yaml` fornecido.
5. **Configuração de Env Vars:** No dashboard do Render, vá na configuração do serviço e preencha os valores para as variáveis definidas como não sincronizadas:
   - `TELEGRAM_BOT_TOKEN`
   - `GROQ_API_KEY`
   - `TURSO_URL`
   - `TURSO_TOKEN`
   - Para a variável `RENDER_EXTERNAL_URL`, defina-a com a URL pública que o Render vai gerar para a sua aplicação (ex: `https://seu-projeto.onrender.com`).
   - A senha do dashboard e o número do WhatsApp NÃO são env vars — configure os dois direto pela interface depois que o app estiver no ar (ver seções abaixo).

## Como usar pelo Telegram

Depois de tudo configurado e rodando:

- **Para anotar algo:** Envie uma mensagem normal com o conteúdo. A IA entenderá o assunto e criará as pastas e subpastas necessárias de forma dinâmica para armazenar sua nota.
- **Para consultar algo:** Faça uma pergunta ao bot em forma de texto buscando pela informação (ex: "O que eu anotei sobre reuniões ontem?").
- **Para limpar o contexto:** Digite `/reset` para apagar o histórico da conversa com a IA.

## Como usar pelo WhatsApp (opcional)

O bot também pode responder pelo WhatsApp, usando a mesma "memória" (pastas/notas) do Telegram, via a biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys) — uma conexão não-oficial ao WhatsApp Web (sem custo, mas fora dos termos de uso oficiais do WhatsApp; use com moderação, sem spam, idealmente num número que não seja o seu principal).

Tudo configurado direto pela interface, sem env var nenhuma:

1. Suba o servidor (local ou já deployado no Render) e abra o dashboard normal (`/`) — tem uma seção "WhatsApp" na barra lateral esquerda.
2. Assim que o servidor sobe, ele já tenta conectar sozinho e um QR Code aparece nessa seção (atualiza sozinha a cada 5 segundos). No WhatsApp do celular: Configurações → Aparelhos conectados → Conectar um aparelho, e escaneia.
3. Logo abaixo do QR Code tem um campo pra digitar o número que vai poder falar com o bot (só dígitos + código do país, ex: `5511999999999`, sem `+`) — preenche e clica em "Salvar número". Enquanto esse número não estiver configurado, o bot fica conectado mas não responde ninguém.
4. Pronto — tanto a sessão de login quanto o número configurado ficam salvos no Turso, então sobrevivem ao Render dormir/acordar sem precisar mexer em nada de novo. Só é preciso escanear um QR Code novo se você desconectar manualmente pelo celular, e só é preciso trocar o número se você quiser mudar quem fala com o bot (é só preencher o campo de novo, a qualquer momento).

O bot também entende **áudio/mensagem de voz** no WhatsApp, igual no Telegram — manda um áudio que ele transcreve e responde normal.

## Protegendo o dashboard com senha

Por padrão, o dashboard (`/`) e a API (`/api/*`) ficam **abertos pra qualquer pessoa** que souber a URL — não tem cadastro de usuário nenhum. A senha **não é configurada por env var nem fica no código/GitHub** — é definida direto pela interface, e fica guardada (com hash, nunca em texto puro) no seu banco Turso:

1. Assim que você abrir o dashboard pela primeira vez (sem senha nenhuma configurada ainda), vai aparecer um aviso "⚠️ Configure uma senha" com um campo pra digitar. Preenche e clica em "Salvar senha".
2. A partir daí, toda vez que alguém (inclusive você) acessar o dashboard, o navegador vai pedir usuário e senha (popup padrão do navegador) — o usuário pode ser qualquer coisa (ex: `admin`), a senha é a que você acabou de definir.
3. **O webhook do Telegram (`/webhook/:secret`) e a conexão do WhatsApp continuam funcionando normalmente sem essa senha** — a proteção é só pra quem acessa pelo navegador.
4. Pra trocar a senha depois, entra no dashboard normalmente (com a senha atual) e clica em "Trocar senha" na seção "🔒 Segurança" na barra lateral.
