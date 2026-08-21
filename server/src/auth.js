"use strict";

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const db = require("./db");

const SECRET_PATH = path.join(__dirname, "..", "data", ".jwt-secret");

function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, "utf8").trim();
  const secret = crypto.randomBytes(48).toString("hex");
  // "server/data" não é mais criado pelo db.js (não existe mais banco em
  // arquivo), então garantimos que a pasta exista antes de gravar o segredo.
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

const JWT_SECRET = getSecret();
const COOKIE_NAME = "rateio_token";

// Senha padrão usada tanto na criação de um novo acesso quanto na redefinição
// pelo admin — o admin nunca escolhe uma senha arbitrária pra outra pessoa,
// só pode voltar pro padrão (a pessoa troca no primeiro login, ver
// must_change_password).
const DEFAULT_PASSWORD = "wolf360";

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username, role: user.role, collaboratorId: user.collaborator_id || null },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // ligar para true se servir via HTTPS
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Returns { id, username, role, collaboratorId } or null. Never throws.
async function getUserFromReq(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.get("SELECT * FROM users WHERE id = ?", [payload.uid]);
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      collaboratorId: user.collaborator_id,
      mustChangePassword: !!user.must_change_password,
    };
  } catch (e) {
    return null;
  }
}

async function requireAuth(req, res, next) {
  try {
    const user = await getUserFromReq(req);
    if (!user) return res.status(401).json({ error: "Não autenticado" });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Acesso restrito a administradores" });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  getUserFromReq,
  requireAuth,
  requireAdmin,
  COOKIE_NAME,
  DEFAULT_PASSWORD,
};
