"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
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

async function loadDay(dayRow) {
  const items = await db.all(
    "SELECT id, unit, project_name, operations FROM daily_day_items WHERE day_id = ? ORDER BY id ASC",
    [dayRow.id]
  );
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

async function loadPeriod(periodRow) {
  const days = await db.all("SELECT * FROM daily_days WHERE period_id = ? ORDER BY date ASC", [periodRow.id]);
  return {
    id: periodRow.id,
    month: periodRow.month,
    year: periodRow.year,
    status: periodRow.status,
    createdAt: periodRow.created_at,
    closedAt: periodRow.closed_at || undefined,
    days: await Promise.all(days.map(loadDay)),
  };
}

async function materializeDays(periodId, year, month) {
  const holidays = getHolidaysForMonth(year, month);
  const holidayByDate = new Map(holidays.map((h) => [h.date, h.name]));
  for (const date of weekdaysOfMonth(year, month)) {
    await db.run(
      "INSERT INTO daily_days (period_id, date, holiday_name, holiday_override) VALUES (?, ?, ?, NULL)",
      [periodId, date, holidayByDate.get(date) || null]
    );
  }
}

function findOwnedPeriod(id, userId) {
  return db.get("SELECT * FROM daily_periods WHERE id = ? AND user_id = ?", [id, userId]);
}

// Localiza um dia garantindo que o período pertence ao usuário logado.
function findOwnedDay(dayId, userId) {
  return db.get(
    `SELECT dd.* FROM daily_days dd
     JOIN daily_periods dp ON dp.id = dd.period_id
     WHERE dd.id = ? AND dp.user_id = ?`,
    [dayId, userId]
  );
}

function findOwnedItem(itemId, userId) {
  return db.get(
    `SELECT ddi.* FROM daily_day_items ddi
     JOIN daily_days dd ON dd.id = ddi.day_id
     JOIN daily_periods dp ON dp.id = dd.period_id
     WHERE ddi.id = ? AND dp.user_id = ?`,
    [itemId, userId]
  );
}

// GET /api/daily/periods
router.get(
  "/periods",
  asyncHandler(async (req, res) => {
    const rows = await db.all("SELECT * FROM daily_periods WHERE user_id = ? ORDER BY year ASC, month ASC", [
      req.user.id,
    ]);
    res.json(rows.map((r) => ({ id: r.id, month: r.month, year: r.year, status: r.status })));
  })
);

// GET /api/daily/current -> período aberto mais recente (ou null)
router.get(
  "/current",
  asyncHandler(async (req, res) => {
    const row = await db.get(
      "SELECT * FROM daily_periods WHERE user_id = ? AND status = 'open' ORDER BY year DESC, month DESC LIMIT 1",
      [req.user.id]
    );
    res.json(row ? await loadPeriod(row) : null);
  })
);

// GET /api/daily/periods/:id
router.get(
  "/periods/:id",
  asyncHandler(async (req, res) => {
    const row = await findOwnedPeriod(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Período não encontrado" });
    res.json(await loadPeriod(row));
  })
);

// GET /api/daily/projects -> projetos já usados, com os centros de custo
// historicamente ligados a cada um (autocomplete + sugestão de centro de custo)
router.get(
  "/projects",
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT ddi.project_name AS name, ddi.unit AS unit FROM daily_day_items ddi
       JOIN daily_days dd ON dd.id = ddi.day_id
       JOIN daily_periods dp ON dp.id = dd.period_id
       WHERE dp.user_id = ? ORDER BY ddi.project_name ASC`,
      [req.user.id]
    );
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
  })
);

// POST /api/daily/periods  { month, year }
router.post(
  "/periods",
  asyncHandler(async (req, res) => {
    const month = Number(req.body?.month);
    const year = Number(req.body?.year);
    if (!(month >= 1 && month <= 12) || !(year >= 2000)) {
      return res.status(400).json({ error: "Mês/ano inválidos" });
    }
    const existing = await db.get("SELECT id FROM daily_periods WHERE user_id = ? AND month = ? AND year = ?", [
      req.user.id,
      month,
      year,
    ]);
    if (existing) return res.status(400).json({ error: "Já existe um período para esse mês" });

    const id = crypto.randomUUID();
    await db.run("INSERT INTO daily_periods (id, user_id, month, year, status) VALUES (?, ?, ?, ?, 'open')", [
      id,
      req.user.id,
      month,
      year,
    ]);
    await materializeDays(id, year, month);
    const row = await db.get("SELECT * FROM daily_periods WHERE id = ?", [id]);
    res.status(201).json(await loadPeriod(row));
  })
);

// POST /api/daily/periods/:id/advance -> fecha o período atual e abre o próximo mês
router.post(
  "/periods/:id/advance",
  asyncHandler(async (req, res) => {
    const row = await findOwnedPeriod(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Período não encontrado" });
    if (row.status !== "open") return res.status(400).json({ error: "Este período já está fechado" });

    await db.run("UPDATE daily_periods SET status = 'closed', closed_at = NOW() WHERE id = ?", [row.id]);

    const { month, year } = nextMonth(row.month, row.year);
    let nextRow = await db.get("SELECT * FROM daily_periods WHERE user_id = ? AND month = ? AND year = ?", [
      req.user.id,
      month,
      year,
    ]);

    if (!nextRow) {
      const id = crypto.randomUUID();
      await db.run("INSERT INTO daily_periods (id, user_id, month, year, status) VALUES (?, ?, ?, ?, 'open')", [
        id,
        req.user.id,
        month,
        year,
      ]);
      await materializeDays(id, year, month);
      nextRow = await db.get("SELECT * FROM daily_periods WHERE id = ?", [id]);
    }

    res.json(await loadPeriod(nextRow));
  })
);

// PATCH /api/daily/days/:dayId  { atestado?, holidayOverride? }
router.patch(
  "/days/:dayId",
  asyncHandler(async (req, res) => {
    const day = await findOwnedDay(req.params.dayId, req.user.id);
    if (!day) return res.status(404).json({ error: "Dia não encontrado" });

    const period = await db.get("SELECT status FROM daily_periods WHERE id = ?", [day.period_id]);
    if (period.status !== "open") return res.status(403).json({ error: "Este período já foi encerrado" });

    const b = req.body || {};
    const atestado = b.atestado != null ? (b.atestado ? 1 : 0) : day.atestado;
    let holidayOverride = day.holiday_override;
    if (b.holidayOverride != null) {
      if (!day.holiday_name) return res.status(400).json({ error: "Este dia não é feriado" });
      holidayOverride = b.holidayOverride ? 1 : 0;
    }

    await db.run("UPDATE daily_days SET atestado = ?, holiday_override = ? WHERE id = ?", [
      atestado,
      holidayOverride,
      day.id,
    ]);

    if (atestado) {
      await db.run("DELETE FROM daily_day_items WHERE day_id = ?", [day.id]);
    }

    const fresh = await db.get("SELECT * FROM daily_days WHERE id = ?", [day.id]);
    res.json(await loadDay(fresh));
  })
);

// POST /api/daily/days/:dayId/items  { unit, projectName, operations? }
router.post(
  "/days/:dayId/items",
  asyncHandler(async (req, res) => {
    const day = await findOwnedDay(req.params.dayId, req.user.id);
    if (!day) return res.status(404).json({ error: "Dia não encontrado" });

    const period = await db.get("SELECT status FROM daily_periods WHERE id = ?", [day.period_id]);
    if (period.status !== "open") return res.status(403).json({ error: "Este período já foi encerrado" });
    if (day.atestado) return res.status(400).json({ error: "Este dia está marcado como atestado" });
    if (!isBusinessDay(day)) return res.status(400).json({ error: "Este dia não está marcado como dia útil" });

    const b = req.body || {};
    const unit = String(b.unit || "");
    const projectName = String(b.projectName || "").trim();
    // "geral" = demanda que não precisa ser lançada num centro de custo específico.
    if (!UNITS.includes(unit) && unit !== "geral") return res.status(400).json({ error: "Centro de custo inválido" });
    if (!projectName) return res.status(400).json({ error: "Informe o nome do projeto" });

    const info = await db.run(
      "INSERT INTO daily_day_items (day_id, unit, project_name, operations) VALUES (?, ?, ?, ?)",
      [day.id, unit, projectName, unit === "fraga" ? serializeOps(b.operations) : null]
    );

    const item = await db.get("SELECT * FROM daily_day_items WHERE id = ?", [Number(info.lastInsertRowid)]);
    res.status(201).json({
      id: item.id,
      unit: item.unit,
      projectName: item.project_name,
      operations: item.operations ? JSON.parse(item.operations) : undefined,
    });
  })
);

// DELETE /api/daily/items/:itemId
router.delete(
  "/items/:itemId",
  asyncHandler(async (req, res) => {
    const item = await findOwnedItem(req.params.itemId, req.user.id);
    if (!item) return res.status(404).json({ error: "Lançamento não encontrado" });
    await db.run("DELETE FROM daily_day_items WHERE id = ?", [item.id]);
    res.json({ ok: true });
  })
);

// Agrega os lançamentos do Rateio Diário de um usuário num mês/ano no mesmo
// formato usado pelo Rateio Mensal (dias por projeto, separados por centro de
// custo) — usado pra sugerir o preenchimento do Rateio Mensal a partir do que
// já foi lançado dia a dia (ver routes/releases.js). `month` aqui é 1-12,
// igual à coluna daily_periods.month.
async function buildDailySuggestion(userId, month, year) {
  const blankUnitProjects = { wolf: [], fraga: [], woncred: [], profit: [] };
  const period = await db.get(
    "SELECT * FROM daily_periods WHERE user_id = ? AND month = ? AND year = ?",
    [userId, month, year]
  );
  if (!period) return { found: false, unitProjects: blankUnitProjects, generalProjects: [], atestados: [] };

  const days = await db.all("SELECT * FROM daily_days WHERE period_id = ? ORDER BY date ASC", [period.id]);

  let atestadoDays = 0;
  // chave "unit|projeto" -> { unit, projectName, days, operations }
  const totals = new Map();

  for (const dayRow of days) {
    if (!isBusinessDay(dayRow)) continue;
    if (dayRow.atestado) {
      atestadoDays += 1;
      continue;
    }

    const items = await db.all(
      "SELECT unit, project_name, operations FROM daily_day_items WHERE day_id = ?",
      [dayRow.id]
    );
    if (items.length === 0) continue;

    // Junta os lançamentos do dia por projeto (o mesmo projeto pode ter sido
    // marcado em mais de um centro de custo no mesmo dia).
    const byProject = new Map();
    for (const it of items) {
      let g = byProject.get(it.project_name);
      if (!g) {
        g = { units: new Set(), operations: new Set() };
        byProject.set(it.project_name, g);
      }
      g.units.add(it.unit);
      if (it.unit === "fraga" && it.operations) {
        try {
          JSON.parse(it.operations).forEach((tag) => g.operations.add(tag));
        } catch {
          // ignora operações inválidas
        }
      }
    }

    // O dia vale 1: dividido igualmente entre os projetos lançados nele e,
    // dentro de cada projeto, dividido de novo entre os centros de custo que
    // ele tocou nesse dia.
    const share = 1 / byProject.size;
    for (const [projectName, g] of byProject) {
      const perUnitShare = share / g.units.size;
      for (const unit of g.units) {
        const key = `${unit}|${projectName}`;
        let entry = totals.get(key);
        if (!entry) {
          entry = { unit, projectName, days: 0, operations: new Set() };
          totals.set(key, entry);
        }
        entry.days += perUnitShare;
        if (unit === "fraga") g.operations.forEach((tag) => entry.operations.add(tag));
      }
    }
  }

  const unitProjects = { wolf: [], fraga: [], woncred: [], profit: [] };
  const generalProjects = [];
  for (const entry of totals.values()) {
    const roundedDays = Math.round(entry.days);
    if (roundedDays <= 0) continue;
    const item = { name: entry.projectName, days: roundedDays };
    if (entry.unit === "fraga" && entry.operations.size > 0) item.operations = [...entry.operations];
    // "geral" no diário == "Demandas Gerais" no rateio mensal (nenhum centro de custo específico).
    if (entry.unit === "geral") generalProjects.push(item);
    else unitProjects[entry.unit].push(item);
  }

  const atestados = atestadoDays > 0 ? [{ name: "Atestado", days: atestadoDays }] : [];
  return { found: true, unitProjects, generalProjects, atestados };
}

module.exports = router;
module.exports.buildDailySuggestion = buildDailySuggestion;
