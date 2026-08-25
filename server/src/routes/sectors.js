"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAuth);

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Aceita "" / null / undefined (limpa o campo) ou um hex "#RRGGBB".
function parseColorOrNull(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!HEX_COLOR_RE.test(s)) return undefined; // inválido
  return s;
}

// Setores não escondem nada sensível (ao contrário de salário) — visíveis
// pra todo mundo, escrita restrita a admin. A cor é do setor (todo mundo
// do mesmo setor usa a mesma tag na Escala de Home Office), não mais do
// colaborador individualmente.
async function loadSectors() {
  const sectors = await db.all("SELECT * FROM sectors ORDER BY name ASC");
  const members = await db.all("SELECT id, sector_id FROM collaborators WHERE sector_id IS NOT NULL");
  const membersBySector = new Map();
  for (const m of members) {
    if (!membersBySector.has(m.sector_id)) membersBySector.set(m.sector_id, []);
    membersBySector.get(m.sector_id).push(m.id);
  }
  return sectors.map((s) => ({ id: s.id, name: s.name, color: s.color || undefined, memberIds: membersBySector.get(s.id) || [] }));
}

// GET /api/sectors
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await loadSectors());
  })
);

// POST /api/sectors  { name, color? }
router.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Informe o nome do setor" });
    const color = parseColorOrNull(req.body?.color);
    if (color === undefined) return res.status(400).json({ error: "Cor inválida (use o formato #RRGGBB)" });
    const dup = await db.get("SELECT id FROM sectors WHERE name = ?", [name]);
    if (dup) return res.status(400).json({ error: "Já existe um setor com esse nome" });
    const id = crypto.randomUUID();
    await db.run("INSERT INTO sectors (id, name, color) VALUES (?, ?, ?)", [id, name, color]);
    res.status(201).json({ id, name, color: color || undefined, memberIds: [] });
  })
);

// PUT /api/sectors/:id  { name, color? }
router.put(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = await db.get("SELECT * FROM sectors WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Setor não encontrado" });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Informe o nome do setor" });
    const color = req.body?.color !== undefined ? parseColorOrNull(req.body.color) : existing.color;
    if (color === undefined) return res.status(400).json({ error: "Cor inválida (use o formato #RRGGBB)" });
    const dup = await db.get("SELECT id FROM sectors WHERE name = ? AND id != ?", [name, existing.id]);
    if (dup) return res.status(400).json({ error: "Já existe um setor com esse nome" });
    await db.run("UPDATE sectors SET name = ?, color = ? WHERE id = ?", [name, color, existing.id]);
    const members = await db.all("SELECT id FROM collaborators WHERE sector_id = ?", [existing.id]);
    res.json({ id: existing.id, name, color: color || undefined, memberIds: members.map((m) => m.id) });
  })
);

// DELETE /api/sectors/:id -> membros ficam sem setor (ON DELETE SET NULL), não apaga colaborador
router.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = await db.get("SELECT id FROM sectors WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Setor não encontrado" });
    await db.run("DELETE FROM sectors WHERE id = ?", [existing.id]);
    res.json({ ok: true });
  })
);

module.exports = router;
