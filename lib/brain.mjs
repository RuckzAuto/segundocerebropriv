import { db } from './db.mjs';
import crypto from 'crypto';

function formatBrazilDateTime(sqliteTimestamp) {
  return new Date(sqliteTimestamp.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).replace(', ', ' ');
}

export async function processMessage(userText, chatId) {
  // 1. busca a arvore de pastas no banco
  const rs = await db.execute('SELECT id, parent_id, name, path FROM folders ORDER BY path ASC');
  const folders = rs.rows;
  const folderPaths = folders.map(f => f.path);
  
  // 2. monta um system prompt pro Groq
  const systemPrompt = `Você é o Segundo Cérebro inteligente do usuário.
Você gerencia pastas e notas.

ESTRUTURA DE PASTAS ATUAL (Lista de caminhos):
${folderPaths.length > 0 ? folderPaths.map(p => `- ${p}`).join('\n') : "Nenhuma pasta criada ainda."}

INSTRUÇÕES:
- Quando precisar salvar algo, use a ferramenta "salvar_nota".
- Quando precisar editar ou atualizar uma anotação, use "editar_nota".
- Quando precisar excluir ou remover uma nota específica, use "remover_nota".
- Quando precisar criar uma pasta vazia, use "criar_pasta".
- Quando precisar remover uma pasta inteira, use "remover_pasta".
- Quando precisar buscar ou ler o conteúdo de uma pasta para responder ao usuário, use "consultar_pasta".
- SEMPRE use os caminhos EXATOS da lista de pastas fornecida, nunca invente ou aproxime um nome de pasta.
- Para perguntas genéricas sem pasta específica, use "visao_geral".
- Para perguntas específicas de uma pasta, sempre use "consultar_pasta" em vez de responder de memória ou adivinhar.
- Nunca afirme que uma pasta está vazia ou que uma informação não existe sem antes checar com "consultar_pasta" ou "visao_geral".
- Para saudações ou conversas genéricas que não envolvam anotações, use "responder_direto".`;

  const pastaPathProp = (desc) => ({
    type: "string",
    description: desc,
    ...(folderPaths.length > 0 ? { enum: folderPaths } : {})
  });

  const tools = [
    {
      type: "function",
      function: {
        name: "salvar_nota",
        description: "Salva uma nova nota em uma pasta específica. A pasta será criada automaticamente caso não exista.",
        parameters: {
          type: "object",
          properties: {
            pasta_path: { type: "string", description: "Caminho completo da pasta (ex: Financeiro/Cofre)" },
            conteudo: { type: "string", description: "Conteúdo da nota a ser salva" }
          },
          required: ["pasta_path", "conteudo"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "criar_pasta",
        description: "Cria uma nova pasta no sistema.",
        parameters: {
          type: "object",
          properties: {
            pasta_pai_path: { type: "string", description: "Caminho da pasta pai onde será criada (vazio para raiz)" },
            nome: { type: "string", description: "Nome da nova pasta" }
          },
          required: ["nome"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "consultar_pasta",
        description: "Consulta notas de uma pasta específica para responder a uma pergunta.",
        parameters: {
          type: "object",
          properties: {
            pasta_path: pastaPathProp("Caminho completo da pasta a ser consultada"),
            pergunta: { type: "string", description: "A pergunta original do usuário para buscar nas notas" }
          },
          required: ["pasta_path", "pergunta"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "editar_nota",
        description: "Edita uma nota existente. Busca a nota por um trecho do seu conteúdo atual e a substitui pelo novo conteúdo.",
        parameters: {
          type: "object",
          properties: {
            pasta_path: pastaPathProp("Caminho da pasta onde a nota está"),
            busca: { type: "string", description: "Trecho do texto atual da nota para encontrá-la" },
            novo_conteudo: { type: "string", description: "Novo conteúdo que irá substituir o antigo" }
          },
          required: ["pasta_path", "busca", "novo_conteudo"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "remover_nota",
        description: "Remove uma nota existente de uma pasta. Busca a nota pelo seu conteúdo.",
        parameters: {
          type: "object",
          properties: {
            pasta_path: pastaPathProp("Caminho da pasta onde a nota está"),
            busca: { type: "string", description: "Trecho do texto da nota para encontrá-la" }
          },
          required: ["pasta_path", "busca"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "remover_pasta",
        description: "Remove uma pasta inteira. Não remove se tiver subpastas.",
        parameters: {
          type: "object",
          properties: {
            pasta_path: pastaPathProp("Caminho da pasta a ser removida")
          },
          required: ["pasta_path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "visao_geral",
        description: "Retorna uma lista de todas as pastas e a quantidade de notas em cada uma. Útil para perguntas genéricas sobre o que está anotado.",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    },
    {
      type: "function",
      function: {
        name: "responder_direto",
        description: "Responde diretamente ao usuário sem interagir com as notas/pastas.",
        parameters: {
          type: "object",
          properties: {
            texto: { type: "string", description: "Texto da resposta a ser enviada ao usuário" }
          },
          required: ["texto"]
        }
      }
    }
  ];

  // 3. Verifica apiKey
  const groqApiKey = process.env.GROQ_API_KEY;
  const groqModel = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
  
  if (!groqApiKey) {
    return "⚠️ A chave da API GROQ (GROQ_API_KEY) não está configurada. Por favor, configure-a no arquivo .env.";
  }

  // 5. Histórico do estado
  let state = { chatHistories: {} };
  try {
    const stateRs = await db.execute({
      sql: 'SELECT data FROM agent_state WHERE id = ?',
      args: ['main_brain_state']
    });
    if (stateRs.rows.length > 0) {
      state = JSON.parse(stateRs.rows[0].data);
      if (!state.chatHistories) state.chatHistories = {};
    }
  } catch(e) {
    console.error("Erro ao ler state:", e);
  }

  const chatKey = String(chatId);
  if (!state.chatHistories[chatKey]) state.chatHistories[chatKey] = [];
  const history = state.chatHistories[chatKey].slice(-4);
  
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userText }
  ];

  // Chama Groq API
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + groqApiKey
      },
      body: JSON.stringify({
        model: groqModel,
        messages: messages,
        tools: tools,
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: 1024
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      return `⚠️ Erro na API Groq (${response.status}): ${errText}`;
    }
    
    const data = await response.json();
    const choice = data.choices && data.choices[0];
    if (!choice) return "Não obtive resposta da IA.";
    const assistantMessage = choice.message;

    let aiReply = "Ação realizada.";

    // 4. Executa tool
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      const toolCall = assistantMessage.tool_calls[0];
      const callName = toolCall.function.name;
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        return "Erro ao processar chamada de ferramenta da IA.";
      }

      // Helper para garantir pasta recursivamente
      const ensureFolder = async (folderPath) => {
        if (!folderPath) return null;
        const parts = folderPath.split('/').filter(Boolean);
        let currentParent = null;
        let currentPath = '';
        
        for (const part of parts) {
          currentPath += (currentPath ? '/' : '') + part;
          const rs = await db.execute({
            sql: 'SELECT id FROM folders WHERE path = ?',
            args: [currentPath]
          });
          if (rs.rows.length > 0) {
            currentParent = rs.rows[0].id;
          } else {
            const newId = crypto.randomUUID();
            await db.execute({
              sql: 'INSERT INTO folders (id, parent_id, name, path) VALUES (?, ?, ?, ?)',
              args: [newId, currentParent, part, currentPath]
            });
            currentParent = newId;
          }
        }
        return currentParent;
      };

      if (callName === "salvar_nota") {
        const folderId = await ensureFolder(args.pasta_path);
        const noteId = crypto.randomUUID();
        await db.execute({
          sql: 'INSERT INTO notes (id, folder_id, content) VALUES (?, ?, ?)',
          args: [noteId, folderId, args.conteudo]
        });
        aiReply = `Anotado em ${args.pasta_path}`;
        
      } else if (callName === "criar_pasta") {
        const parentId = await ensureFolder(args.pasta_pai_path);
        const currentPath = (args.pasta_pai_path ? args.pasta_pai_path + '/' : '') + args.nome;
        
        const rs = await db.execute({
          sql: 'SELECT id FROM folders WHERE path = ?',
          args: [currentPath]
        });
        if (rs.rows.length === 0) {
           const newId = crypto.randomUUID();
           await db.execute({
             sql: 'INSERT INTO folders (id, parent_id, name, path) VALUES (?, ?, ?, ?)',
             args: [newId, parentId, args.nome, currentPath]
           });
        }
        aiReply = `Pasta criada: ${currentPath}`;
        
      } else if (callName === "consultar_pasta") {
        let rs = await db.execute({
          sql: 'SELECT id FROM folders WHERE path = ?',
          args: [args.pasta_path]
        });
        
        if (rs.rows.length === 0) {
          rs = await db.execute({
            sql: 'SELECT id FROM folders WHERE LOWER(path) = LOWER(?)',
            args: [args.pasta_path]
          });
        }
        
        if (rs.rows.length === 0) {
          aiReply = `A pasta ${args.pasta_path} não existe.`;
        } else {
          const folderId = rs.rows[0].id;
          const notesRs = await db.execute({
            sql: 'SELECT content, created_at FROM notes WHERE folder_id = ? ORDER BY created_at ASC',
            args: [folderId]
          });
          const notesContent = notesRs.rows.map(n => `[${formatBrazilDateTime(n.created_at)}] ${n.content}`).join('\n\n---\n\n');

          const prompt2 = `Você está consultando a pasta "${args.pasta_path}".

CONTEÚDO DAS NOTAS NESTA PASTA:
${notesContent || "(nenhuma nota nesta pasta)"}

PERGUNTA DO USUÁRIO: ${args.pergunta}

Responda em português, usando APENAS o conteúdo das notas fornecido acima. Cada nota começa com a data e hora em que foi salva, no formato [DD/MM/AAAA HH:MM]. Quando a pergunta do usuário envolver tarefas, compromissos ou pedir para saber quando algo foi anotado, inclua essa data/hora na resposta. Nunca invente uma data que não esteja no texto da nota. Se a informação não estiver nas notas, diga que não encontrou na pasta.`;
          
          const response2 = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + groqApiKey
            },
            body: JSON.stringify({
              model: groqModel,
              messages: [ { role: "user", content: prompt2 } ],
              temperature: 0.7,
              max_tokens: 1024
            })
          });
          if (response2.ok) {
            const data2 = await response2.json();
            aiReply = data2.choices[0]?.message?.content || "Não consegui processar a resposta.";
          } else {
             const errBody = await response2.text();
             console.error(`Erro na segunda chamada do Groq (${response2.status}):`, errBody);
             aiReply = `Não consegui formatar direito, mas encontrei isso na pasta:\n\n${notesContent || "(pasta vazia)"}`;
          }
        }
        
      } else if (callName === "editar_nota" || callName === "remover_nota") {
        const { pasta_path, busca, novo_conteudo } = args;
        let rs = await db.execute({ sql: 'SELECT id FROM folders WHERE path = ?', args: [pasta_path] });
        if (rs.rows.length === 0) {
          rs = await db.execute({ sql: 'SELECT id FROM folders WHERE LOWER(path) = LOWER(?)', args: [pasta_path] });
        }
        
        if (rs.rows.length === 0) {
          aiReply = `A pasta ${pasta_path} não foi encontrada.`;
        } else {
          const folderId = rs.rows[0].id;
          const notesRs = await db.execute({
            sql: 'SELECT id, content FROM notes WHERE folder_id = ? ORDER BY created_at DESC',
            args: [folderId]
          });
          
          const matchingNotes = notesRs.rows.filter(n => n.content.toLowerCase().includes(busca.toLowerCase()));
          
          if (matchingNotes.length === 0) {
            aiReply = `Não encontrei nenhuma nota contendo "${busca}" em ${pasta_path}.`;
          } else {
            const targetNote = matchingNotes[0]; // a mais recente
            const acao = callName === "editar_nota" ? "editei" : "removi";
            let msgExtra = matchingNotes.length > 1 ? ` (havia ${matchingNotes.length} notas correspondentes, ${acao} a mais recente)` : '';
            
            if (callName === "editar_nota") {
              await db.execute({
                sql: 'UPDATE notes SET content = ? WHERE id = ?',
                args: [novo_conteudo, targetNote.id]
              });
              aiReply = `Nota atualizada em ${pasta_path}${msgExtra}`;
            } else {
              await db.execute({
                sql: 'DELETE FROM notes WHERE id = ?',
                args: [targetNote.id]
              });
              aiReply = `Nota removida de ${pasta_path}${msgExtra}`;
            }
          }
        }
        
      } else if (callName === "remover_pasta") {
        let rs = await db.execute({ sql: 'SELECT id FROM folders WHERE path = ?', args: [args.pasta_path] });
        if (rs.rows.length === 0) {
          rs = await db.execute({ sql: 'SELECT id FROM folders WHERE LOWER(path) = LOWER(?)', args: [args.pasta_path] });
        }
        if (rs.rows.length === 0) {
          aiReply = `A pasta ${args.pasta_path} não existe.`;
        } else {
          const folderId = rs.rows[0].id;
          const subRs = await db.execute({ sql: 'SELECT count(*) as count FROM folders WHERE parent_id = ?', args: [folderId] });
          if (subRs.rows[0].count > 0) {
            aiReply = `Não é possível remover a pasta ${args.pasta_path} pois ela contém subpastas.`;
          } else {
            await db.execute({ sql: 'DELETE FROM notes WHERE folder_id = ?', args: [folderId] });
            await db.execute({ sql: 'DELETE FROM folders WHERE id = ?', args: [folderId] });
            aiReply = `Pasta ${args.pasta_path} e suas notas foram removidas.`;
          }
        }
        
      } else if (callName === "visao_geral") {
        const rs = await db.execute(`
          SELECT f.path, COUNT(n.id) as qtd
          FROM folders f
          LEFT JOIN notes n ON f.id = n.folder_id
          GROUP BY f.id, f.path
          ORDER BY f.path ASC
        `);
        if (rs.rows.length === 0) {
          aiReply = "O segundo cérebro está vazio. Nenhuma pasta foi criada ainda.";
        } else {
          const linhas = rs.rows.map(row => `- ${row.path} (${row.qtd} notas)`);
          aiReply = `Visão geral das pastas e notas:\n${linhas.join('\n')}`;
        }
      } else if (callName === "responder_direto") {
        aiReply = args.texto;
      }
    } else {
      const rawContent = assistantMessage.content;
      if (rawContent && typeof rawContent === "string") {
        aiReply = rawContent.trim();
      } else {
         const retryResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + groqApiKey
            },
            body: JSON.stringify({
              model: groqModel,
              messages: messages,
              temperature: 0.7,
              max_tokens: 512
            })
          });
          if (retryResp.ok) {
            const retryData = await retryResp.json();
            aiReply = retryData.choices?.[0]?.message?.content?.trim() || "Não obtive resposta da IA.";
          }
      }
    }

    state.chatHistories[chatKey].push({ role: "user", content: userText });
    state.chatHistories[chatKey].push({ role: "assistant", content: aiReply });
    
    await db.execute({
      sql: 'INSERT INTO agent_state (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP',
      args: ['main_brain_state', JSON.stringify(state)]
    });

    return aiReply;
  } catch (err) {
    console.error("[GROQ EXCEPTION]:", err.message);
    return "⚠️ Erro interno ao consultar o Groq AI: " + err.message;
  }
}
