"use strict";

const express = require("express");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
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

async function countUsers() {
  const row = await db.get("SELECT COUNT(*) as c FROM users");
  return Number(row.c);
}

async function enrich(user) {
  if (!user) return null;
  let collaboratorName = null;
  if (user.collaboratorId) {
    const c = await db.get("SELECT name FROM collaborators WHERE id = ?", [user.collaboratorId]);
    collaboratorName = c ? c.name : null;
  }
  return { ...user, mustChangePassword: !!user.mustChangePassword, collaboratorName };
}

// GET /api/auth/status
router.get(
  "/status",
  asyncHandler(async (req, res) => {
    const needsSetup = (await countUsers()) === 0;
    if (needsSetup) return res.json({ needsSetup: true, authenticated: false, user: null });
    const user = await getUserFromReq(req);
    res.json({ needsSetup: false, authenticated: !!user, user: await enrich(user) });
  })
);

// POST /api/auth/setup  { username, password }  -- only works when there are zero users
router.post(
  "/setup",
  asyncHandler(async (req, res) => {
    if ((await countUsers()) > 0) {
      return res.status(400).json({ error: "Configuração inicial já concluída" });
    }
    const { username, password } = req.body || {};
    if (!username || !password || String(password).length < 6) {
      return res.status(400).json({ error: "Informe usuário e senha (mínimo 6 caracteres)" });
    }
    const hash = hashPassword(password);
    const info = await db.run(
      "INSERT INTO users (username, password_hash, role, collaborator_id) VALUES (?, ?, 'admin', NULL)",
      [String(username).trim(), hash]
    );
    const user = {
      id: Number(info.lastInsertRowid),
      username: String(username).trim(),
      role: "admin",
      collaboratorId: null,
      mustChangePassword: false,
    };
    const token = signToken({ id: user.id, username: user.username, role: user.role, collaborator_id: null });
    setAuthCookie(res, token);
    res.json({ user: await enrich(user) });
  })
);

// POST /api/auth/login { username, password }
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Informe usuário e senha" });
    const row = await db.get("SELECT * FROM users WHERE username = ?", [String(username).trim()]);
    if (!row || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ error: "Usuário ou senha inválidos" });
    }
    const token = signToken(row);
    setAuthCookie(res, token);
    const user = {
      id: row.id,
      username: row.username,
      role: row.role,
      collaboratorId: row.collaborator_id,
      mustChangePassword: !!row.must_change_password,
    };
    res.json({ user: await enrich(user) });
  })
);

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: await enrich(req.user) });
  })
);

// PUT /api/auth/password { oldPassword, newPassword }
router.put(
  "/password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: "Nova senha deve ter ao menos 6 caracteres" });
    }
    const row = await db.get("SELECT * FROM users WHERE id = ?", [req.user.id]);
    if (!row || !verifyPassword(oldPassword || "", row.password_hash)) {
      return res.status(401).json({ error: "Senha atual incorreta" });
    }
    await db.run(
      "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
      [hashPassword(newPassword), req.user.id]
    );
    res.json({ ok: true });
  })
);

module.exports = router;
