"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../auth");
const { getHolidaysForMonth } = require("../holidays");

const router = express.Router();
router.use(requireAuth);

const UNITS = ["wolf", "fraga", "woncred", "profit"];
const VALID_TAGS = new Set(["HS", "NC", "NAS", "ALL"]);

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Retorna as datas (YYYY-MM-DD) de segunda a sexta de um mês (month: 1-12).
function weekdaysOfMonth(year, month) {
  const dates = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month - 1, day);
    const weekday = d.getDay(); // 0=domingo, 6=sábado
    if (weekday !== 0 && weekday !== 6) {
      dates.push(`${year}-${pad2(month)}-${pad2(day)}`);
    }
  }
  return dates;
}

function nextMonth(month, year) {
  return month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };
}

function serializeOps(operations) {
  if (!Array.isArray(operations)) return null;
  const clean = operations.filter((t) => VALID_TAGS.has(t));
  return clean.length ? JSON.stringify(clean) : null;
}

function isBusinessDay(dayRow) {
  if (!dayRow.holiday_name) return true;
  return dayRow.holiday_override === 1;
}

function loadDay(dayRow) {
  const items = db
    .prepare("SELECT id, unit, project_name, operations FROM daily_day_items WHERE day_id = ? ORDER BY id ASC")
    .all(dayRow.id);
  return {
    id: dayRow.id,
    date: dayRow.date,
    holidayName: dayRow.holiday_name || null,
    holidayOverride: dayRow.holiday_override,
    isBusinessDay: isBusinessDay(dayRow),
    atestado: !!dayRow.atestado,
    items: items.map((it) => ({
      id: it.id,
      unit: it.unit,
      projectName: it.project_name,
      operations: it.operations ? JSON.parse(it.operations) : undefined,
    })),
  };
}

function loadPeriod(periodRow) {
  const days = db.prepare("SELECT * FROM daily_days WHERE period_id = ? ORDER BY date ASC").all(periodRow.id);
  return {
    id: periodRow.id,
    month: periodRow.month,
    year: periodRow.year,
    status: periodRow.status,
    createdAt: periodRow.created_at,
    closedAt: periodRow.closed_at || undefined,
    days: days.map(loadDay),
  };
}

function materializeDays(periodId, year, month) {
  const holidays = getHolidaysForMonth(year, month);
  const holidayByDate = new Map(holidays.map((h) => [h.date, h.name]));
  const insert = db.prepare(
    "INSERT INTO daily_days (period_id, date, holiday_name, holiday_override) VALUES (?, ?, ?, NULL)"
  );
  for (const date of weekdaysOfMonth(year, month)) {
    insert.run(periodId, date, holidayByDate.get(date) || null);
  }
}

function findOwnedPeriod(id, userId) {
  return db.prepare("SELECT * FROM daily_periods WHERE id = ? AND user_id = ?").get(id, userId);
}

// Localiza um dia garantindo que o período pertence ao usuário logado.
function findOwnedDay(dayId, userId) {
  return db
    .prepare(
      `SELECT dd.* FROM daily_days dd
       JOIN daily_periods dp ON dp.id = dd.period_id
       WHERE dd.id = ? AND dp.user_id = ?`
    )
    .get(dayId, userId);
}

function findOwnedItem(itemId, userId) {
  return db
    .prepare(
      `SELECT ddi.* FROM daily_day_items ddi
       JOIN daily_days dd ON dd.id = ddi.day_id
       JOIN daily_periods dp ON dp.id = dd.period_id
       WHERE ddi.id = ? AND dp.user_id = ?`
    )
    .get(itemId, userId);
}

// GET /api/daily/periods
router.get("/periods", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM daily_periods WHERE user_id = ? ORDER BY year ASC, month ASC")
    .all(req.user.id);
  res.json(rows.map((r) => ({ id: r.id, month: r.month, year: r.year, status: r.status })));
});

// GET /api/daily/current -> período aberto mais recente (ou null)
router.get("/current", (req, res) => {
  const row = db
    .prepare("SELECT * FROM daily_periods WHERE user_id = ? AND status = 'open' ORDER BY year DESC, month DESC LIMIT 1")
    .get(req.user.id);
  res.json(row ? loadPeriod(row) : null);
});

// GET /api/daily/periods/:id
router.get("/periods/:id", (req, res) => {
  const row = findOwnedPeriod(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: "Período não encontrado" });
  res.json(loadPeriod(row));
});

// GET /api/daily/projects -> projetos já usados, com os centros de custo
// historicamente ligados a cada um (autocomplete + sugestão de centro de custo)
router.get("/projects", (req, res) => {
  const rows = db
    .prepare(
      `SELECT ddi.project_name AS name, ddi.unit AS unit FROM daily_day_items ddi
       JOIN daily_days dd ON dd.id = ddi.day_id
       JOIN daily_periods dp ON dp.id = dd.period_id
       WHERE dp.user_id = ? ORDER BY ddi.project_name ASC`
    )
    .all(req.user.id);
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, new Set());
    byName.get(r.name).add(r.unit);
  }
  const result = [...byName.entries()].map(([name, set]) => ({
    name,
    units: UNITS.filter((u) => set.has(u)),
  }));
  res.json(result);
});

// POST /api/daily/periods  { month, year }
router.post("/periods", (req, res) => {
  const month = Number(req.body?.month);
  const year = Number(req.body?.year);
  if (!(month >= 1 && month <= 12) || !(year >= 2000)) {
    return res.status(400).json({ error: "Mês/ano inválidos" });
  }
  const existing = db
    .prepare("SELECT id FROM daily_periods WHERE user_id = ? AND month = ? AND year = ?")
    .get(req.user.id, month, year);
  if (existing) return res.status(400).json({ error: "Já existe um período para esse mês" });

  const id = crypto.randomUUID();
  db.prepare("INSERT INTO daily_periods (id, user_id, month, year, status) VALUES (?, ?, ?, ?, 'open')").run(
    id,
    req.user.id,
    month,
    year
  );
  materializeDays(id, year, month);
  const row = db.prepare("SELECT * FROM daily_periods WHERE id = ?").get(id);
  res.status(201).json(loadPeriod(row));
});

// POST /api/daily/periods/:id/advance -> fecha o período atual e abre o próximo mês
router.post("/periods/:id/advance", (req, res) => {
  const row = findOwnedPeriod(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: "Período não encontrado" });
  if (row.status !== "open") return res.status(400).json({ error: "Este período já está fechado" });

  db.prepare("UPDATE daily_periods SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(row.id);

  const { month, year } = nextMonth(row.month, row.year);
  let nextRow = db
    .prepare("SELECT * FROM daily_periods WHERE user_id = ? AND month = ? AND year = ?")
    .get(req.user.id, month, year);

  if (!nextRow) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO daily_periods (id, user_id, month, year, status) VALUES (?, ?, ?, ?, 'open')").run(
      id,
      req.user.id,
      month,
      year
    );
    materializeDays(id, year, month);
    nextRow = db.prepare("SELECT * FROM daily_periods WHERE id = ?").get(id);
  }

  res.json(loadPeriod(nextRow));
});

// PATCH /api/daily/days/:dayId  { atestado?, holidayOverride? }
router.patch("/days/:dayId", (req, res) => {
  const day = findOwnedDay(req.params.dayId, req.user.id);
  if (!day) return res.status(404).json({ error: "Dia não encontrado" });

  const period = db.prepare("SELECT status FROM daily_periods WHERE id = ?").get(day.period_id);
  if (period.status !== "open") return res.status(403).json({ error: "Este período já foi encerrado" });

  const b = req.body || {};
  const atestado = b.atestado != null ? (b.atestado ? 1 : 0) : day.atestado;
  let holidayOverride = day.holiday_override;
  if (b.holidayOverride != null) {
    if (!day.holiday_name) return res.status(400).json({ error: "Este dia não é feriado" });
    holidayOverride = b.holidayOverride ? 1 : 0;
  }

  db.prepare("UPDATE daily_days SET atestado = ?, holiday_override = ? WHERE id = ?").run(
    atestado,
    holidayOverride,
    day.id
  );

  if (atestado) {
    db.prepare("DELETE FROM daily_day_items WHERE day_id = ?").run(day.id);
  }

  const fresh = db.prepare("SELECT * FROM daily_days WHERE id = ?").get(day.id);
  res.json(loadDay(fresh));
});

// POST /api/daily/days/:dayId/items  { unit, projectName, operations? }
router.post("/days/:dayId/items", (req, res) => {
  const day = findOwnedDay(req.params.dayId, req.user.id);
  if (!day) return res.status(404).json({ error: "Dia não encontrado" });

  const period = db.prepare("SELECT status FROM daily_periods WHERE id = ?").get(day.period_id);
  if (period.status !== "open") return res.status(403).json({ error: "Este período já foi encerrado" });
  if (day.atestado) return res.status(400).json({ error: "Este dia está marcado como atestado" });
  if (!isBusinessDay(day)) return res.status(400).json({ error: "Este dia não está marcado como dia útil" });

  const b = req.body || {};
  const unit = String(b.unit || "");
  const projectName = String(b.projectName || "").trim();
  if (!UNITS.includes(unit)) return res.status(400).json({ error: "Centro de custo inválido" });
  if (!projectName) return res.status(400).json({ error: "Informe o nome do projeto" });

  const info = db
    .prepare("INSERT INTO daily_day_items (day_id, unit, project_name, operations) VALUES (?, ?, ?, ?)")
    .run(day.id, unit, projectName, unit === "fraga" ? serializeOps(b.operations) : null);

  const item = db.prepare("SELECT * FROM daily_day_items WHERE id = ?").get(Number(info.lastInsertRowid));
  res.status(201).json({
    id: item.id,
    unit: item.unit,
    projectName: item.project_name,
    operations: item.operations ? JSON.parse(item.operations) : undefined,
  });
});

// DELETE /api/daily/items/:itemId
router.delete("/items/:itemId", (req, res) => {
  const item = findOwnedItem(req.params.itemId, req.user.id);
  if (!item) return res.status(404).json({ error: "Lançamento não encontrado" });
  db.prepare("DELETE FROM daily_day_items WHERE id = ?").run(item.id);
  res.json({ ok: true });
});

module.exports = router;
