"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin } = require("../auth");
const { getHolidaysForMonth } = require("../holidays");
const { weekdaysOfMonth } = require("../dateUtils");
const { weeklyQuotaForDate, isoWeekKey, sectorMaxHO } = require("../homeOfficeRules");

const router = express.Router();
router.use(requireAuth);

// ho_periods.month é 0-indexado (igual releases.month) — weekdaysOfMonth e
// getHolidaysForMonth esperam 1-12 (igual daily_periods.month), daí o +1 aqui.
function businessDaysOfPeriod(year, month0) {
  const month1 = month0 + 1;
  const holidays = new Set(getHolidaysForMonth(year, month1).map((h) => h.date));
  return weekdaysOfMonth(year, month1).filter((d) => !holidays.has(d));
}

function isDateInPeriod(dateStr, period) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return false;
  const [y, m] = dateStr.split("-").map(Number);
  return y === period.year && m - 1 === period.month;
}

// Monta o payload completo de um período: dias úteis do mês, Reuniões Gerais,
// e as entradas/dias especiais de TODOS os colaboradores (a escala é visível
// pra equipe inteira — diferente do Rateio Mensal, que restringe por dono).
async function loadPeriod(row) {
  const businessDays = businessDaysOfPeriod(row.year, row.month);
  const meetings = await db.all("SELECT id, date, title FROM ho_general_meetings WHERE period_id = ? ORDER BY date ASC", [
    row.id,
  ]);
  const entryRows = await db.all(
    "SELECT collaborator_id, date FROM ho_entries WHERE period_id = ? ORDER BY date ASC",
    [row.id]
  );
  const specialRows = await db.all(
    "SELECT id, collaborator_id, date, type FROM ho_special_days WHERE period_id = ? ORDER BY date ASC",
    [row.id]
  );

  const entriesByCollaborator = new Map();
  for (const e of entryRows) {
    if (!entriesByCollaborator.has(e.collaborator_id)) entriesByCollaborator.set(e.collaborator_id, []);
    entriesByCollaborator.get(e.collaborator_id).push(e.date);
  }

  return {
    id: row.id,
    month: row.month,
    year: row.year,
    status: row.status,
    deadline: row.deadline || "",
    approvedAt: row.approved_at || undefined,
    businessDays,
    generalMeetings: meetings.map((m) => ({ id: m.id, date: m.date, title: m.title || "" })),
    entries: [...entriesByCollaborator.entries()].map(([collaboratorId, dates]) => ({ collaboratorId, dates })),
    specialDays: specialRows.map((s) => ({ id: s.id, collaboratorId: s.collaborator_id, date: s.date, type: s.type })),
  };
}

// GET /api/home-office/periods -> lista leve, igual releases
router.get(
  "/periods",
  asyncHandler(async (req, res) => {
    const rows = await db.all("SELECT id, month, year, status, deadline FROM ho_periods ORDER BY year ASC, month ASC");
    res.json(rows.map((r) => ({ id: r.id, month: r.month, year: r.year, status: r.status, deadline: r.deadline || "" })));
  })
);

// GET /api/home-office/current -> período aberto mais recente (ou null)
router.get(
  "/current",
  asyncHandler(async (req, res) => {
    const row = await db.get("SELECT * FROM ho_periods WHERE status = 'open' ORDER BY year DESC, month DESC LIMIT 1");
    res.json(row ? await loadPeriod(row) : null);
  })
);

// GET /api/home-office/periods/:id
router.get(
  "/periods/:id",
  asyncHandler(async (req, res) => {
    const row = await db.get("SELECT * FROM ho_periods WHERE id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "Período não encontrado" });
    res.json(await loadPeriod(row));
  })
);

// POST /api/home-office/periods  { month, year, deadline? }  (month 0-indexado)
router.post(
  "/periods",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const month = Number(req.body?.month);
    const year = Number(req.body?.year);
    if (!(month >= 0 && month <= 11) || !(year >= 2000)) {
      return res.status(400).json({ error: "Mês/ano inválidos" });
    }
    const existing = await db.get("SELECT id FROM ho_periods WHERE month = ? AND year = ?", [month, year]);
    if (existing) return res.status(400).json({ error: "Já existe uma escala de Home Office para esse mês" });
    const deadline = req.body?.deadline ? String(req.body.deadline).trim() : "";
    const id = crypto.randomUUID();
    await db.run("INSERT INTO ho_periods (id, month, year, deadline, status) VALUES (?, ?, ?, ?, 'open')", [
      id,
      month,
      year,
      deadline,
    ]);
    const row = await db.get("SELECT * FROM ho_periods WHERE id = ?", [id]);
    res.status(201).json(await loadPeriod(row));
  })
);

// PATCH /api/home-office/periods/:id  { deadline?, status? }
router.patch(
  "/periods/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = await db.get("SELECT * FROM ho_periods WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Período não encontrado" });
    const deadline = req.body?.deadline !== undefined ? String(req.body.deadline).trim() : existing.deadline;
    let status = existing.status;
    if (req.body?.status !== undefined) {
      if (!["open", "approved"].includes(req.body.status)) return res.status(400).json({ error: "Status inválido" });
      status = req.body.status;
    }
    if (status === "approved" && existing.status !== "approved") {
      await db.run("UPDATE ho_periods SET deadline = ?, status = ?, approved_at = NOW() WHERE id = ?", [
        deadline,
        status,
        existing.id,
      ]);
    } else if (status === "open" && existing.status !== "open") {
      await db.run("UPDATE ho_periods SET deadline = ?, status = ?, approved_at = NULL WHERE id = ?", [
        deadline,
        status,
        existing.id,
      ]);
    } else {
      await db.run("UPDATE ho_periods SET deadline = ? WHERE id = ?", [deadline, existing.id]);
    }
    const row = await db.get("SELECT * FROM ho_periods WHERE id = ?", [existing.id]);
    res.json(await loadPeriod(row));
  })
);

// POST /api/home-office/periods/:id/meetings  { date, title? } -> Reunião Geral (empresa inteira)
router.post(
  "/periods/:id/meetings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const period = await db.get("SELECT * FROM ho_periods WHERE id = ?", [req.params.id]);
    if (!period) return res.status(404).json({ error: "Período não encontrado" });
    if (period.status !== "open") return res.status(403).json({ error: "Este período já foi aprovado" });
    const date = String(req.body?.date || "");
    if (!isDateInPeriod(date, period)) return res.status(400).json({ error: "Data inválida para este período" });
    const dup = await db.get("SELECT id FROM ho_general_meetings WHERE period_id = ? AND date = ?", [period.id, date]);
    if (dup) return res.status(400).json({ error: "Já existe uma reunião geral nesta data" });
    const title = req.body?.title ? String(req.body.title).trim() : "";
    const info = await db.run("INSERT INTO ho_general_meetings (period_id, date, title) VALUES (?, ?, ?)", [
      period.id,
      date,
      title,
    ]);
    // Reunião Geral bloqueia HO pra empresa inteira nesse dia — limpa quem já tinha marcado.
    const affected = await db.all("SELECT DISTINCT collaborator_id FROM ho_entries WHERE period_id = ? AND date = ?", [
      period.id,
      date,
    ]);
    await db.run("DELETE FROM ho_entries WHERE period_id = ? AND date = ?", [period.id, date]);
    res.status(201).json({
      id: Number(info.lastInsertRowid),
      date,
      title,
      affectedCollaboratorIds: affected.map((r) => r.collaborator_id),
    });
  })
);

// DELETE /api/home-office/meetings/:meetingId
router.delete(
  "/meetings/:meetingId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const meeting = await db.get(
      `SELECT m.*, p.status AS period_status FROM ho_general_meetings m
       JOIN ho_periods p ON p.id = m.period_id WHERE m.id = ?`,
      [req.params.meetingId]
    );
    if (!meeting) return res.status(404).json({ error: "Reunião não encontrada" });
    if (meeting.period_status !== "open") return res.status(403).json({ error: "Este período já foi aprovado" });
    await db.run("DELETE FROM ho_general_meetings WHERE id = ?", [meeting.id]);
    res.json({ ok: true });
  })
);

// POST /api/home-office/periods/:id/special-days  { collaboratorId, date, type }  Férias/Dayoff
router.post(
  "/periods/:id/special-days",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const period = await db.get("SELECT * FROM ho_periods WHERE id = ?", [req.params.id]);
    if (!period) return res.status(404).json({ error: "Período não encontrado" });
    if (period.status !== "open") return res.status(403).json({ error: "Este período já foi aprovado" });
    const { collaboratorId, date, type } = req.body || {};
    if (!["ferias", "dayoff"].includes(type)) return res.status(400).json({ error: "Tipo inválido" });
    if (!isDateInPeriod(date, period)) return res.status(400).json({ error: "Data inválida para este período" });
    const collaborator = await db.get("SELECT id FROM collaborators WHERE id = ?", [collaboratorId]);
    if (!collaborator) return res.status(400).json({ error: "Colaborador não encontrado" });
    // Substitui o outro tipo se já existir na mesma data (mutuamente exclusivo), e
    // limpa qualquer HO já marcado nesse dia (não pode estar de férias e de HO).
    await db.run("DELETE FROM ho_special_days WHERE period_id = ? AND collaborator_id = ? AND date = ?", [
      period.id,
      collaboratorId,
      date,
    ]);
    await db.run("DELETE FROM ho_entries WHERE period_id = ? AND collaborator_id = ? AND date = ?", [
      period.id,
      collaboratorId,
      date,
    ]);
    const info = await db.run("INSERT INTO ho_special_days (period_id, collaborator_id, date, type) VALUES (?, ?, ?, ?)", [
      period.id,
      collaboratorId,
      date,
      type,
    ]);
    res.status(201).json({ id: Number(info.lastInsertRowid), collaboratorId, date, type });
  })
);

// DELETE /api/home-office/special-days/:id
router.delete(
  "/special-days/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const special = await db.get(
      `SELECT s.*, p.status AS period_status FROM ho_special_days s
       JOIN ho_periods p ON p.id = s.period_id WHERE s.id = ?`,
      [req.params.id]
    );
    if (!special) return res.status(404).json({ error: "Registro não encontrado" });
    if (special.period_status !== "open") return res.status(403).json({ error: "Este período já foi aprovado" });
    await db.run("DELETE FROM ho_special_days WHERE id = ?", [special.id]);
    res.json({ ok: true });
  })
);

// Confere se quem está chamando pode mexer nos dias desse colaborador nesse
// período (dono, ou admin) e devolve os registros já carregados. Escreve a
// resposta de erro direto em `res` e devolve null quando o acesso é negado —
// quem chama só precisa checar `if (!ctx) return;`.
async function requireEntryAccess(req, res, periodId, collaboratorId) {
  const period = await db.get("SELECT * FROM ho_periods WHERE id = ?", [periodId]);
  if (!period) {
    res.status(404).json({ error: "Período não encontrado" });
    return null;
  }
  if (period.status !== "open") {
    res.status(403).json({ error: "Este período já foi aprovado e não pode mais ser editado" });
    return null;
  }
  if (req.user.role !== "admin" && req.user.collaboratorId !== collaboratorId) {
    res.status(403).json({ error: "Você só pode marcar seus próprios dias de home office" });
    return null;
  }
  const collaborator = await db.get("SELECT * FROM collaborators WHERE id = ?", [collaboratorId]);
  if (!collaborator) {
    res.status(404).json({ error: "Colaborador não encontrado" });
    return null;
  }
  return { period, collaborator };
}

// POST /api/home-office/periods/:id/entries  { collaboratorId, date } -> liga home office
router.post(
  "/periods/:id/entries",
  asyncHandler(async (req, res) => {
    const { collaboratorId, date } = req.body || {};
    const ctx = await requireEntryAccess(req, res, req.params.id, collaboratorId);
    if (!ctx) return;
    const { period, collaborator } = ctx;

    if (!isDateInPeriod(date, period)) return res.status(400).json({ error: "Data inválida para este período" });
    const businessDays = new Set(businessDaysOfPeriod(period.year, period.month));
    if (!businessDays.has(date)) return res.status(400).json({ error: "Este dia não é um dia útil" });

    const special = await db.get(
      "SELECT type FROM ho_special_days WHERE period_id = ? AND collaborator_id = ? AND date = ?",
      [period.id, collaboratorId, date]
    );
    if (special) {
      return res.status(400).json({
        error: special.type === "ferias" ? "Este dia está marcado como férias" : "Este dia está marcado como day off",
      });
    }

    const meeting = await db.get("SELECT id FROM ho_general_meetings WHERE period_id = ? AND date = ?", [period.id, date]);
    if (meeting) return res.status(400).json({ error: "Não é possível marcar home office: há uma Reunião Geral nesta data" });

    // Se já existe (duplo clique), a resposta abaixo só confirma o estado atual —
    // não roda de novo as checagens de cota/capacidade sobre um dia já aceito.
    const existingEntry = await db.get(
      "SELECT id FROM ho_entries WHERE period_id = ? AND collaborator_id = ? AND date = ?",
      [period.id, collaboratorId, date]
    );

    const quota = weeklyQuotaForDate(collaborator.hire_date, date);
    const weekKey = isoWeekKey(date);
    const collaboratorEntries = await db.all(
      "SELECT date FROM ho_entries WHERE period_id = ? AND collaborator_id = ?",
      [period.id, collaboratorId]
    );
    const usedThisWeek = collaboratorEntries.filter((e) => isoWeekKey(e.date) === weekKey).length;

    if (!existingEntry && usedThisWeek >= quota) {
      const msg =
        quota === 0
          ? "Você ainda não completou 1 mês de casa e não tem direito a home office"
          : `Você já atingiu o limite de dias de home office desta semana (${quota})`;
      return res.status(400).json({ error: msg });
    }

    if (!collaborator.sector_id) {
      return res.status(400).json({ error: "Cadastre um setor para este colaborador antes de liberar home office" });
    }
    const sector = await db.get("SELECT * FROM sectors WHERE id = ?", [collaborator.sector_id]);
    const activeMembers = await db.all("SELECT id FROM collaborators WHERE sector_id = ? AND active = 1", [
      collaborator.sector_id,
    ]);
    const maxHO = sectorMaxHO(activeMembers.length);
    const sectorUsedRows = await db.all(
      `SELECT DISTINCT e.collaborator_id FROM ho_entries e
       JOIN collaborators c ON c.id = e.collaborator_id
       WHERE e.period_id = ? AND e.date = ? AND c.sector_id = ? AND c.active = 1`,
      [period.id, date, collaborator.sector_id]
    );
    const sectorUsed = sectorUsedRows.length; // já inclui a própria pessoa se existingEntry for verdadeiro

    if (!existingEntry && sectorUsed >= maxHO) {
      return res.status(409).json({
        error: `Não há mais vagas de home office no setor ${sector ? sector.name : ""} neste dia (${sectorUsed}/${maxHO})`,
      });
    }

    if (!existingEntry) {
      await db.run("INSERT INTO ho_entries (period_id, collaborator_id, date) VALUES (?, ?, ?)", [
        period.id,
        collaboratorId,
        date,
      ]);
    }

    res.status(existingEntry ? 200 : 201).json({
      collaboratorId,
      date,
      on: true,
      sector: { id: collaborator.sector_id, used: existingEntry ? sectorUsed : sectorUsed + 1, max: maxHO },
      weekly: { weekKey, used: existingEntry ? usedThisWeek : usedThisWeek + 1, quota },
    });
  })
);

// DELETE /api/home-office/periods/:id/entries/:collaboratorId/:date -> desliga home office
// (sem checagem de regra: desmarcar só libera vaga, nunca viola nada)
router.delete(
  "/periods/:id/entries/:collaboratorId/:date",
  asyncHandler(async (req, res) => {
    const { collaboratorId, date } = req.params;
    const ctx = await requireEntryAccess(req, res, req.params.id, collaboratorId);
    if (!ctx) return;
    await db.run("DELETE FROM ho_entries WHERE period_id = ? AND collaborator_id = ? AND date = ?", [
      ctx.period.id,
      collaboratorId,
      date,
    ]);
    res.json({ collaboratorId, date, on: false });
  })
);

module.exports = router;
