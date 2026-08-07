"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
require("dotenv").config();

require("./db"); // ensures schema exists / migrations run before anything else

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

app.listen(PORT, () => {
  console.log(`\n  Rateio de Horas — servidor rodando em http://localhost:${PORT}\n`);
});
