"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
require("dotenv").config();

const db = require("./db");
const { runMigrations } = require("./migrate");

const authRoutes = require("./routes/auth");
const usersRoutes = require("./routes/users");
const collaboratorsRoutes = require("./routes/collaborators");
const projectsRoutes = require("./routes/projects");
const releasesRoutes = require("./routes/releases");
const settingsRoutes = require("./routes/settings");
const dailyRoutes = require("./routes/daily");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/collaborators", collaboratorsRoutes);
app.use("/api/projects", projectsRoutes);
app.use("/api/releases", releasesRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/daily", dailyRoutes);

// Serve the built frontend (Vite build output) if present.
const publicDir = path.join(__dirname, "..", "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

app.use((req, res) => {
  res.status(404).json({ error: "Não encontrado" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erro interno do servidor" });
});

async function start() {
  // Falha rápido e com mensagem clara se o MySQL/MariaDB estiver inacessível,
  // em vez de deixar o servidor subir normalmente e só quebrar na primeira
  // requisição que tentar usar o banco.
  try {
    await db.pool.query("SELECT 1");
  } catch (err) {
    // Node envolve falhas de conexão (ex: ECONNREFUSED em ::1 e 127.0.0.1)
    // num AggregateError cuja .message vem vazia — o detalhe de verdade fica
    // dentro de .errors.
    const detail = err.errors && err.errors.length ? err.errors.map((e) => e.message).join("; ") : err.message;
    console.error("\n  [ERRO] Não foi possível conectar ao banco de dados.");
    console.error("  Confira as variáveis DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME no .env.");
    console.error("  Detalhe:", detail || err, "\n");
    process.exit(1);
  }

  try {
    await runMigrations();
  } catch (err) {
    console.error("\n  [ERRO] Falha ao atualizar a estrutura do banco de dados (migração automática).");
    console.error("  Detalhe:", err.message || err, "\n");
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`\n  Rateio de Horas — servidor rodando em http://localhost:${PORT}\n`);
  });
}

start();
