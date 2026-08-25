"use strict";

const { WebSocketServer } = require("ws");
const cookie = require("cookie");
const { getUserFromReq } = require("./auth");

// Canal de "a Escala de Home Office mudou" — não sincroniza estado nenhum
// pelo socket, só avisa quem está com a tela aberta pra buscar os dados de
// novo pela API de sempre (GET /api/home-office/current ou /periods/:id).
// Toda validação/regra de negócio continua só no REST, que é a única fonte
// da verdade; o WebSocket é apenas o "toque no ombro" pra substituir o F5
// quando várias pessoas mexem na escala ao mesmo tempo.
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
// feriado, abrir/aprovar período) — avisa todo mundo conectado, sem
// distinguir quem foi; cada tela decide sozinha se recarrega os dados.
function broadcastHomeOfficeUpdate() {
  if (!wss) return;
  const payload = JSON.stringify({ type: "home-office-updated" });
  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

module.exports = { init, broadcastHomeOfficeUpdate };
