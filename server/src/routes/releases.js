"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin } = require("../auth");
const { buildDailySuggestion } = require("./daily");

const router = express.Router();
router.use(requireAuth);

const UNITS = ["wolf", "fraga", "woncred", "profit"];
const VALID_TAGS = new Set(["HS", "NC", "NAS", "ALL"]);

function blankEntry(collaboratorId) {
  return {
    collaboratorId,
    unitProjects: { wolf: [], fraga: [], woncred: [], profit: [] },
    generalProjects: [],
    atestados: [],
    dayOffs: [],
    observations: "",
    submitted: false,
  };
}

async function loadEntry(entryRow) {
  const items = await db.all(
    "SELECT unit, name, days, operations FROM rateio_entry_items WHERE entry_id = ?",
    [entryRow.id]
  );
  const entry = {
    collaboratorId: entryRow.collaborator_id,
    unitProjects: { wolf: [], fraga: [], woncred: [], profit: [] },
    generalProjects: [],
    atestados: [],
    dayOffs: [],
    observations: entryRow.observations || "",
    submitted: !!entryRow.submitted,
  };
  for (const it of items) {
    let operations;
    if (it.operations) {
      try {
        operations = JSON.parse(it.operations);
      } catch {
        operations = undefined;
      }
    }
    const p =
      operations && operations.length ? { name: it.name, days: it.days, operations } : { name: it.name, days: it.days };
    if (it.unit === "atestado") entry.atestados.push(p);
    else if (it.unit === "dayoff") entry.dayOffs.push(p);
    else if (it.unit && UNITS.includes(it.unit)) entry.unitProjects[it.unit].push(p);
    else entry.generalProjects.push(p);
  }
  return entry;
}

async function loadRelease(releaseRow, restrictToCollaboratorId) {
  let entryRows;
  if (restrictToCollaboratorId) {
    entryRows = await db.all("SELECT * FROM rateio_entries WHERE release_id = ? AND collaborator_id = ?", [
      releaseRow.id,
      restrictToCollaboratorId,
    ]);
  } else {
    entryRows = await db.all("SELECT * FROM rateio_entries WHERE release_id = ?", [releaseRow.id]);
  }
  return {
    id: releaseRow.id,
    month: releaseRow.month,
    year: releaseRow.year,
    workingDays: releaseRow.working_days,
    deadline: releaseRow.deadline || "",
    status: releaseRow.status,
    approvedAt: releaseRow.approved_at || undefined,
    entries: await Promise.all(entryRows.map(loadEntry)),
  };
}

// GET /api/releases
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await db.all("SELECT * FROM releases ORDER BY year ASC, month ASC");
    const restrict = req.user.role === "admin" ? null : req.user.collaboratorId;
    const releases = await Promise.all(rows.map((r) => loadRelease(r, restrict)));
    res.json(releases);
  })
);

// POST /api/releases  { id?, month, year, workingDays, deadline }  (admin)
router.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const workingDays = Number(b.workingDays);
    if (!(workingDays > 0) || b.month == null || b.year == null) {
      return res.status(400).json({ error: "Dados inválidos" });
    }
    const id = b.id && String(b.id).trim() ? String(b.id).trim() : crypto.randomUUID();
    const existing = await db.get("SELECT id FROM releases WHERE id = ?", [id]);
    if (existing) return res.status(400).json({ error: "Identificador já utilizado" });

    await db.run(
      "INSERT INTO releases (id, month, year, working_days, deadline, status) VALUES (?, ?, ?, ?, ?, 'open')",
      [id, Number(b.month), Number(b.year), workingDays, b.deadline || ""]
    );

    // Pre-create a blank entry for every current collaborator (mirrors original behavior).
    const collaborators = await db.all("SELECT id FROM collaborators");
    for (const c of collaborators) {
      await db.run(
        "INSERT INTO rateio_entries (release_id, collaborator_id, observations, submitted) VALUES (?, ?, '', 0)",
        [id, c.id]
      );
    }

    const row = await db.get("SELECT * FROM releases WHERE id = ?", [id]);
    res.status(201).json(await loadRelease(row, null));
  })
);

// PATCH /api/releases/:id  { workingDays?, deadline?, status? }  (admin)
router.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const row = await db.get("SELECT * FROM releases WHERE id = ?", [id]);
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
    await db.run("UPDATE releases SET working_days=?, deadline=?, status=?, approved_at=? WHERE id=?", [
      workingDays,
      deadline,
      status,
      approvedAt,
      id,
    ]);
    const updated = await db.get("SELECT * FROM releases WHERE id = ?", [id]);
    res.json(await loadRelease(updated, null));
  })
);

// PUT /api/releases/:releaseId/entries/:collaboratorId
// body: { unitProjects, generalProjects, observations, submitted }
router.put(
  "/:releaseId/entries/:collaboratorId",
  asyncHandler(async (req, res) => {
    const { releaseId, collaboratorId } = req.params;
    const release = await db.get("SELECT * FROM releases WHERE id = ?", [releaseId]);
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

    const collaborator = await db.get("SELECT id FROM collaborators WHERE id = ?", [collaboratorId]);
    if (!collaborator) return res.status(404).json({ error: "Colaborador não encontrado" });

    const b = req.body || {};
    const observations = String(b.observations || "");
    const submitted = b.submitted ? 1 : 0;

    let entryRow = await db.get("SELECT * FROM rateio_entries WHERE release_id = ? AND collaborator_id = ?", [
      releaseId,
      collaboratorId,
    ]);

    if (!entryRow) {
      const info = await db.run(
        "INSERT INTO rateio_entries (release_id, collaborator_id, observations, submitted) VALUES (?, ?, ?, ?)",
        [releaseId, collaboratorId, observations, submitted]
      );
      entryRow = { id: Number(info.lastInsertRowid) };
    } else {
      await db.run("UPDATE rateio_entries SET observations = ?, submitted = ? WHERE id = ?", [
        observations,
        submitted,
        entryRow.id,
      ]);
    }

    await db.run("DELETE FROM rateio_entry_items WHERE entry_id = ?", [entryRow.id]);
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
        await db.run(
          "INSERT INTO rateio_entry_items (entry_id, unit, name, days, operations) VALUES (?, ?, ?, ?, ?)",
          [entryRow.id, u, String(p.name), Math.max(0, Math.round(Number(p.days) || 0)), u === "fraga" ? serializeOps(p) : null]
        );
      }
    }
    for (const p of b.generalProjects || []) {
      if (!p || !p.name) continue;
      await db.run(
        "INSERT INTO rateio_entry_items (entry_id, unit, name, days, operations) VALUES (?, ?, ?, ?, ?)",
        [entryRow.id, null, String(p.name), Math.max(0, Math.round(Number(p.days) || 0)), null]
      );
    }
    for (const p of b.atestados || []) {
      if (!p || !p.name) continue;
      await db.run(
        "INSERT INTO rateio_entry_items (entry_id, unit, name, days, operations) VALUES (?, ?, ?, ?, ?)",
        [entryRow.id, "atestado", String(p.name), Math.max(0, Math.round(Number(p.days) || 0)), null]
      );
    }
    for (const p of b.dayOffs || []) {
      if (!p || !p.name) continue;
      await db.run(
        "INSERT INTO rateio_entry_items (entry_id, unit, name, days, operations) VALUES (?, ?, ?, ?, ?)",
        [entryRow.id, "dayoff", String(p.name), Math.max(0, Math.round(Number(p.days) || 0)), null]
      );
    }

    const fresh = await db.get("SELECT * FROM rateio_entries WHERE id = ?", [entryRow.id]);
    res.json(await loadEntry(fresh));
  })
);

// GET /api/releases/:releaseId/entries/:collaboratorId/daily-suggestion
// -> sugestão de preenchimento a partir do que já foi lançado no Rateio
// Diário desse colaborador no mesmo mês/ano do período (não altera nada, só sugere).
router.get(
  "/:releaseId/entries/:collaboratorId/daily-suggestion",
  asyncHandler(async (req, res) => {
    const { releaseId, collaboratorId } = req.params;
    const release = await db.get("SELECT * FROM releases WHERE id = ?", [releaseId]);
    if (!release) return res.status(404).json({ error: "Período não encontrado" });

    const isAdmin = req.user.role === "admin";
    if (!isAdmin && req.user.collaboratorId !== collaboratorId) {
      return res.status(403).json({ error: "Você só pode consultar o seu próprio rateio" });
    }

    const user = await db.get("SELECT id FROM users WHERE collaborator_id = ?", [collaboratorId]);
    if (!user) {
      return res.json({
        found: false,
        unitProjects: { wolf: [], fraga: [], woncred: [], profit: [] },
        generalProjects: [],
        atestados: [],
        dayOffs: [],
      });
    }

    // releases.month é 0-indexado (0 = Janeiro) na tela; daily_periods.month é 1-indexado.
    const suggestion = await buildDailySuggestion(user.id, release.month + 1, release.year);
    res.json(suggestion);
  })
);

module.exports = router;
