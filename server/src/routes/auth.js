"use strict";

const express = require("express");
const db = require("../db");
const {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  getUserFromReq,
  requireAuth,
} = require("../auth");

const router = express.Router();

function countUsers() {
  return db.prepare("SELECT COUNT(*) as c FROM users").get().c;
}

function enrich(user) {
  if (!user) return null;
  let collaboratorName = null;
  if (user.collaboratorId) {
    const c = db.prepare("SELECT name FROM collaborators WHERE id = ?").get(user.collaboratorId);
    collaboratorName = c ? c.name : null;
  }
  return { ...user, collaboratorName };
}

// GET /api/auth/status
router.get("/status", (req, res) => {
  const needsSetup = countUsers() === 0;
  if (needsSetup) return res.json({ needsSetup: true, authenticated: false, user: null });
  const user = getUserFromReq(req);
  res.json({ needsSetup: false, authenticated: !!user, user: enrich(user) });
});

// POST /api/auth/setup  { username, password }  -- only works when there are zero users
router.post("/setup", (req, res) => {
  if (countUsers() > 0) {
    return res.status(400).json({ error: "Configuração inicial já concluída" });
  }
  const { username, password } = req.body || {};
  if (!username || !password || String(password).length < 6) {
    return res.status(400).json({ error: "Informe usuário e senha (mínimo 6 caracteres)" });
  }
  const hash = hashPassword(password);
  const info = db
    .prepare("INSERT INTO users (username, password_hash, role, collaborator_id) VALUES (?, ?, 'admin', NULL)")
    .run(String(username).trim(), hash);
  const user = { id: Number(info.lastInsertRowid), username: String(username).trim(), role: "admin", collaboratorId: null };
  const token = signToken({ id: user.id, username: user.username, role: user.role, collaborator_id: null });
  setAuthCookie(res, token);
  res.json({ user: enrich(user) });
});

// POST /api/auth/login { username, password }
router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Informe usuário e senha" });
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(String(username).trim());
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: "Usuário ou senha inválidos" });
  }
  const token = signToken(row);
  setAuthCookie(res, token);
  const user = { id: row.id, username: row.username, role: row.role, collaboratorId: row.collaborator_id };
  res.json({ user: enrich(user) });
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: enrich(req.user) });
});

// PUT /api/auth/password { oldPassword, newPassword }
router.put("/password", requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "Nova senha deve ter ao menos 6 caracteres" });
  }
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!row || !verifyPassword(oldPassword || "", row.password_hash)) {
    return res.status(401).json({ error: "Senha atual incorreta" });
  }
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
