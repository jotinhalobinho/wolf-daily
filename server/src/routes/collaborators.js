"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAuth);

function rowToCollaborator(r) {
  return { id: r.id, name: r.name, role: r.role, salary: r.salary };
}

// GET /api/collaborators
// admin: full roster. collaborator: only their own record (privacy - no visibility into others' salaries).
router.get(
  "/",
  asyncHandler(async (req, res) => {
    if (req.user.role === "admin") {
      const rows = await db.all("SELECT * FROM collaborators ORDER BY name ASC");
      return res.json(rows.map(rowToCollaborator));
    }
    if (!req.user.collaboratorId) return res.json([]);
    const row = await db.get("SELECT * FROM collaborators WHERE id = ?", [req.user.collaboratorId]);
    return res.json(row ? [rowToCollaborator(row)] : []);
  })
);

// POST /api/collaborators  { name, role, salary }
router.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, role, salary } = req.body || {};
    const salaryNum = Number(salary);
    if (!name || !String(name).trim() || !role || !String(role).trim() || !(salaryNum > 0)) {
      return res.status(400).json({ error: "Dados inválidos" });
    }
    const id = req.body.id && String(req.body.id).trim() ? String(req.body.id).trim() : crypto.randomUUID();
    const existingId = await db.get("SELECT id FROM collaborators WHERE id = ?", [id]);
    if (existingId) return res.status(400).json({ error: "Identificador já utilizado" });
    await db.run("INSERT INTO collaborators (id, name, role, salary) VALUES (?, ?, ?, ?)", [
      id,
      String(name).trim(),
      String(role).trim(),
      salaryNum,
    ]);
    res.status(201).json({ id, name: String(name).trim(), role: String(role).trim(), salary: salaryNum });
  })
);

// PUT /api/collaborators/:id  { name, role, salary }
router.put(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await db.get("SELECT * FROM collaborators WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Colaborador não encontrado" });
    const name = req.body.name != null ? String(req.body.name).trim() : existing.name;
    const role = req.body.role != null ? String(req.body.role).trim() : existing.role;
    const salary = req.body.salary != null ? Number(req.body.salary) : existing.salary;
    if (!name || !role || !(salary > 0)) return res.status(400).json({ error: "Dados inválidos" });
    await db.run("UPDATE collaborators SET name = ?, role = ?, salary = ? WHERE id = ?", [name, role, salary, id]);
    res.json({ id, name, role, salary });
  })
);

// DELETE /api/collaborators/:id
router.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await db.get("SELECT * FROM collaborators WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Colaborador não encontrado" });
    await db.run("DELETE FROM collaborators WHERE id = ?", [id]);
    res.json({ ok: true });
  })
);

module.exports = router;
