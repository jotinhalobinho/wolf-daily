"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAuth, requireAdmin); // projects (cost calculator) is an admin-only tool

function loadProject(id) {
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!p) return null;
  const members = db.prepare("SELECT collaborator_id as collaboratorId, days FROM project_members WHERE project_id = ?").all(id);
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    requester: p.requester,
    month: p.month,
    year: p.year,
    startDate: p.start_date,
    endDate: p.end_date,
    costCenters: JSON.parse(p.cost_centers || "[]"),
    splits: JSON.parse(p.splits || "{}"),
    members,
  };
}

function upsertMembers(projectId, members) {
  db.prepare("DELETE FROM project_members WHERE project_id = ?").run(projectId);
  const stmt = db.prepare("INSERT INTO project_members (project_id, collaborator_id, days) VALUES (?, ?, ?)");
  for (const m of members || []) {
    if (!m || !m.collaboratorId) continue;
    stmt.run(projectId, m.collaboratorId, Math.max(0, Math.round(Number(m.days) || 0)));
  }
}

// GET /api/projects
router.get("/", (req, res) => {
  const ids = db.prepare("SELECT id FROM projects ORDER BY created_at DESC").all().map((r) => r.id);
  res.json(ids.map(loadProject));
});

// POST /api/projects
router.post("/", (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "Nome do projeto é obrigatório" });
  const id = b.id && String(b.id).trim() ? String(b.id).trim() : crypto.randomUUID();
  db.prepare(
    `INSERT INTO projects (id, name, description, requester, month, year, start_date, end_date, cost_centers, splits)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    String(b.name).trim(),
    b.description || "",
    b.requester || "",
    Number(b.month) || 0,
    Number(b.year) || new Date().getFullYear(),
    b.startDate || "",
    b.endDate || "",
    JSON.stringify(b.costCenters || []),
    JSON.stringify(b.splits || {})
  );
  upsertMembers(id, b.members);
  res.status(201).json(loadProject(id));
});

// PUT /api/projects/:id
router.put("/:id", (req, res) => {
  const { id } = req.params;
  const existing = db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Projeto não encontrado" });
  const b = req.body || {};
  db.prepare(
    `UPDATE projects SET name=?, description=?, requester=?, month=?, year=?, start_date=?, end_date=?, cost_centers=?, splits=? WHERE id=?`
  ).run(
    String(b.name || "").trim(),
    b.description || "",
    b.requester || "",
    Number(b.month) || 0,
    Number(b.year) || new Date().getFullYear(),
    b.startDate || "",
    b.endDate || "",
    JSON.stringify(b.costCenters || []),
    JSON.stringify(b.splits || {}),
    id
  );
  upsertMembers(id, b.members);
  res.json(loadProject(id));
});

// DELETE /api/projects/:id
router.delete("/:id", (req, res) => {
  const { id } = req.params;
  const existing = db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Projeto não encontrado" });
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  res.json({ ok: true });
});

module.exports = router;
