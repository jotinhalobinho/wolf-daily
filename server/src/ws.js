"use strict";

const { WebSocketServer } = require("ws");
const cookie = require("cookie");
const { getUserFromReq } = require("./auth");

// Canal de atualização da Escala de Home Office. Manda o período já pronto
// (não só um "algo mudou") pra quem está com a tela aberta não precisar
// fazer outra requisição pra buscar os dados — é a diferença entre "chegou
// na hora" e "chegou o aviso, mas ainda faltava um vai-e-volta pra API".
// Toda validação/regra de negócio continua só no REST, que é a única fonte
// da verdade; o WebSocket só entrega o resultado já calculado depois que uma
// mudança passou por todas as checagens de sempre.
let wss = null;
let pingInterval = null;

function init(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: "/ws/home-office" });

  wss.on("connection", async (socket, req) => {
    // Autentica pelo mesmo cookie httpOnly da API (o navegador manda o
    // cookie sozinho no handshake do WebSocket por ser mesma origem) — sem
    // isso, qualquer um conseguiria abrir o socket e saber quando a escala
    // muda, mesmo sem estar logado.
    let user = null;
    try {
      const cookies = cookie.parse(req.headers.cookie || "");
      user = await getUserFromReq({ cookies });
    } catch (e) {
      user = null;
    }
    if (!user) {
      socket.close(4401, "Não autenticado");
      return;
    }

    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
  });

  // Descarta conexões mortas (aba fechada / rede caiu sem fechar o socket
  // direito) — sem isso a lista de clientes só cresce com o tempo.
  pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30000);

  wss.on("close", () => clearInterval(pingInterval));
}

// Chamado pelas rotas de home-office depois de qualquer mudança que afete a
// escala visível (entrada de HO, Reunião Geral, férias/dayoff, troca de
// feriado, abrir/aprovar período), já com o período recarregado — o mesmo
// formato que GET /home-office/current devolve. Avisa todo mundo conectado,
// sem distinguir quem foi; cada tela só substitui o período que está vendo.
function broadcastHomeOfficePeriod(period) {
  if (!wss) return;
  const payload = JSON.stringify({ type: "home-office-period", period });
  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

module.exports = { init, broadcastHomeOfficePeriod };
