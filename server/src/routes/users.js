"use strict";

const express = require("express");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin, hashPassword, DEFAULT_PASSWORD } = require("../auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

async function listUsers() {
  return db.all(
    `SELECT u.id, u.username, u.role, u.must_change_password as mustChangePassword,
            u.collaborator_id as collaboratorId, c.name as collaboratorName
     FROM users u LEFT JOIN collaborators c ON c.id = u.collaborator_id
     ORDER BY u.id ASC`
  );
}

// GET /api/users
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json((await listUsers()).map((u) => ({ ...u, mustChangePassword: !!u.mustChangePassword })));
  })
);

// POST /api/users  { username, role, collaboratorId? }
// A senha nunca é escolhida pelo admin: todo acesso novo nasce com a senha
// padrão (DEFAULT_PASSWORD) e a pessoa é obrigada a trocá-la no primeiro login.
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { username, role, collaboratorId } = req.body || {};
    if (!username) {
      return res.status(400).json({ error: "Informe o usuário" });
    }
    if (!["admin", "collaborator"].includes(role)) {
      return res.status(400).json({ error: "Papel inválido" });
    }
    if (role === "collaborator") {
      if (!collaboratorId) return res.status(400).json({ error: "Selecione o colaborador vinculado" });
      const collab = await db.get("SELECT id FROM collaborators WHERE id = ?", [collaboratorId]);
      if (!collab) return res.status(400).json({ error: "Colaborador não encontrado" });
      const existing = await db.get("SELECT id FROM users WHERE collaborator_id = ?", [collaboratorId]);
      if (existing) return res.status(400).json({ error: "Este colaborador já possui um acesso" });
    }
    const existingUsername = await db.get("SELECT id FROM users WHERE username = ?", [String(username).trim()]);
    if (existingUsername) return res.status(400).json({ error: "Nome de usuário já existe" });

    try {
      const info = await db.run(
        "INSERT INTO users (username, password_hash, must_change_password, role, collaborator_id) VALUES (?, ?, 1, ?, ?)",
        [String(username).trim(), hashPassword(DEFAULT_PASSWORD), role, role === "collaborator" ? collaboratorId : null]
      );
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (e) {
      res.status(400).json({ error: "Não foi possível criar o acesso" });
    }
  })
);

// PUT /api/users/:id  { role? }
router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Acesso não encontrado" });

    const { role } = req.body || {};
    if (role && !["admin", "collaborator"].includes(role)) {
      return res.status(400).json({ error: "Papel inválido" });
    }
    if (row.role === "admin" && role === "collaborator") {
      const admins = await db.get("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
      if (Number(admins.c) <= 1) return res.status(400).json({ error: "Não é possível remover o último administrador" });
    }
    if (role) {
      await db.run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
    }
    res.json({ ok: true });
  })
);

// POST /api/users/:id/reset-password
// Único jeito do admin "mexer" na senha de outra pessoa: redefine para o
// padrão (DEFAULT_PASSWORD) e força a troca no próximo login.
router.post(
  "/:id/reset-password",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await db.get("SELECT id FROM users WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Acesso não encontrado" });
    await db.run(
      "UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?",
      [hashPassword(DEFAULT_PASSWORD), id]
    );
    res.json({ ok: true });
  })
);

// DELETE /api/users/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Acesso não encontrado" });
    if (row.role === "admin") {
      const admins = await db.get("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
      if (Number(admins.c) <= 1) return res.status(400).json({ error: "Não é possível remover o último administrador" });
    }
    if (row.id === req.user.id) {
      return res.status(400).json({ error: "Você não pode remover seu próprio acesso" });
    }
    await db.run("DELETE FROM users WHERE id = ?", [id]);
    res.json({ ok: true });
  })
);

module.exports = router;
