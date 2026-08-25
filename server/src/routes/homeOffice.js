"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { requireAuth, requireAdmin } = require("../auth");
const { getHolidaysForMonth } = require("../holidays");
const { weekdaysOfMonth } = require("../dateUtils");
const { weeklyQuotaForDate, isoWeekKey, sectorMaxHO } = require("../homeOfficeRules");
const { broadcastHomeOfficePeriod } = require("../ws");

const router = express.Router();
router.use(requireAuth);

function loadHolidayOverrides(periodId) {
  return db.all(
    "SELECT id, holiday_date, compensation_date FROM ho_holiday_overrides WHERE period_id = ? ORDER BY holiday_date ASC",
    [periodId]
  );
}

// ho_periods.month é 0-indexado (igual releases.month) — weekdaysOfMonth e
// getHolidaysForMonth esperam 1-12 (igual daily_periods.month), daí o +1 aqui.
//
// Cada feriado do mês normalmente não é dia útil (some da grade). Uma troca
// (ho_holiday_overrides) inverte isso pro par de datas envolvido: o feriado
// (holiday_date) vira dia útil normal (trabalhado), e a data de compensação
// escolhida vira o dia bloqueado no lugar dele — ninguém trabalha nela, nem
// presencial nem home office. `flaggedDays` reúne os dois casos (feriado não
// trocado, e folga de compensação) pra grade mostrar um aviso visual no dia
// em vez de simplesmente escondê-lo.
function computeCalendar(year, month0, overrideRows) {
  const month1 = month0 + 1;
  const holidays = getHolidaysForMonth(year, month1);
  const holidayNameByDate = new Map(holidays.map((h) => [h.date, h.name]));
  const workedHolidayDates = new Set(overrideRows.map((o) => o.holiday_date));
  const compensationSource = new Map(overrideRows.map((o) => [o.compensation_date, o.holiday_date]));

  const businessDays = [];
  const flaggedDays = [];
  for (const d of weekdaysOfMonth(year, month1)) {
    if (holidayNameByDate.has(d) && !workedHolidayDates.has(d)) {
      flaggedDays.push({ date: d, type: "holiday", name: holidayNameByDate.get(d) });
      continue;
    }
    if (compensationSource.has(d)) {
      const holidayDate = compensationSource.get(d);
      const holidayName = holidayNameByDate.get(holidayDate) || "feriado";
      flaggedDays.push({ date: d, type: "compensation", name: `Folga (compensação de ${holidayName})`, holidayDate });
      continue;
    }
    businessDays.push(d);
  }
  return { businessDays, flaggedDays, holidays };
}

// Libera a vaga de todo mundo marcado num dia que está ficando bloqueado
// (Reunião Geral nova, ou folga de compensação nova) — devolve quem foi
// afetado pro front avisar.
async function clearEntriesOnDate(periodId, date) {
  const affected = await db.all("SELECT DISTINCT collaborator_id FROM ho_entries WHERE period_id = ? AND date = ?", [
    periodId,
    date,
  ]);
  await db.run("DELETE FROM ho_entries WHERE period_id = ? AND date = ?", [periodId, date]);
  return affected.map((r) => r.collaborator_id);
}

// Recarrega o período do zero e manda pronto pra quem estiver conectado —
// assim quem não foi o autor da mudança não precisa fazer outra requisição
// só pra buscar o que já foi calculado aqui.
async function broadcastFreshPeriod(periodId) {
  const row = await db.get("SELECT * FROM ho_periods WHERE id = ?", [periodId]);
  if (!row) return;
  broadcastHomeOfficePeriod(await loadPeriod(row));
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
  const overrideRows = await loadHolidayOverrides(row.id);
  const { businessDays, flaggedDays, holidays } = computeCalendar(row.year, row.month, overrideRows);
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
    flaggedDays,
    holidays: holidays.map((h) => ({ date: h.date, name: h.name, facultativo: !!h.facultativo })),
    holidayOverrides: overrideRows.map((o) => ({ id: o.id, holidayDate: o.holiday_date, compensationDate: o.compensation_date })),
    generalMeetings: meetings.map((m) => ({ id: m.id, date: m.date, title: m.title || "" })),
    entries: [...entriesByCollaborator.entries()].map(([collaboratorId, dates]) => ({ collaboratorId, dates })),
    specialDays: specialRows.map((s) => ({ id: s.id, collaboratorId: s.collaborator_id, date: s.date, type: s.type })),
  };
}

// GET /api/home-office/roster -> equipe inteira, só os campos necessários pra
// montar a escala (nome, setor, admissão, ativo, estagiário) — NUNCA
// salário/aniversário/cargo. A cor da tag é do setor (ver /api/sectors), não
// vem daqui. A escala é visível pra todo mundo (diferente do Rateio Mensal,
// que restringe /api/collaborators ao próprio registro por privacidade
// salarial), então esse endpoint existe à parte pra não precisar afrouxar
// aquela restrição.
router.get(
  "/roster",
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      "SELECT id, name, sector_id, hire_date, active, is_intern FROM collaborators ORDER BY name ASC"
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        sectorId: r.sector_id || undefined,
        hireDate: r.hire_date || undefined,
        active: !!r.active,
        isIntern: !!r.is_intern,
      }))
    );
  })
);

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
    const period = await loadPeriod(row);
    broadcastHomeOfficePeriod(period);
    res.status(201).json(period);
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
    const period = await loadPeriod(row);
    broadcastHomeOfficePeriod(period);
    res.json(period);
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
    const affected = await clearEntriesOnDate(period.id, date);
    await broadcastFreshPeriod(period.id);
    res.status(201).json({
      id: Number(info.lastInsertRowid),
      date,
      title,
      affectedCollaboratorIds: affected,
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
    await broadcastFreshPeriod(meeting.period_id);
    res.json({ ok: true });
  })
);

// PATCH /api/home-office/meetings/:meetingId  { date?, title? } -> remarca a
// Reunião Geral. Quando a data muda, quem já estava de HO no dia NOVO (que
// vai virar reunião) perde a vaga ali — mas em vez de só apagar, tenta
// realocar cada um pro dia ANTIGO, que está ficando livre agora (a troca só
// faz sentido se as pessoas puderem seguir de home office naquela semana).
router.patch(
  "/meetings/:meetingId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const meeting = await db.get(
      `SELECT m.*, p.status AS period_status, p.year AS period_year, p.month AS period_month
       FROM ho_general_meetings m JOIN ho_periods p ON p.id = m.period_id WHERE m.id = ?`,
      [req.params.meetingId]
    );
    if (!meeting) return res.status(404).json({ error: "Reunião não encontrada" });
    if (meeting.period_status !== "open") return res.status(403).json({ error: "Este período já foi aprovado" });

    const period = { id: meeting.period_id, year: meeting.period_year, month: meeting.period_month };
    const oldDate = meeting.date;
    const newDate = req.body?.date !== undefined ? String(req.body.date) : oldDate;
    const title = req.body?.title !== undefined ? String(req.body.title).trim() : meeting.title || "";

    if (newDate === oldDate) {
      await db.run("UPDATE ho_general_meetings SET title = ? WHERE id = ?", [title, meeting.id]);
      await broadcastFreshPeriod(period.id);
      return res.json({ id: meeting.id, date: newDate, title, movedCollaboratorIds: [], blockedCollaboratorIds: [] });
    }

    if (!isDateInPeriod(newDate, period)) return res.status(400).json({ error: "Data inválida para este período" });
    const overrideRows = await loadHolidayOverrides(period.id);
    const { businessDays } = computeCalendar(period.year, period.month, overrideRows);
    if (!businessDays.includes(newDate)) return res.status(400).json({ error: "Este dia não é um dia útil" });
    const dup = await db.get("SELECT id FROM ho_general_meetings WHERE period_id = ? AND date = ? AND id != ?", [
      period.id,
      newDate,
      meeting.id,
    ]);
    if (dup) return res.status(400).json({ error: "Já existe uma reunião geral nesta data" });

    const entriesOnNewDate = await db.all("SELECT collaborator_id FROM ho_entries WHERE period_id = ? AND date = ?", [
      period.id,
      newDate,
    ]);
    await db.run("DELETE FROM ho_entries WHERE period_id = ? AND date = ?", [period.id, newDate]);
    await db.run("UPDATE ho_general_meetings SET date = ?, title = ? WHERE id = ?", [newDate, title, meeting.id]);

    // Realoca cada um pro dia antigo, respeitando a capacidade do setor lá —
    // o dia antigo estava bloqueado pela reunião, então começa vazio, mas se
    // mais de uma pessoa do mesmo setor estava no dia novo, pode não caber
    // todo mundo; quem não couber fica sem HO nesse dia (e é avisado disso).
    const movedCollaboratorIds = [];
    const blockedCollaboratorIds = [];
    for (const { collaborator_id: collaboratorId } of entriesOnNewDate) {
      const collaborator = await db.get("SELECT * FROM collaborators WHERE id = ?", [collaboratorId]);
      if (!collaborator) continue;
      const already = await db.get(
        "SELECT id FROM ho_entries WHERE period_id = ? AND collaborator_id = ? AND date = ?",
        [period.id, collaboratorId, oldDate]
      );
      if (already) {
        movedCollaboratorIds.push(collaboratorId);
        continue;
      }
      let fits = !!collaborator.sector_id;
      if (fits) {
        const activeMembers = await db.all("SELECT id FROM collaborators WHERE sector_id = ? AND active = 1", [
          collaborator.sector_id,
        ]);
        const maxHO = sectorMaxHO(activeMembers.length);
        const sectorUsedRows = await db.all(
          `SELECT DISTINCT e.collaborator_id FROM ho_entries e
           JOIN collaborators c ON c.id = e.collaborator_id
           WHERE e.period_id = ? AND e.date = ? AND c.sector_id = ? AND c.active = 1`,
          [period.id, oldDate, collaborator.sector_id]
        );
        fits = sectorUsedRows.length < maxHO;
      }
      if (fits) {
        await db.run("INSERT INTO ho_entries (period_id, collaborator_id, date) VALUES (?, ?, ?)", [
          period.id,
          collaboratorId,
          oldDate,
        ]);
        movedCollaboratorIds.push(collaboratorId);
      } else {
        blockedCollaboratorIds.push(collaboratorId);
      }
    }

    await broadcastFreshPeriod(period.id);
    res.json({ id: meeting.id, date: newDate, title, movedCollaboratorIds, blockedCollaboratorIds });
  })
);

// POST /api/home-office/periods/:id/holiday-overrides  { holidayDate, compensationDate }
// Troca um feriado do mês: ele vira dia útil (trabalhado) e a data de
// compensação escolhida vira a folga no lugar dele.
router.post(
  "/periods/:id/holiday-overrides",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const period = await db.get("SELECT * FROM ho_periods WHERE id = ?", [req.params.id]);
    if (!period) return res.status(404).json({ error: "Período não encontrado" });
    if (period.status !== "open") return res.status(403).json({ error: "Este período já foi aprovado" });

    const holidayDate = String(req.body?.holidayDate || "");
    const compensationDate = String(req.body?.compensationDate || "");
    if (!isDateInPeriod(holidayDate, period) || !isDateInPeriod(compensationDate, period)) {
      return res.status(400).json({ error: "As duas datas precisam estar dentro deste mês" });
    }
    if (holidayDate === compensationDate) {
      return res.status(400).json({ error: "A data de compensação precisa ser diferente do feriado" });
    }

    const overrideRows = await loadHolidayOverrides(period.id);
    const { flaggedDays, holidays } = computeCalendar(period.year, period.month, overrideRows);
    if (!holidays.some((h) => h.date === holidayDate)) {
      return res.status(400).json({ error: "Essa data não é um feriado neste mês" });
    }
    if (overrideRows.some((o) => o.holiday_date === holidayDate)) {
      return res.status(400).json({ error: "Este feriado já foi trocado" });
    }
    const compensationWeekday = new Date(`${compensationDate}T00:00:00`).getDay();
    if (compensationWeekday === 0 || compensationWeekday === 6) {
      return res.status(400).json({ error: "A data de compensação precisa ser um dia de semana" });
    }
    if (flaggedDays.some((f) => f.date === compensationDate)) {
      return res.status(400).json({ error: "A data de compensação já é feriado ou folga de outra troca" });
    }
    const meetingOnCompDate = await db.get("SELECT id FROM ho_general_meetings WHERE period_id = ? AND date = ?", [
      period.id,
      compensationDate,
    ]);
    if (meetingOnCompDate) return res.status(400).json({ error: "Já existe uma Reunião Geral nesta data" });

    const info = await db.run(
      "INSERT INTO ho_holiday_overrides (period_id, holiday_date, compensation_date) VALUES (?, ?, ?)",
      [period.id, holidayDate, compensationDate]
    );
    // O dia de compensação vira folga — limpa quem já tinha HO marcado nele.
    const affected = await clearEntriesOnDate(period.id, compensationDate);
    await broadcastFreshPeriod(period.id);

    res.status(201).json({
      id: Number(info.lastInsertRowid),
      holidayDate,
      compensationDate,
      affectedCollaboratorIds: affected,
    });
  })
);

// DELETE /api/home-office/holiday-overrides/:id -> desfaz a troca (o feriado
// volta a ficar bloqueado, o dia de compensação volta a ser dia útil normal)
router.delete(
  "/holiday-overrides/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const override = await db.get(
      `SELECT o.*, p.status AS period_status FROM ho_holiday_overrides o
       JOIN ho_periods p ON p.id = o.period_id WHERE o.id = ?`,
      [req.params.id]
    );
    if (!override) return res.status(404).json({ error: "Troca não encontrada" });
    if (override.period_status !== "open") return res.status(403).json({ error: "Este período já foi aprovado" });
    await db.run("DELETE FROM ho_holiday_overrides WHERE id = ?", [override.id]);
    // O feriado volta a ficar bloqueado — limpa quem tinha marcado HO nele
    // enquanto estava "trabalhado".
    const affected = await clearEntriesOnDate(override.period_id, override.holiday_date);
    await broadcastFreshPeriod(override.period_id);
    res.json({ ok: true, affectedCollaboratorIds: affected });
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
    await broadcastFreshPeriod(period.id);
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
    await broadcastFreshPeriod(special.period_id);
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

    // Regra sem exceção, independente de tempo de casa: estagiário não tem
    // direito a home office.
    if (collaborator.is_intern) {
      return res.status(400).json({ error: "Estagiários não têm direito a home office" });
    }

    if (!isDateInPeriod(date, period)) return res.status(400).json({ error: "Data inválida para este período" });
    const overrideRowsForEntry = await loadHolidayOverrides(period.id);
    const { businessDays: businessDaysList } = computeCalendar(period.year, period.month, overrideRowsForEntry);
    const businessDays = new Set(businessDaysList);
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
      await broadcastFreshPeriod(period.id);
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
    await broadcastFreshPeriod(ctx.period.id);
    res.json({ collaboratorId, date, on: false });
  })
);

module.exports = router;
