"use strict";

// Regras de negócio da Escala de Home Office — funções puras, sem acesso a
// banco (mesmo espírito de holidays.js). As mesmas 3 funções são portadas à
// mão pro front (source/src/app/homeOfficeRules.ts) só pra preview instantâneo
// antes do clique; quem decide de verdade se um lançamento é aceito é sempre
// o backend, chamando exatamente essas funções.

// Meses completos entre duas datas "YYYY-MM-DD" (ex: admitido 15/jan, em
// 14/fev ainda são 0 meses completos; em 15/fev já é 1).
function fullMonthsBetween(startISO, endISO) {
  const start = parseISO(startISO);
  const end = parseISO(endISO);
  if (!start || !end) return 0;
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function parseISO(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

// Cota semanal de home office por tempo de casa, calculada na data de
// referência (não no mês inteiro) — a cota pode mudar no meio do período
// quando a pessoa cruza um limiar de tempo de casa.
//   sem data de admissão, ou < 1 mês completo -> 0 dias/semana
//   >= 1 e < 2 meses completos                -> 1 dia/semana
//   >= 2 meses completos                      -> 2 dias/semana (teto, nunca sobe mais)
function weeklyQuotaForDate(hireDateISO, referenceDateISO) {
  if (!hireDateISO) return 0;
  const months = fullMonthsBetween(hireDateISO, referenceDateISO);
  if (months < 1) return 0;
  if (months < 2) return 1;
  return 2;
}

// Chave "AAAA-Www" (semana ISO) de uma data — usada pra agrupar dias por
// semana ao aplicar a cota semanal.
function isoWeekKey(dateISO) {
  const date = parseISO(dateISO);
  if (!date) return "";
  // Copia pra não alterar a data original; joga pra quinta-feira da mesma
  // semana ISO (0=domingo -> 7) pra achar o ano ISO correto perto da virada do ano.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
}

// Setor com N membros ativos: mínimo presencial = max(1, floor(N/2)),
// máximo em home office no mesmo dia = N - mínimo presencial.
// N=2 -> máx 1 · N=3 -> máx 2 · N=4 -> máx 2.
function sectorMaxHO(activeMemberCount) {
  if (activeMemberCount <= 0) return 0;
  return activeMemberCount - Math.max(1, Math.floor(activeMemberCount / 2));
}

module.exports = { fullMonthsBetween, weeklyQuotaForDate, isoWeekKey, sectorMaxHO };
