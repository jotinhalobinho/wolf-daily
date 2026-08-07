"use strict";

const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin, hashPassword } = require("../auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

function listUsers() {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.collaborator_id as collaboratorId, c.name as collaboratorName
       FROM users u LEFT JOIN collaborators c ON c.id = u.collaborator_id
       ORDER BY u.id ASC`
    )
    .all();
  return rows;
}

// GET /api/users
router.get("/", (req, res) => {
  res.json(listUsers());
});

// POST /api/users  { username, password, role, collaboratorId? }
router.post("/", (req, res) => {
  const { username, password, role, collaboratorId } = req.body || {};
  if (!username || !password || String(password).length < 6) {
    return res.status(400).json({ error: "Informe usuário e senha (mínimo 6 caracteres)" });
  }
  if (!["admin", "collaborator"].includes(role)) {
    return res.status(400).json({ error: "Papel inválido" });
  }
  if (role === "collaborator") {
    if (!collaboratorId) return res.status(400).json({ error: "Selecione o colaborador vinculado" });
    const collab = db.prepare("SELECT id FROM collaborators WHERE id = ?").get(collaboratorId);
    if (!collab) return res.status(400).json({ error: "Colaborador não encontrado" });
    const existing = db.prepare("SELECT id FROM users WHERE collaborator_id = ?").get(collaboratorId);
    if (existing) return res.status(400).json({ error: "Este colaborador já possui um acesso" });
  }
  const existingUsername = db.prepare("SELECT id FROM users WHERE username = ?").get(String(username).trim());
  if (existingUsername) return res.status(400).json({ error: "Nome de usuário já existe" });

  try {
    const info = db
      .prepare("INSERT INTO users (username, password_hash, role, collaborator_id) VALUES (?, ?, ?, ?)")
      .run(String(username).trim(), hashPassword(password), role, role === "collaborator" ? collaboratorId : null);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch (e) {
    res.status(400).json({ error: "Não foi possível criar o acesso" });
  }
});

// PUT /api/users/:id  { password?, role? }
router.put("/:id", (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Acesso não encontrado" });

  const { password, role } = req.body || {};
  if (role && !["admin", "collaborator"].includes(role)) {
    return res.status(400).json({ error: "Papel inválido" });
  }
  if (role === "admin" || (!role && row.role === "admin")) {
    // becoming/staying admin: fine
  }
  if (row.role === "admin" && role === "collaborator") {
    const admins = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: "Não é possível remover o último administrador" });
  }
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: "Senha deve ter ao menos 6 caracteres" });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), id);
  }
  if (role) {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  }
  res.json({ ok: true });
});

// DELETE /api/users/:id
router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Acesso não encontrado" });
  if (row.role === "admin") {
    const admins = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: "Não é possível remover o último administrador" });
  }
  if (row.id === req.user.id) {
    return res.status(400).json({ error: "Você não pode remover seu próprio acesso" });
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.json({ ok: true });
});

module.exports = router;
