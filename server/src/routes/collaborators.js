"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAuth);

function rowToCollaborator(r) {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    salary: r.salary,
    birthDate: r.birth_date || undefined,
    sectorId: r.sector_id || undefined,
    hireDate: r.hire_date || undefined,
    active: !!r.active,
    isIntern: !!r.is_intern,
  };
}

// Aceita "" / null / undefined (limpa o campo) ou uma data "YYYY-MM-DD".
// Usada tanto pra birthDate quanto pra hireDate (Escala de Home Office).
function parseISODateOrNull(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined; // inválido
  return s;
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

// Confere se o setor existe (quando informado) — usado no POST e no PUT.
async function validateSectorId(sectorId) {
  if (sectorId == null || sectorId === "") return { value: null, ok: true };
  const row = await db.get("SELECT id FROM sectors WHERE id = ?", [sectorId]);
  return { value: sectorId, ok: !!row };
}

// POST /api/collaborators  { name, role, salary, birthDate?, sectorId?, hireDate?, active? }
// A cor da tag na Escala de Home Office é do setor (ver routes/sectors.js),
// não é mais escolhida por colaborador.
router.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, role, salary, birthDate, sectorId, hireDate, active, isIntern } = req.body || {};
    const salaryNum = Number(salary);
    if (!name || !String(name).trim() || !role || !String(role).trim() || !(salaryNum > 0)) {
      return res.status(400).json({ error: "Dados inválidos" });
    }
    const birth = parseISODateOrNull(birthDate);
    if (birth === undefined) return res.status(400).json({ error: "Data de aniversário inválida" });
    const hire = parseISODateOrNull(hireDate);
    if (hire === undefined) return res.status(400).json({ error: "Data de admissão inválida" });
    const sector = await validateSectorId(sectorId);
    if (!sector.ok) return res.status(400).json({ error: "Setor não encontrado" });
    const activeValue = active != null ? (active ? 1 : 0) : 1;
    const isInternValue = isIntern ? 1 : 0;

    const id = req.body.id && String(req.body.id).trim() ? String(req.body.id).trim() : crypto.randomUUID();
    const existingId = await db.get("SELECT id FROM collaborators WHERE id = ?", [id]);
    if (existingId) return res.status(400).json({ error: "Identificador já utilizado" });
    await db.run(
      "INSERT INTO collaborators (id, name, role, sector_id, hire_date, active, is_intern, birth_date, salary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, String(name).trim(), String(role).trim(), sector.value, hire, activeValue, isInternValue, birth, salaryNum]
    );
    res.status(201).json({
      id,
      name: String(name).trim(),
      role: String(role).trim(),
      salary: salaryNum,
      birthDate: birth || undefined,
      sectorId: sector.value || undefined,
      hireDate: hire || undefined,
      active: !!activeValue,
      isIntern: !!isInternValue,
    });
  })
);

// PUT /api/collaborators/:id  { name, role, salary, birthDate?, sectorId?, hireDate?, active? }
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
    const birth = req.body.birthDate !== undefined ? parseISODateOrNull(req.body.birthDate) : existing.birth_date;
    const hire = req.body.hireDate !== undefined ? parseISODateOrNull(req.body.hireDate) : existing.hire_date;
    const activeValue = req.body.active != null ? (req.body.active ? 1 : 0) : existing.active;
    const isInternValue = req.body.isIntern != null ? (req.body.isIntern ? 1 : 0) : existing.is_intern;
    if (!name || !role || !(salary > 0)) return res.status(400).json({ error: "Dados inválidos" });
    if (birth === undefined) return res.status(400).json({ error: "Data de aniversário inválida" });
    if (hire === undefined) return res.status(400).json({ error: "Data de admissão inválida" });
    let sectorId = existing.sector_id;
    if (req.body.sectorId !== undefined) {
      const sector = await validateSectorId(req.body.sectorId);
      if (!sector.ok) return res.status(400).json({ error: "Setor não encontrado" });
      sectorId = sector.value;
    }
    await db.run(
      "UPDATE collaborators SET name = ?, role = ?, sector_id = ?, hire_date = ?, active = ?, is_intern = ?, birth_date = ?, salary = ? WHERE id = ?",
      [name, role, sectorId, hire, activeValue, isInternValue, birth, salary, id]
    );
    res.json({
      id,
      name,
      role,
      salary,
      birthDate: birth || undefined,
      sectorId: sectorId || undefined,
      hireDate: hire || undefined,
      active: !!activeValue,
      isIntern: !!isInternValue,
    });
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
