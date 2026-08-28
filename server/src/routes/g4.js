"use strict";

// G4 — treinamento interno quinzenal, separado por área (reaproveita os
// Setores já cadastrados). O admin agenda data/setor/responsável; só o
// responsável (ou um admin) escreve o tema e envia a gravação. Qualquer
// colaborador autenticado vê o histórico de todas as áreas e marca "já vi".
//
// A gravação é um upload de vídeo de verdade (não um link) — fica salva em
// disco (server/data/g4-recordings/<uuid>.<ext>) e é servida por uma rota
// autenticada (não é express.static), usando res.sendFile pra que o
// Express/`send` cuidem do cabeçalho Range sozinhos (necessário pro
// <video> do navegador poder avançar/retroceder sem baixar tudo de novo).

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAuth);

const RECORDINGS_DIR = path.join(__dirname, "..", "..", "data", "g4-recordings");
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// 2GB por arquivo — uma gravação de 30-60min facilmente passa de 500MB-1GB.
// Fica pesado no disco do servidor com o tempo, mas foi a opção escolhida
// (upload direto em vez de link externo tipo Drive/YouTube).
const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;

const ALLOWED_MIME_EXT = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RECORDINGS_DIR),
  filename: (req, file, cb) => {
    const ext = ALLOWED_MIME_EXT[file.mimetype] || path.extname(file.originalname) || "";
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_RECORDING_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_EXT[file.mimetype]) return cb(new Error("Formato de vídeo não suportado"));
    cb(null, true);
  },
});

// Embrulha o middleware do multer pra devolver um erro 400 com mensagem
// clara em vez de cair no handler de erro genérico (500) do index.js.
function handleUpload(req, res, next) {
  upload.single("recording")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "Arquivo muito grande (limite de 2GB)" });
      }
      return res.status(400).json({ error: err.message || "Falha ao enviar o arquivo" });
    }
    next();
  });
}

async function safeUnlink(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[g4] falha ao apagar arquivo de gravação:", err.message);
  }
}

// Admin agenda/edita qualquer sessão; o apresentador designado só edita o
// próprio tema/gravação.
function canManagePresentation(user, session) {
  return user.role === "admin" || (!!user.collaboratorId && user.collaboratorId === session.presenter_collaborator_id);
}

function serializeSessionRow(row, viewerCount, viewedByMe) {
  return {
    id: row.id,
    sectorId: row.sector_id,
    sectorName: row.sector_name,
    date: row.date,
    presenterCollaboratorId: row.presenter_collaborator_id,
    presenterName: row.presenter_name,
    topic: row.topic || "",
    hasRecording: !!row.recording_stored_name,
    recordingFilename: row.recording_filename || undefined,
    recordingMime: row.recording_mime || undefined,
    recordingSize: row.recording_size != null ? Number(row.recording_size) : undefined,
    recordingUploadedAt: row.recording_uploaded_at || undefined,
    viewerCount,
    viewedByMe,
  };
}

async function loadSessionPayload(id, user) {
  const row = await db.get(
    `SELECT gs.*, s.name AS sector_name, c.name AS presenter_name
     FROM g4_sessions gs
     JOIN sectors s ON s.id = gs.sector_id
     JOIN collaborators c ON c.id = gs.presenter_collaborator_id
     WHERE gs.id = ?`,
    [id]
  );
  if (!row) return null;
  const countRow = await db.get("SELECT COUNT(*) AS cnt FROM g4_views WHERE session_id = ?", [id]);
  let viewedByMe = false;
  if (user.collaboratorId) {
    const mine = await db.get("SELECT id FROM g4_views WHERE session_id = ? AND collaborator_id = ?", [id, user.collaboratorId]);
    viewedByMe = !!mine;
  }
  return serializeSessionRow(row, countRow.cnt, viewedByMe);
}

// GET /api/g4/sessions -> todas as sessões (dataset pequeno: ~2/mês por
// área), com nome do setor/apresentador já resolvidos. O front separa em
// "Próximos" e "Já realizados" comparando `date` com hoje.
router.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT gs.*, s.name AS sector_name, c.name AS presenter_name
       FROM g4_sessions gs
       JOIN sectors s ON s.id = gs.sector_id
       JOIN collaborators c ON c.id = gs.presenter_collaborator_id
       ORDER BY gs.date ASC, gs.id ASC`
    );
    if (rows.length === 0) return res.json([]);

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const viewCounts = await db.all(
      `SELECT session_id, COUNT(*) AS cnt FROM g4_views WHERE session_id IN (${placeholders}) GROUP BY session_id`,
      ids
    );
    const countBySession = new Map(viewCounts.map((v) => [v.session_id, v.cnt]));

    let viewedSet = new Set();
    if (req.user.collaboratorId) {
      const mine = await db.all(
        `SELECT session_id FROM g4_views WHERE collaborator_id = ? AND session_id IN (${placeholders})`,
        [req.user.collaboratorId, ...ids]
      );
      viewedSet = new Set(mine.map((m) => m.session_id));
    }

    res.json(rows.map((row) => serializeSessionRow(row, countBySession.get(row.id) ?? 0, viewedSet.has(row.id))));
  })
);

// POST /api/g4/sessions  { sectorId, date, presenterCollaboratorId }
router.post(
  "/sessions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const sectorId = String(req.body?.sectorId || "");
    const presenterCollaboratorId = String(req.body?.presenterCollaboratorId || "");
    const date = String(req.body?.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Data inválida" });

    const sector = await db.get("SELECT id FROM sectors WHERE id = ?", [sectorId]);
    if (!sector) return res.status(400).json({ error: "Setor inválido" });
    const presenter = await db.get("SELECT id FROM collaborators WHERE id = ?", [presenterCollaboratorId]);
    if (!presenter) return res.status(400).json({ error: "Colaborador responsável inválido" });

    const info = await db.run(
      "INSERT INTO g4_sessions (sector_id, date, presenter_collaborator_id) VALUES (?, ?, ?)",
      [sectorId, date, presenterCollaboratorId]
    );
    res.status(201).json(await loadSessionPayload(Number(info.lastInsertRowid), req.user));
  })
);

// PATCH /api/g4/sessions/:id  { date?, sectorId?, presenterCollaboratorId? }
router.patch(
  "/sessions/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const session = await db.get("SELECT * FROM g4_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "Sessão não encontrada" });

    const b = req.body || {};
    let date = session.date;
    if (b.date != null) {
      date = String(b.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Data inválida" });
    }
    let sectorId = session.sector_id;
    if (b.sectorId != null) {
      const sector = await db.get("SELECT id FROM sectors WHERE id = ?", [b.sectorId]);
      if (!sector) return res.status(400).json({ error: "Setor inválido" });
      sectorId = b.sectorId;
    }
    let presenterCollaboratorId = session.presenter_collaborator_id;
    if (b.presenterCollaboratorId != null) {
      const presenter = await db.get("SELECT id FROM collaborators WHERE id = ?", [b.presenterCollaboratorId]);
      if (!presenter) return res.status(400).json({ error: "Colaborador responsável inválido" });
      presenterCollaboratorId = b.presenterCollaboratorId;
    }

    await db.run("UPDATE g4_sessions SET date = ?, sector_id = ?, presenter_collaborator_id = ? WHERE id = ?", [
      date,
      sectorId,
      presenterCollaboratorId,
      session.id,
    ]);
    res.json(await loadSessionPayload(session.id, req.user));
  })
);

// PATCH /api/g4/sessions/:id/topic  { topic }
router.patch(
  "/sessions/:id/topic",
  asyncHandler(async (req, res) => {
    const session = await db.get("SELECT * FROM g4_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "Sessão não encontrada" });
    if (!canManagePresentation(req.user, session)) {
      return res.status(403).json({ error: "Só o apresentador ou um administrador pode editar o tema" });
    }
    const topic = String(req.body?.topic || "").trim().slice(0, 500);
    await db.run("UPDATE g4_sessions SET topic = ? WHERE id = ?", [topic || null, session.id]);
    res.json(await loadSessionPayload(session.id, req.user));
  })
);

// DELETE /api/g4/sessions/:id
router.delete(
  "/sessions/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const session = await db.get("SELECT * FROM g4_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "Sessão não encontrada" });
    if (session.recording_stored_name) await safeUnlink(path.join(RECORDINGS_DIR, session.recording_stored_name));
    await db.run("DELETE FROM g4_sessions WHERE id = ?", [session.id]);
    res.json({ ok: true });
  })
);

// POST /api/g4/sessions/:id/recording  multipart/form-data, campo "recording"
router.post(
  "/sessions/:id/recording",
  asyncHandler(async (req, res, next) => {
    const session = await db.get("SELECT * FROM g4_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "Sessão não encontrada" });
    if (!canManagePresentation(req.user, session)) {
      return res.status(403).json({ error: "Só o apresentador ou um administrador pode enviar a gravação" });
    }
    req.g4Session = session;
    handleUpload(req, res, next);
  }),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Selecione um arquivo de vídeo" });
    const session = req.g4Session;
    if (session.recording_stored_name) await safeUnlink(path.join(RECORDINGS_DIR, session.recording_stored_name));
    await db.run(
      `UPDATE g4_sessions
       SET recording_filename = ?, recording_stored_name = ?, recording_mime = ?, recording_size = ?, recording_uploaded_at = NOW()
       WHERE id = ?`,
      [req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, session.id]
    );
    res.json(await loadSessionPayload(session.id, req.user));
  })
);

// DELETE /api/g4/sessions/:id/recording
router.delete(
  "/sessions/:id/recording",
  asyncHandler(async (req, res) => {
    const session = await db.get("SELECT * FROM g4_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "Sessão não encontrada" });
    if (!canManagePresentation(req.user, session)) {
      return res.status(403).json({ error: "Só o apresentador ou um administrador pode remover a gravação" });
    }
    if (session.recording_stored_name) await safeUnlink(path.join(RECORDINGS_DIR, session.recording_stored_name));
    await db.run(
      `UPDATE g4_sessions
       SET recording_filename = NULL, recording_stored_name = NULL, recording_mime = NULL, recording_size = NULL, recording_uploaded_at = NULL
       WHERE id = ?`,
      [session.id]
    );
    res.json(await loadSessionPayload(session.id, req.user));
  })
);

// GET /api/g4/sessions/:id/recording -> stream do arquivo (Range já é
// tratado pelo Express/`send` dentro de res.sendFile).
router.get(
  "/sessions/:id/recording",
  asyncHandler(async (req, res) => {
    const session = await db.get("SELECT recording_stored_name, recording_mime FROM g4_sessions WHERE id = ?", [req.params.id]);
    if (!session || !session.recording_stored_name) return res.status(404).json({ error: "Gravação não encontrada" });
    const filePath = path.join(RECORDINGS_DIR, session.recording_stored_name);
    res.setHeader("Content-Type", session.recording_mime || "application/octet-stream");
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Arquivo da gravação não encontrado" });
    });
  })
);

// POST /api/g4/sessions/:id/views -> marca "já vi" pro próprio usuário logado
router.post(
  "/sessions/:id/views",
  asyncHandler(async (req, res) => {
    if (!req.user.collaboratorId) return res.status(400).json({ error: "Sua conta não está vinculada a um colaborador" });
    const session = await db.get("SELECT id FROM g4_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "Sessão não encontrada" });
    // Idempotente — clicar duas vezes não gera erro nem duplica a marcação.
    await db.run("INSERT INTO g4_views (session_id, collaborator_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE viewed_at = viewed_at", [
      session.id,
      req.user.collaboratorId,
    ]);
    res.json(await loadSessionPayload(session.id, req.user));
  })
);

// DELETE /api/g4/sessions/:id/views -> desmarca (caso tenha clicado errado)
router.delete(
  "/sessions/:id/views",
  asyncHandler(async (req, res) => {
    if (!req.user.collaboratorId) return res.status(400).json({ error: "Sua conta não está vinculada a um colaborador" });
    const session = await db.get("SELECT id FROM g4_sessions WHERE id = ?", [req.params.id]);
    if (!session) return res.status(404).json({ error: "Sessão não encontrada" });
    await db.run("DELETE FROM g4_views WHERE session_id = ? AND collaborator_id = ?", [session.id, req.user.collaboratorId]);
    res.json(await loadSessionPayload(session.id, req.user));
  })
);

module.exports = router;
