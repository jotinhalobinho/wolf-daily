"use strict";

// Regras de negócio de Horas Extras — funções puras, sem acesso a banco
// (mesmo espírito de homeOfficeRules.js e holidays.js). O cálculo do
// 50%/100% é feito só aqui, chamado pelo backend (server/src/routes/overtime.js)
// — não existe uma cópia dessas regras no front, pra não arriscar os dois
// lados divergirem; o front só formata o que a API já devolve pronto.
//
// Regra (CLT + horário combinado com a empresa):
//   domingo ou feriado nacional (não facultativo) -> 100% o dia inteiro
//   dia útil ou sábado, antes das 22h              -> 50%
//   dia útil ou sábado, a partir das 22h            -> 100%
//
// Um lançamento pode cruzar a meia-noite (ex: 21h às 06h do dia seguinte,
// representado como startMinutes=1260, endMinutes=1800 — "30h", notação
// usada também na planilha exportada). `classifyOvertimeMinutes` quebra o
// intervalo em segmentos nos pontos de corte relevantes (a virada de cada
// dia civil coberto, e as 22h de cada um deles) e classifica cada segmento
// pelo dia civil em que ele cai.

const MINUTES_PER_DAY = 24 * 60;
const NIGHT_CUTOFF_MINUTES = 22 * 60; // 22h

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Soma `days` dias de calendário a uma data "YYYY-MM-DD".
function addDaysISO(dateISO, days) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

// "HH:MM" -> minutos desde 00:00, ou null se inválido.
function parseTimeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// minutos (podendo passar de 1440, ex: 1800) -> "HH:MM", sem embrulhar em 24h
// (ex: 1800 -> "30:00") — é assim que a empresa pediu pra mostrar um
// lançamento que cruzou a meia-noite, tanto na tela quanto na planilha.
function minutesToClockLabel(totalMinutes) {
  const days = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const minutesOfDay = totalMinutes - days * MINUTES_PER_DAY;
  const hh = pad2(Math.floor(minutesOfDay / 60) + days * 24);
  const mm = pad2(minutesOfDay % 60);
  return `${hh}:${mm}`;
}

// Quebra [startMinutes, endMinutes) em segmentos "puros" (mesmo dia civil e
// mesmo lado do corte das 22h) e soma cada um em minutes50/minutes100.
// `isRestDay(dateISO)` decide se um dia civil é domingo ou feriado (100% o
// dia inteiro, mesmo antes das 22h).
function classifyOvertimeMinutes(dateISO, startMinutes, endMinutes, isRestDay) {
  if (!(endMinutes > startMinutes)) {
    throw new Error("Horário final deve ser depois do horário inicial");
  }

  const cutPoints = new Set([startMinutes, endMinutes]);
  for (let dayIndex = 0; dayIndex * MINUTES_PER_DAY < endMinutes; dayIndex++) {
    const midnight = dayIndex * MINUTES_PER_DAY;
    const nightCutoff = midnight + NIGHT_CUTOFF_MINUTES;
    if (midnight > startMinutes && midnight < endMinutes) cutPoints.add(midnight);
    if (nightCutoff > startMinutes && nightCutoff < endMinutes) cutPoints.add(nightCutoff);
  }
  const sorted = [...cutPoints].sort((a, b) => a - b);

  let minutes50 = 0;
  let minutes100 = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    const duration = to - from;
    if (duration <= 0) continue;
    const dayIndex = Math.floor(from / MINUTES_PER_DAY);
    const minuteOfDay = from - dayIndex * MINUTES_PER_DAY;
    const segmentDate = dayIndex === 0 ? dateISO : addDaysISO(dateISO, dayIndex);
    if (isRestDay(segmentDate) || minuteOfDay >= NIGHT_CUTOFF_MINUTES) minutes100 += duration;
    else minutes50 += duration;
  }
  return { minutes50, minutes100 };
}

module.exports = {
  MINUTES_PER_DAY,
  NIGHT_CUTOFF_MINUTES,
  addDaysISO,
  parseTimeToMinutes,
  minutesToClockLabel,
  classifyOvertimeMinutes,
};
