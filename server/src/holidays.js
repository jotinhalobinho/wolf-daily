"use strict";

// Feriados nacionais brasileiros. Datas fixas + móveis (calculadas a partir da Páscoa).
// Carnaval e Corpus Christi são "pontos facultativos" nacionais (não são feriados
// obrigatórios por lei), mas costumam ser tratados como dia não útil na prática —
// por isso aparecem marcados, e o usuário decide dia a dia se considera como dia útil.

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISODate(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// Algoritmo de Meeus/Jones/Butcher (calendário gregoriano) para a data da Páscoa.
function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function dateToISO(date) {
  return toISODate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

// Retorna todos os feriados nacionais de um ano, como { date: 'YYYY-MM-DD', name, facultativo? }
function getHolidaysForYear(year) {
  const easter = easterDate(year);
  const list = [
    { date: toISODate(year, 1, 1), name: "Confraternização Universal" },
    { date: toISODate(year, 4, 21), name: "Tiradentes" },
    { date: toISODate(year, 5, 1), name: "Dia do Trabalhador" },
    { date: toISODate(year, 9, 7), name: "Independência do Brasil" },
    { date: toISODate(year, 10, 12), name: "Nossa Senhora Aparecida" },
    { date: toISODate(year, 11, 2), name: "Finados" },
    { date: toISODate(year, 11, 15), name: "Proclamação da República" },
    { date: toISODate(year, 11, 20), name: "Dia Nacional de Zumbi e da Consciência Negra" },
    { date: toISODate(year, 12, 25), name: "Natal" },
    { date: dateToISO(addDays(easter, -48)), name: "Carnaval (segunda-feira)", facultativo: true },
    { date: dateToISO(addDays(easter, -47)), name: "Carnaval (terça-feira)", facultativo: true },
    { date: dateToISO(addDays(easter, -2)), name: "Sexta-feira Santa" },
    { date: dateToISO(addDays(easter, 60)), name: "Corpus Christi", facultativo: true },
  ];
  return list;
}

// Retorna só os feriados que caem dentro de um mês específico (month: 1-12).
function getHolidaysForMonth(year, month) {
  const prefix = `${year}-${pad2(month)}-`;
  return getHolidaysForYear(year).filter((h) => h.date.startsWith(prefix));
}

module.exports = { getHolidaysForYear, getHolidaysForMonth, easterDate };
