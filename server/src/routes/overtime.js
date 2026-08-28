"use strict";

// Horas Extras — registro livre por colaborador (sem período/aprovação, ver
// server/sql/mysql_schema.sql). Cada lançamento é um intervalo de horário
// (início/fim, podendo cruzar a meia-noite) marcado num projeto; o 50%/100%
// é calculado no servidor via overtimeRules.js e guardado já pronto na
// linha, pra totais e exportação serem só uma soma.

const express = require("express");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin } = require("../auth");
const { getHolidaysForYear } = require("../holidays");
const {
  MINUTES_PER_DAY,
  addDaysISO,
  parseTimeToMinutes,
  minutesToClockLabel,
  classifyOvertimeMinutes,
} = require("../overtimeRules");

const router = express.Router();
router.use(requireAuth);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Mês/ano vindos da query string, com fallback pro mês/ano atuais do
// servidor — é isso que faz a tela sempre abrir no mês corrente sozinha,
// sem precisar guardar nenhum estado de "mês ativo".
function resolveMonthYear(query) {
  const now = new Date();
  const month = query.month != null && query.month !== "" ? Number(query.month) : now.getMonth() + 1;
  const year = query.year != null && query.year !== "" ? Number(query.year) : now.getFullYear();
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(year) || year < 2000) return null;
  return { month, year };
}

// [from, to) em formato ISO pra filtrar `date` por mês (comparação de string
// funciona porque "YYYY-MM-DD" é lexicograficamente ordenável).
function monthRange(month, year) {
  const from = `${year}-${pad2(month)}-01`;
  const to = month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`;
  return { from, to };
}

function toEpochDay(dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

// Domingo ou feriado nacional (feriados facultativos como Carnaval/Corpus
// Christi não contam — não são obrigação legal de folga). Monta o conjunto
// de feriados do ano da data e do ano seguinte, pra cobrir lançamentos que
// cruzem a virada de 31/12 pra 01/01.
function buildIsRestDay(year) {
  const holidayDates = new Set();
  for (const h of getHolidaysForYear(year)) if (!h.facultativo) holidayDates.add(h.date);
  for (const h of getHolidaysForYear(year + 1)) if (!h.facultativo) holidayDates.add(h.date);
  return (dateISO) => {
    if (holidayDates.has(dateISO)) return true;
    const [y, m, d] = dateISO.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
  };
}

function serializeEntry(row) {
  return {
    id: row.id,
    collaboratorId: row.collaborator_id,
    date: row.date,
    startTime: minutesToClockLabel(row.start_minutes),
    endTime: minutesToClockLabel(row.end_minutes),
    crossesMidnight: row.end_minutes > MINUTES_PER_DAY,
    projectName: row.project_name,
    hours50: round2(row.minutes_50 / 60),
    hours100: round2(row.minutes_100 / 60),
  };
}

// Impede lançar duas vezes a mesma hora (mesmo colaborador): busca
// lançamentos do dia anterior/mesmo dia/dia seguinte (um lançamento que
// cruzou a meia-noite tem `date` do dia em que começou, mas pode invadir o
// dia seguinte) e compara em minutos absolutos desde uma origem comum.
async function findOverlap(collaboratorId, dateISO, startMinutes, endMinutes, excludeId) {
  const dates = [addDaysISO(dateISO, -1), dateISO, addDaysISO(dateISO, 1)];
  const params = [collaboratorId, ...dates];
  let sql = "SELECT * FROM overtime_entries WHERE collaborator_id = ? AND date IN (?, ?, ?)";
  if (excludeId) {
    sql += " AND id != ?";
    params.push(excludeId);
  }
  const rows = await db.all(sql, params);
  const newStart = toEpochDay(dateISO) * MINUTES_PER_DAY + startMinutes;
  const newEnd = toEpochDay(dateISO) * MINUTES_PER_DAY + endMinutes;
  for (const r of rows) {
    const s = toEpochDay(r.date) * MINUTES_PER_DAY + r.start_minutes;
    const e = toEpochDay(r.date) * MINUTES_PER_DAY + r.end_minutes;
    if (newStart < e && s < newEnd) return r;
  }
  return null;
}

// Valida e monta os campos calculados de um lançamento a partir do corpo da
// requisição. Lança um erro com `.status` pra asyncHandler/handler devolver
// o código certo.
function buildEntryFields(body) {
  const date = String(body?.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const err = new Error("Data inválida");
    err.status = 400;
    throw err;
  }
  const startMinutes = parseTimeToMinutes(body?.startTime);
  let endMinutes = parseTimeToMinutes(body?.endTime);
  if (startMinutes == null || endMinutes == null) {
    const err = new Error("Horário inicial/final inválido");
    err.status = 400;
    throw err;
  }
  // Fim menor ou igual ao início = virou o dia (ex: 23:00 até 01:00) — não
  // precisa de checkbox separado na tela, é inferido pela própria digitação.
  if (endMinutes <= startMinutes) endMinutes += MINUTES_PER_DAY;
  if (endMinutes - startMinutes > MINUTES_PER_DAY) {
    const err = new Error("Um lançamento não pode passar de 24h — divida em mais de um lançamento");
    err.status = 400;
    throw err;
  }
  const projectName = String(body?.projectName || "").trim();
  if (!projectName) {
    const err = new Error("Informe o nome do projeto");
    err.status = 400;
    throw err;
  }

  const isRestDay = buildIsRestDay(Number(date.slice(0, 4)));
  const { minutes50, minutes100 } = classifyOvertimeMinutes(date, startMinutes, endMinutes, isRestDay);
  return { date, startMinutes, endMinutes, projectName, minutes50, minutes100 };
}

function requireOwnCollaborator(req, res) {
  if (!req.user.collaboratorId) {
    res.status(400).json({ error: "Sua conta não está vinculada a um colaborador — fale com o administrador" });
    return null;
  }
  return req.user.collaboratorId;
}

function findOwnedEntry(id, collaboratorId) {
  return db.get("SELECT * FROM overtime_entries WHERE id = ? AND collaborator_id = ?", [id, collaboratorId]);
}

// GET /api/overtime/entries?month=&year= -> lançamentos do próprio
// colaborador logado no mês, mais o totalizador do mês.
router.get(
  "/entries",
  asyncHandler(async (req, res) => {
    const collaboratorId = requireOwnCollaborator(req, res);
    if (!collaboratorId) return;
    const my = resolveMonthYear(req.query);
    if (!my) return res.status(400).json({ error: "Mês/ano inválidos" });

    const { from, to } = monthRange(my.month, my.year);
    const rows = await db.all(
      "SELECT * FROM overtime_entries WHERE collaborator_id = ? AND date >= ? AND date < ? ORDER BY date ASC, start_minutes ASC",
      [collaboratorId, from, to]
    );
    const entries = rows.map(serializeEntry);
    const totalMinutes50 = rows.reduce((sum, r) => sum + r.minutes_50, 0);
    const totalMinutes100 = rows.reduce((sum, r) => sum + r.minutes_100, 0);
    res.json({
      month: my.month,
      year: my.year,
      entries,
      totalHours50: round2(totalMinutes50 / 60),
      totalHours100: round2(totalMinutes100 / 60),
      totalHours: round2((totalMinutes50 + totalMinutes100) / 60),
    });
  })
);

// GET /api/overtime/projects -> nomes de projeto já usados pelo próprio
// colaborador (autocomplete), mesma ideia de GET /api/daily/projects.
router.get(
  "/projects",
  asyncHandler(async (req, res) => {
    const collaboratorId = requireOwnCollaborator(req, res);
    if (!collaboratorId) return;
    const rows = await db.all(
      "SELECT DISTINCT project_name FROM overtime_entries WHERE collaborator_id = ? ORDER BY project_name ASC",
      [collaboratorId]
    );
    res.json(rows.map((r) => r.project_name));
  })
);

// POST /api/overtime/entries { date, startTime, endTime, projectName }
router.post(
  "/entries",
  asyncHandler(async (req, res) => {
    const collaboratorId = requireOwnCollaborator(req, res);
    if (!collaboratorId) return;

    let fields;
    try {
      fields = buildEntryFields(req.body);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    const overlap = await findOverlap(collaboratorId, fields.date, fields.startMinutes, fields.endMinutes);
    if (overlap) return res.status(409).json({ error: "Esse horário já tem um lançamento" });

    const info = await db.run(
      `INSERT INTO overtime_entries
        (collaborator_id, date, start_minutes, end_minutes, project_name, minutes_50, minutes_100)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [collaboratorId, fields.date, fields.startMinutes, fields.endMinutes, fields.projectName, fields.minutes50, fields.minutes100]
    );
    const row = await db.get("SELECT * FROM overtime_entries WHERE id = ?", [Number(info.lastInsertRowid)]);
    res.status(201).json(serializeEntry(row));
  })
);

// PATCH /api/overtime/entries/:id { date, startTime, endTime, projectName }
router.patch(
  "/entries/:id",
  asyncHandler(async (req, res) => {
    const collaboratorId = requireOwnCollaborator(req, res);
    if (!collaboratorId) return;
    const existing = await findOwnedEntry(req.params.id, collaboratorId);
    if (!existing) return res.status(404).json({ error: "Lançamento não encontrado" });

    let fields;
    try {
      fields = buildEntryFields(req.body);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    const overlap = await findOverlap(collaboratorId, fields.date, fields.startMinutes, fields.endMinutes, existing.id);
    if (overlap) return res.status(409).json({ error: "Esse horário já tem um lançamento" });

    await db.run(
      `UPDATE overtime_entries
       SET date = ?, start_minutes = ?, end_minutes = ?, project_name = ?, minutes_50 = ?, minutes_100 = ?
       WHERE id = ?`,
      [fields.date, fields.startMinutes, fields.endMinutes, fields.projectName, fields.minutes50, fields.minutes100, existing.id]
    );
    const row = await db.get("SELECT * FROM overtime_entries WHERE id = ?", [existing.id]);
    res.json(serializeEntry(row));
  })
);

// DELETE /api/overtime/entries/:id
router.delete(
  "/entries/:id",
  asyncHandler(async (req, res) => {
    const collaboratorId = requireOwnCollaborator(req, res);
    if (!collaboratorId) return;
    const existing = await findOwnedEntry(req.params.id, collaboratorId);
    if (!existing) return res.status(404).json({ error: "Lançamento não encontrado" });
    await db.run("DELETE FROM overtime_entries WHERE id = ?", [existing.id]);
    res.json({ ok: true });
  })
);

// GET /api/overtime/admin/summary?month=&year= -> total de cada colaborador
// que teve hora extra no mês (admin only).
router.get(
  "/admin/summary",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const my = resolveMonthYear(req.query);
    if (!my) return res.status(400).json({ error: "Mês/ano inválidos" });
    const { from, to } = monthRange(my.month, my.year);
    const rows = await db.all(
      `SELECT oe.collaborator_id AS collaboratorId, c.name AS name,
              SUM(oe.minutes_50) AS minutes50, SUM(oe.minutes_100) AS minutes100
       FROM overtime_entries oe
       JOIN collaborators c ON c.id = oe.collaborator_id
       WHERE oe.date >= ? AND oe.date < ?
       GROUP BY oe.collaborator_id, c.name
       ORDER BY c.name ASC`,
      [from, to]
    );
    const collaborators = rows.map((r) => ({
      collaboratorId: r.collaboratorId,
      name: r.name,
      hours50: round2(r.minutes50 / 60),
      hours100: round2(r.minutes100 / 60),
      hoursTotal: round2((Number(r.minutes50) + Number(r.minutes100)) / 60),
    }));
    const totalHours50 = round2(collaborators.reduce((sum, c) => sum + c.hours50, 0));
    const totalHours100 = round2(collaborators.reduce((sum, c) => sum + c.hours100, 0));
    res.json({
      month: my.month,
      year: my.year,
      collaborators,
      totalHours50,
      totalHours100,
      totalHours: round2(totalHours50 + totalHours100),
    });
  })
);

// GET /api/overtime/admin/entries?month=&year= -> todos os lançamentos do
// mês com nome do colaborador (admin only) — usado pra montar a planilha.
router.get(
  "/admin/entries",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const my = resolveMonthYear(req.query);
    if (!my) return res.status(400).json({ error: "Mês/ano inválidos" });
    const { from, to } = monthRange(my.month, my.year);
    const rows = await db.all(
      `SELECT oe.*, c.name AS collaborator_name
       FROM overtime_entries oe
       JOIN collaborators c ON c.id = oe.collaborator_id
       WHERE oe.date >= ? AND oe.date < ?
       ORDER BY c.name ASC, oe.date ASC, oe.start_minutes ASC`,
      [from, to]
    );
    res.json(
      rows.map((r) => ({
        ...serializeEntry(r),
        collaboratorName: r.collaborator_name,
      }))
    );
  })
);

module.exports = router;
