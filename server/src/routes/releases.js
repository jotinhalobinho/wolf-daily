"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAuth);

const UNITS = ["wolf", "fraga", "woncred", "profit"];

function blankEntry(collaboratorId) {
  return {
    collaboratorId,
    unitProjects: { wolf: [], fraga: [], woncred: [], profit: [] },
    generalProjects: [],
    atestados: [],
    observations: "",
    submitted: false,
  };
}

function loadEntry(entryRow) {
  const items = db.prepare("SELECT unit, name, days, operations FROM rateio_entry_items WHERE entry_id = ?").all(entryRow.id);
  const entry = {
    collaboratorId: entryRow.collaborator_id,
    unitProjects: { wolf: [], fraga: [], woncred: [], profit: [] },
    generalProjects: [],
    atestados: [],
    observations: entryRow.observations || "",
    submitted: !!entryRow.submitted,
  };
  for (const it of items) {
    let operations;
    if (it.operations) {
      try { operations = JSON.parse(it.operations); } catch { operations = undefined; }
    }
    const p = operations && operations.length ? { name: it.name, days: it.days, operations } : { name: it.name, days: it.days };
    if (it.unit === "atestado") entry.atestados.push(p);
    else if (it.unit && UNITS.includes(it.unit)) entry.unitProjects[it.unit].push(p);
    else entry.generalProjects.push(p);
  }
  return entry;
}

function loadRelease(releaseRow, restrictToCollaboratorId) {
  let entryRows;
  if (restrictToCollaboratorId) {
    entryRows = db
      .prepare("SELECT * FROM rateio_entries WHERE release_id = ? AND collaborator_id = ?")
      .all(releaseRow.id, restrictToCollaboratorId);
  } else {
    entryRows = db.prepare("SELECT * FROM rateio_entries WHERE release_id = ?").all(releaseRow.id);
  }
  return {
    id: releaseRow.id,
    month: releaseRow.month,
    year: releaseRow.year,
    workingDays: releaseRow.working_days,
    deadline: releaseRow.deadline || "",
    status: releaseRow.status,
    approvedAt: releaseRow.approved_at || undefined,
    entries: entryRows.map(loadEntry),
  };
}

// GET /api/releases
router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM releases ORDER BY year ASC, month ASC").all();
  const restrict = req.user.role === "admin" ? null : req.user.collaboratorId;
  res.json(rows.map((r) => loadRelease(r, restrict)));
});

// POST /api/releases  { id?, month, year, workingDays, deadline }  (admin)
router.post("/", requireAdmin, (req, res) => {
  const b = req.body || {};
  const workingDays = Number(b.workingDays);
  if (!(workingDays > 0) || b.month == null || b.year == null) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
  const id = b.id && String(b.id).trim() ? String(b.id).trim() : crypto.randomUUID();
  const existing = db.prepare("SELECT id FROM releases WHERE id = ?").get(id);
  if (existing) return res.status(400).json({ error: "Identificador já utilizado" });

  db.prepare(
    "INSERT INTO releases (id, month, year, working_days, deadline, status) VALUES (?, ?, ?, ?, ?, 'open')"
  ).run(id, Number(b.month), Number(b.year), workingDays, b.deadline || "");

  // Pre-create a blank entry for every current collaborator (mirrors original behavior).
  const collaborators = db.prepare("SELECT id FROM collaborators").all();
  const insertEntry = db.prepare(
    "INSERT INTO rateio_entries (release_id, collaborator_id, observations, submitted) VALUES (?, ?, '', 0)"
  );
  for (const c of collaborators) insertEntry.run(id, c.id);

  const row = db.prepare("SELECT * FROM releases WHERE id = ?").get(id);
  res.status(201).json(loadRelease(row, null));
});

// PATCH /api/releases/:id  { workingDays?, deadline?, status? }  (admin)
router.patch("/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const row = db.prepare("SELECT * FROM releases WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Período não encontrado" });
  const b = req.body || {};
  const workingDays = b.workingDays != null ? Number(b.workingDays) : row.working_days;
  const deadline = b.deadline != null ? String(b.deadline) : row.deadline;
  let status = row.status;
  let approvedAt = row.approved_at;
  if (b.status === "approved" && row.status !== "approved") {
    status = "approved";
    approvedAt = new Date().toISOString();
  } else if (b.status === "open") {
    status = "open";
    approvedAt = null;
  }
  db.prepare("UPDATE releases SET working_days=?, deadline=?, status=?, approved_at=? WHERE id=?").run(
    workingDays,
    deadline,
    status,
    approvedAt,
    id
  );
  const updated = db.prepare("SELECT * FROM releases WHERE id = ?").get(id);
  res.json(loadRelease(updated, null));
});

// PUT /api/releases/:releaseId/entries/:collaboratorId
// body: { unitProjects, generalProjects, observations, submitted }
router.put("/:releaseId/entries/:collaboratorId", (req, res) => {
  const { releaseId, collaboratorId } = req.params;
  const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(releaseId);
  if (!release) return res.status(404).json({ error: "Período não encontrado" });

  const isAdmin = req.user.role === "admin";
  if (!isAdmin) {
    if (req.user.collaboratorId !== collaboratorId) {
      return res.status(403).json({ error: "Você só pode preencher o seu próprio rateio" });
    }
    if (release.status !== "open") {
      return res.status(403).json({ error: "Este período já foi aprovado e não pode mais ser editado" });
    }
  }

  const collaborator = db.prepare("SELECT id FROM collaborators WHERE id = ?").get(collaboratorId);
  if (!collaborator) return res.status(404).json({ error: "Colaborador não encontrado" });

  const b = req.body || {};
  const observations = String(b.observations || "");
  const submitted = b.submitted ? 1 : 0;

  let entryRow = db
    .prepare("SELECT * FROM rateio_entries WHERE release_id = ? AND collaborator_id = ?")
    .get(releaseId, collaboratorId);

  if (!entryRow) {
    const info = db
      .prepare("INSERT INTO rateio_entries (release_id, collaborator_id, observations, submitted) VALUES (?, ?, ?, ?)")
      .run(releaseId, collaboratorId, observations, submitted);
    entryRow = { id: Number(info.lastInsertRowid) };
  } else {
    db.prepare("UPDATE rateio_entries SET observations = ?, submitted = ? WHERE id = ?").run(
      observations,
      submitted,
      entryRow.id
    );
  }

  db.prepare("DELETE FROM rateio_entry_items WHERE entry_id = ?").run(entryRow.id);
  const insertItem = db.prepare("INSERT INTO rateio_entry_items (entry_id, unit, name, days, operations) VALUES (?, ?, ?, ?, ?)");
  const VALID_TAGS = new Set(["HS", "NC", "NAS", "ALL"]);
  const serializeOps = (p) => {
    if (!Array.isArray(p.operations)) return null;
    const clean = p.operations.filter((t) => VALID_TAGS.has(t));
    return clean.length ? JSON.stringify(clean) : null;
  };
  const unitProjects = b.unitProjects || {};
  for (const u of UNITS) {
    for (const p of unitProjects[u] || []) {
      if (!p || !p.name) continue;
      // Tags de operação só fazem sentido para o centro de custo "fraga".
      insertItem.run(entryRow.id, u, String(p.name), Math.max(0, Math.round(Number(p.days) || 0)), u === "fraga" ? serializeOps(p) : null);
    }
  }
  for (const p of b.generalProjects || []) {
    if (!p || !p.name) continue;
    insertItem.run(entryRow.id, null, String(p.name), Math.max(0, Math.round(Number(p.days) || 0)), null);
  }
  for (const p of b.atestados || []) {
    if (!p || !p.name) continue;
    insertItem.run(entryRow.id, "atestado", String(p.name), Math.max(0, Math.round(Number(p.days) || 0)), null);
  }

  const fresh = db.prepare("SELECT * FROM rateio_entries WHERE id = ?").get(entryRow.id);
  res.json(loadEntry(fresh));
});

module.exports = router;
