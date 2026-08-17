"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAuth, requireAdmin); // projects (cost calculator) is an admin-only tool

async function loadProject(id) {
  const p = await db.get("SELECT * FROM projects WHERE id = ?", [id]);
  if (!p) return null;
  const members = await db.all(
    "SELECT collaborator_id as collaboratorId, days FROM project_members WHERE project_id = ?",
    [id]
  );
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    requester: p.requester,
    month: p.month,
    year: p.year,
    startDate: p.start_date,
    endDate: p.end_date,
    costCenters: db.parseJSON(p.cost_centers, []),
    splits: db.parseJSON(p.splits, {}),
    members,
  };
}

async function upsertMembers(projectId, members) {
  await db.run("DELETE FROM project_members WHERE project_id = ?", [projectId]);
  for (const m of members || []) {
    if (!m || !m.collaboratorId) continue;
    await db.run("INSERT INTO project_members (project_id, collaborator_id, days) VALUES (?, ?, ?)", [
      projectId,
      m.collaboratorId,
      Math.max(0, Math.round(Number(m.days) || 0)),
    ]);
  }
}

// GET /api/projects
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await db.all("SELECT id FROM projects ORDER BY created_at DESC");
    const projects = await Promise.all(rows.map((r) => loadProject(r.id)));
    res.json(projects);
  })
);

// POST /api/projects
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "Nome do projeto é obrigatório" });
    const id = b.id && String(b.id).trim() ? String(b.id).trim() : crypto.randomUUID();
    await db.run(
      `INSERT INTO projects (id, name, description, requester, month, year, start_date, end_date, cost_centers, splits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        String(b.name).trim(),
        b.description || "",
        b.requester || "",
        Number(b.month) || 0,
        Number(b.year) || new Date().getFullYear(),
        b.startDate || "",
        b.endDate || "",
        JSON.stringify(b.costCenters || []),
        JSON.stringify(b.splits || {}),
      ]
    );
    await upsertMembers(id, b.members);
    res.status(201).json(await loadProject(id));
  })
);

// PUT /api/projects/:id
router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await db.get("SELECT id FROM projects WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Projeto não encontrado" });
    const b = req.body || {};
    await db.run(
      `UPDATE projects SET name=?, description=?, requester=?, month=?, year=?, start_date=?, end_date=?, cost_centers=?, splits=? WHERE id=?`,
      [
        String(b.name || "").trim(),
        b.description || "",
        b.requester || "",
        Number(b.month) || 0,
        Number(b.year) || new Date().getFullYear(),
        b.startDate || "",
        b.endDate || "",
        JSON.stringify(b.costCenters || []),
        JSON.stringify(b.splits || {}),
        id,
      ]
    );
    await upsertMembers(id, b.members);
    res.json(await loadProject(id));
  })
);

// DELETE /api/projects/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await db.get("SELECT id FROM projects WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Projeto não encontrado" });
    await db.run("DELETE FROM projects WHERE id = ?", [id]);
    res.json({ ok: true });
  })
);

module.exports = router;
