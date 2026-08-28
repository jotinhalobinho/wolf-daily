import { useState, useEffect, useCallback } from "react";
import { apiGet, apiPost, apiDelete } from "./api";
import * as XLSX from "xlsx";
import { Plus, Trash2, ChevronLeft, ChevronRight, FileSpreadsheet } from "lucide-react";
import { MONTHS, fmtDate } from "./App";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface OvertimeEntry {
  id: number;
  date: string; // "YYYY-MM-DD"
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM", pode passar de 24h (ex: "30:00" = 06h do dia seguinte)
  crossesMidnight: boolean;
  projectName: string;
  hours50: number;
  hours100: number;
}

interface OvertimeMonthResponse {
  month: number;
  year: number;
  entries: OvertimeEntry[];
  totalHours50: number;
  totalHours100: number;
  totalHours: number;
}

interface AdminSummaryRow {
  collaboratorId: string;
  name: string;
  hours50: number;
  hours100: number;
  hoursTotal: number;
}

interface AdminSummaryResponse {
  month: number;
  year: number;
  collaborators: AdminSummaryRow[];
  totalHours50: number;
  totalHours100: number;
  totalHours: number;
}

interface AdminEntryRow extends OvertimeEntry {
  collaboratorName: string;
}

interface OvertimeProps {
  role: "admin" | "collaborator";
  currentCollaboratorId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtHours(h: number): string {
  return (Math.round(h * 100) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

// Uma aba com todos os lançamentos do mês (uma linha por lançamento, não por
// hora) e outra com o totalizador de cada colaborador — mesmo espírito do
// exportDailyPeriodToExcel em DailyRateio.tsx.
function exportOvertimeToExcel(month: number, year: number, entries: AdminEntryRow[], summary: AdminSummaryRow[]) {
  const competencia = `${MONTHS[month - 1]} ${year}`;

  const entriesHeader = ["Data", "Colaborador", "Horário", "Projeto", "Horas 50%", "Horas 100%", "Total"];
  const entriesRows: (string | number)[][] = [entriesHeader];
  for (const e of entries) {
    entriesRows.push([
      fmtDate(e.date),
      e.collaboratorName,
      `${e.startTime}–${e.endTime}`,
      e.projectName,
      e.hours50,
      e.hours100,
      Math.round((e.hours50 + e.hours100) * 100) / 100,
    ]);
  }
  const entriesSheet = XLSX.utils.aoa_to_sheet(entriesRows);
  entriesSheet["!cols"] = [{ wch: 12 }, { wch: 26 }, { wch: 16 }, { wch: 30 }, { wch: 11 }, { wch: 11 }, { wch: 10 }];

  const totalsHeader = ["Colaborador", "Horas 50%", "Horas 100%", "Total"];
  const totalsRows: (string | number)[][] = [totalsHeader];
  for (const c of summary) totalsRows.push([c.name, c.hours50, c.hours100, c.hoursTotal]);
  const grandTotal50 = Math.round(summary.reduce((sum, c) => sum + c.hours50, 0) * 100) / 100;
  const grandTotal100 = Math.round(summary.reduce((sum, c) => sum + c.hours100, 0) * 100) / 100;
  totalsRows.push(["Total geral", grandTotal50, grandTotal100, Math.round((grandTotal50 + grandTotal100) * 100) / 100]);
  const totalsSheet = XLSX.utils.aoa_to_sheet(totalsRows);
  totalsSheet["!cols"] = [{ wch: 26 }, { wch: 11 }, { wch: 11 }, { wch: 10 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, entriesSheet, "Lançamentos");
  XLSX.utils.book_append_sheet(workbook, totalsSheet, "Totais por Colaborador");
  XLSX.writeFile(workbook, `Horas Extras - ${competencia}.xlsx`);
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function Overtime({ role, currentCollaboratorId }: OvertimeProps) {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [data, setData] = useState<OvertimeMonthResponse | null>(null);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [adminSummary, setAdminSummary] = useState<AdminSummaryResponse | null>(null);
  const [adminEntries, setAdminEntries] = useState<AdminEntryRow[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);

  const [draftDate, setDraftDate] = useState(todayISO());
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const [draftProject, setDraftProject] = useState("");

  const hasCollaborator = !!currentCollaboratorId;

  const load = useCallback(() => {
    if (!hasCollaborator) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([apiGet(`/overtime/entries?month=${month}&year=${year}`), apiGet("/overtime/projects")])
      .then(([entriesRes, projects]) => {
        setData(entriesRes);
        setCatalog(projects);
      })
      .catch((e) => alert(e.message))
      .finally(() => setLoading(false));
  }, [month, year, hasCollaborator]);

  useEffect(() => {
    load();
  }, [load]);

  // Painel do admin busca o mês inteiro (todo mundo) — independe de o admin
  // ter ou não um colaborador vinculado à própria conta.
  const loadAdmin = useCallback(() => {
    if (role !== "admin") return;
    setAdminLoading(true);
    Promise.all([apiGet(`/overtime/admin/summary?month=${month}&year=${year}`), apiGet(`/overtime/admin/entries?month=${month}&year=${year}`)])
      .then(([summary, entries]) => {
        setAdminSummary(summary);
        setAdminEntries(entries);
      })
      .catch((e) => alert(e.message))
      .finally(() => setAdminLoading(false));
  }, [month, year, role]);

  useEffect(() => {
    loadAdmin();
  }, [loadAdmin]);

  function shiftMonth(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    setMonth(m);
    setYear(y);
  }

  function addEntry() {
    if (!draftDate || !draftStart || !draftEnd || !draftProject.trim()) return;
    setSaving(true);
    apiPost("/overtime/entries", { date: draftDate, startTime: draftStart, endTime: draftEnd, projectName: draftProject.trim() })
      .then(() => {
        setDraftStart("");
        setDraftEnd("");
        setDraftProject("");
        load();
        loadAdmin(); // se o próprio admin lançou, o painel "todos os colaboradores" também precisa refletir
      })
      .catch((e) => alert(e.message))
      .finally(() => setSaving(false));
  }

  function removeEntry(id: number) {
    if (!window.confirm("Excluir este lançamento?")) return;
    apiDelete(`/overtime/entries/${id}`)
      .then(() => {
        load();
        loadAdmin();
      })
      .catch((e) => alert(e.message));
  }

  const entries = data?.entries ?? [];
  const summaryCollaborators = adminSummary?.collaborators ?? [];

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-4 md:px-8 py-6 md:py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Horas Extras</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Lance os intervalos de horário trabalhados fora da jornada normal.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => shiftMonth(-1)} className="w-8 h-8 rounded-lg border border-border hover:bg-muted flex items-center justify-center transition-all">
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold w-32 text-center">
              {MONTHS[month - 1]} {year}
            </span>
            <button onClick={() => shiftMonth(1)} className="w-8 h-8 rounded-lg border border-border hover:bg-muted flex items-center justify-center transition-all">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {hasCollaborator ? (
          <>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-card border border-border rounded-xl p-5">
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Horas 50%</p>
                <p className="text-2xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmtHours(data?.totalHours50 ?? 0)}h</p>
              </div>
              <div className="bg-card border border-border rounded-xl p-5">
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Horas 100%</p>
                <p className="text-2xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmtHours(data?.totalHours100 ?? 0)}h</p>
              </div>
              <div className="bg-card border border-border rounded-xl p-5">
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Total do mês</p>
                <p className="text-2xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmtHours(data?.totalHours ?? 0)}h</p>
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Novo lançamento</p>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Data</label>
                  <input
                    type="date"
                    className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary"
                    value={draftDate}
                    onChange={(e) => setDraftDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Início</label>
                  <input
                    type="time"
                    className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary"
                    value={draftStart}
                    onChange={(e) => setDraftStart(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Fim</label>
                  <input
                    type="time"
                    className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary"
                    value={draftEnd}
                    onChange={(e) => setDraftEnd(e.target.value)}
                  />
                </div>
                <div className="flex-1 min-w-[180px]">
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Projeto</label>
                  <input
                    list="overtime-project-catalog"
                    className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary w-full"
                    placeholder="Nome do projeto…"
                    value={draftProject}
                    onChange={(e) => setDraftProject(e.target.value)}
                  />
                </div>
                <button
                  onClick={addEntry}
                  disabled={saving || !draftDate || !draftStart || !draftEnd || !draftProject.trim()}
                  className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
                >
                  <Plus size={13} />
                  Adicionar
                </button>
              </div>
              <datalist id="overtime-project-catalog">
                {catalog.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              <p className="text-[10px] text-[var(--tone-subtle)]">
                Se o horário final for antes do inicial, o sistema entende que passou da meia-noite (ex: 23:00 até 01:00). Pode lançar mais de um intervalo no mesmo dia.
              </p>
            </div>

            {loading ? (
              <div className="text-sm text-[var(--tone-subtle)]">Carregando…</div>
            ) : (
              <div className="bg-card border border-border rounded-xl overflow-hidden overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-4 py-2">Data</th>
                      <th className="text-left px-4 py-2">Horário</th>
                      <th className="text-left px-4 py-2">Projeto</th>
                      <th className="text-right px-4 py-2">50%</th>
                      <th className="text-right px-4 py-2">100%</th>
                      <th className="text-right px-4 py-2">Total</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.id} className="border-t border-border">
                        <td className="px-4 py-2">{fmtDate(e.date)}</td>
                        <td className="px-4 py-2" style={{ fontFamily: "var(--font-mono)" }}>
                          {e.startTime}–{e.endTime}
                          {e.crossesMidnight && <span className="text-[10px] text-muted-foreground ml-1">(dia seguinte)</span>}
                        </td>
                        <td className="px-4 py-2">{e.projectName}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtHours(e.hours50)}h</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtHours(e.hours100)}h</td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium">{fmtHours(e.hours50 + e.hours100)}h</td>
                        <td className="px-4 py-2 text-right">
                          <button onClick={() => removeEntry(e.id)} className="text-[var(--tone-subtle)] hover:text-red-500">
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {entries.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-6 text-center text-sm text-[var(--tone-subtle)]">
                          Nenhum lançamento neste mês
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Sua conta não está vinculada a um colaborador — fale com o administrador.</p>
        )}

        {role === "admin" && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm font-semibold">
                Todos os colaboradores — {MONTHS[month - 1]} {year}
              </p>
              <button
                onClick={() => exportOvertimeToExcel(month, year, adminEntries, summaryCollaborators)}
                disabled={adminLoading || adminEntries.length === 0}
                className="h-8 px-3 text-sm font-medium bg-muted rounded-lg hover:bg-input-background disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
              >
                <FileSpreadsheet size={14} />
                Exportar Excel
              </button>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-background border border-border rounded-xl p-5">
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Horas 50% (geral)</p>
                <p className="text-2xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmtHours(adminSummary?.totalHours50 ?? 0)}h</p>
              </div>
              <div className="bg-background border border-border rounded-xl p-5">
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Horas 100% (geral)</p>
                <p className="text-2xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmtHours(adminSummary?.totalHours100 ?? 0)}h</p>
              </div>
              <div className="bg-background border border-border rounded-xl p-5">
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Total geral</p>
                <p className="text-2xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmtHours(adminSummary?.totalHours ?? 0)}h</p>
              </div>
            </div>
            {adminLoading ? (
              <p className="text-sm text-[var(--tone-subtle)]">Carregando…</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground uppercase tracking-wide">
                    <tr>
                      <th className="text-left py-1.5">Colaborador</th>
                      <th className="text-right py-1.5">50%</th>
                      <th className="text-right py-1.5">100%</th>
                      <th className="text-right py-1.5">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryCollaborators.map((c) => (
                      <tr key={c.collaboratorId} className="border-t border-border">
                        <td className="py-1.5">{c.name}</td>
                        <td className="py-1.5 text-right tabular-nums">{fmtHours(c.hours50)}h</td>
                        <td className="py-1.5 text-right tabular-nums">{fmtHours(c.hours100)}h</td>
                        <td className="py-1.5 text-right tabular-nums font-medium">{fmtHours(c.hoursTotal)}h</td>
                      </tr>
                    ))}
                    {summaryCollaborators.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-4 text-center text-[var(--tone-subtle)]">
                          Ninguém lançou hora extra neste mês
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
