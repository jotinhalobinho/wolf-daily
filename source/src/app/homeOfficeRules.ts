// Regras de negócio da Escala de Home Office — mesmas 3 funções puras de
// server/src/homeOfficeRules.js, portadas à mão pro front. Usadas SÓ pra
// preview instantâneo (mostrar "vagas: 1/2" antes do clique, sem round-trip)
// — quem decide de verdade se um clique é aceito é sempre o servidor; se essas
// contas ficarem desatualizadas por um instante (alguém clicou ao mesmo
// tempo), o servidor corrige na resposta do clique seguinte.

function parseISO(iso: string | undefined): Date | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

// Meses completos entre duas datas "YYYY-MM-DD".
export function fullMonthsBetween(startISO: string | undefined, endISO: string): number {
  const start = parseISO(startISO);
  const end = parseISO(endISO);
  if (!start || !end) return 0;
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

// Cota semanal de home office por tempo de casa, na data de referência:
//   sem admissão, ou < 1 mês completo -> 0 dias/semana
//   >= 1 e < 2 meses completos        -> 1 dia/semana
//   >= 2 meses completos              -> 2 dias/semana (teto, nunca sobe mais)
export function weeklyQuotaForDate(hireDateISO: string | undefined, referenceDateISO: string): number {
  if (!hireDateISO) return 0;
  const months = fullMonthsBetween(hireDateISO, referenceDateISO);
  if (months < 1) return 0;
  if (months < 2) return 1;
  return 2;
}

// Chave "AAAA-Www" (semana ISO) de uma data.
export function isoWeekKey(dateISO: string): string {
  const date = parseISO(dateISO);
  if (!date) return "";
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
}

// Setor com N membros ativos: mínimo presencial = max(1, floor(N/2)),
// máximo em home office no mesmo dia = N - mínimo presencial.
export function sectorMaxHO(activeMemberCount: number): number {
  if (activeMemberCount <= 0) return 0;
  return activeMemberCount - Math.max(1, Math.floor(activeMemberCount / 2));
}
