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
   - `WHATSAPP_ALLOWED_NUMBER` (opcional — só preencha se quiser usar o WhatsApp também, ver seção abaixo).
   - `DASHBOARD_PASSWORD` (fortemente recomendado — sem essa variável, o dashboard e a API ficam abertos pra qualquer pessoa que souber a URL; ver seção abaixo).

## Como usar pelo Telegram

Depois de tudo configurado e rodando:

- **Para anotar algo:** Envie uma mensagem normal com o conteúdo. A IA entenderá o assunto e criará as pastas e subpastas necessárias de forma dinâmica para armazenar sua nota.
- **Para consultar algo:** Faça uma pergunta ao bot em forma de texto buscando pela informação (ex: "O que eu anotei sobre reuniões ontem?").
- **Para limpar o contexto:** Digite `/reset` para apagar o histórico da conversa com a IA.

## Como usar pelo WhatsApp (opcional)

O bot também pode responder pelo WhatsApp, usando a mesma "memória" (pastas/notas) do Telegram, via a biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys) — uma conexão não-oficial ao WhatsApp Web (sem custo, mas fora dos termos de uso oficiais do WhatsApp; use com moderação, sem spam, idealmente num número que não seja o seu principal).

1. Defina `WHATSAPP_ALLOWED_NUMBER` com o número que vai poder falar com o bot (só dígitos + código do país, ex: `5511999999999`, sem `+`).
2. Suba o servidor (local ou já deployado no Render).
3. Acesse `/whatsapp/qr` no navegador — vai aparecer um QR Code.
4. No WhatsApp do celular do número configurado: Configurações → Aparelhos conectados → Conectar um aparelho, e escaneie o QR Code.
5. Pronto — a sessão fica salva no Turso, então não precisa escanear de novo depois (mesmo se o Render dormir e acordar). Só é preciso escanear de novo se você desconectar manualmente pelo celular.

## Protegendo o dashboard com senha

Por padrão, o dashboard (`/`), a API (`/api/*`) e a página do QR Code (`/whatsapp/qr`) ficam **abertos pra qualquer pessoa** que souber a URL — não tem cadastro de usuário nenhum. Pra proteger:

1. Defina `DASHBOARD_PASSWORD` no `.env` (local) ou nas env vars do Render (produção) com a senha que quiser.
2. Ao acessar o dashboard pelo navegador, vai aparecer um popup padrão pedindo usuário e senha — o usuário pode ser qualquer coisa (ex: `admin`), a senha é o valor que você definiu.
3. **O webhook do Telegram (`/webhook/:secret`) e a conexão do WhatsApp continuam funcionando normalmente sem essa senha** — a proteção é só pra quem acessa pelo navegador. Se `DASHBOARD_PASSWORD` não estiver definida, o dashboard continua aberto (útil pra testar localmente sem configurar nada).
