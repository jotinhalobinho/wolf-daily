import { useState, useEffect, useCallback } from "react";
import { apiGet, apiPost, apiPatch, apiDelete } from "./api";
import * as XLSX from "xlsx";
import {
  Plus, X, Pencil, ChevronDown, ChevronLeft, ChevronRight, FileSpreadsheet, ArrowRight, Stethoscope, CalendarDays, History,
} from "lucide-react";
import {
  Unit, UNITS, UNIT_NAMES, UNIT_COLORS, UNIT_EXPORT_NAMES,
  OperationTag, OPERATION_TAG_ORDER, OperationTagPicker,
  operationsToExportText, MONTHS, MONTHS_SHORT,
} from "./App";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface DailyItem {
  id: number;
  unit: Unit;
  projectName: string;
  operations?: OperationTag[];
}

interface DailyDay {
  id: number;
  date: string; // YYYY-MM-DD
  holidayName: string | null;
  holidayOverride: number | null; // null = sem decisão, 0 = excluído, 1 = considerado útil
  isBusinessDay: boolean;
  atestado: boolean;
  items: DailyItem[];
}

interface DailyPeriod {
  id: string;
  month: number;
  year: number;
  status: "open" | "closed";
  days: DailyDay[];
}

interface PeriodSummary {
  id: string;
  month: number;
  year: number;
  status: "open" | "closed";
}

// Projeto já usado antes, com os centros de custo historicamente ligados a ele
// (usado pra sugerir o centro de custo certo quando o mesmo projeto é digitado de novo).
interface ProjectCatalogEntry {
  name: string;
  units: Unit[];
}

// Um projeto lançado num dia, com todos os centros de custo/operações reunidos
// numa única entrada (cada centro é um daily_day_item separado no banco).
interface GroupedEntry {
  projectName: string;
  units: Unit[];
  operations: OperationTag[];
  itemIds: number[];
}

function groupDayItems(items: DailyItem[]): GroupedEntry[] {
  const byProject = new Map<string, { units: Set<Unit>; operations: Set<OperationTag>; itemIds: number[] }>();
  for (const item of items) {
    let g = byProject.get(item.projectName);
    if (!g) { g = { units: new Set(), operations: new Set(), itemIds: [] }; byProject.set(item.projectName, g); }
    g.units.add(item.unit);
    g.itemIds.push(item.id);
    if (item.unit === "fraga" && item.operations) item.operations.forEach((tag) => g!.operations.add(tag));
  }
  return [...byProject.entries()].map(([projectName, g]) => ({
    projectName,
    units: UNITS.filter((u) => g.units.has(u)),
    operations: OPERATION_TAG_ORDER.filter((t) => g.operations.has(t)),
    itemIds: g.itemIds,
  }));
}

const WEEKDAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const WEEKDAY_FULL = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];

function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fmtDayLabel(iso: string) {
  const d = parseISODate(iso);
  return `${String(d.getDate()).padStart(2, "0")} · ${WEEKDAY_LABELS[d.getDay()]}`;
}

function fmtDayFull(iso: string) {
  const d = parseISODate(iso);
  return `${WEEKDAY_FULL[d.getDay()]}, ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Por padrão, cai no dia de hoje (ou no último dia útil antes de hoje, se hoje
// ainda não estiver na lista) — evita ter que rolar o mês inteiro pra achar o dia atual.
function defaultDayIndex(days: DailyDay[]) {
  const t = todayISO();
  let idx = -1;
  for (let i = 0; i < days.length; i++) {
    if (days[i].date <= t) idx = i;
    else break;
  }
  return idx === -1 ? 0 : idx;
}

// ─── Exportação para Excel ────────────────────────────────────────────────────

// Se todos os centros de custo foram marcados, mostra "Todos"; senão lista os
// que foram usados (ex: "Wolf Vendas + Profit").
function unitsToExportText(units: Unit[]): string {
  if (units.length >= UNITS.length) return "Todos";
  return units.map((u) => UNIT_EXPORT_NAMES[u]).join(" + ");
}

// O lançamento é diário e pode ter mais de um centro de custo no mesmo dia — o
// relatório final junta isso em uma linha só por projeto (coluna EMPRESA lista
// os centros usados) e soma o total de dias do mês.
function exportDailyPeriodToExcel(period: DailyPeriod, displayName: string) {
  const competencia = `${MONTHS_SHORT[period.month - 1]}-${String(period.year).slice(-2)}`;

  const header = [
    "",
    "COMPETÊNCIA",
    "COLABORADOR (Nome Completo)",
    "ATIVIDADES (Descrever do que se trata)",
    "EMPRESA",
    "OBS. EMPRESA",
    "OPERAÇÃO (Para qual operação é a atividade)",
    "OBS. OPERAÇÃO",
    "HORAS/DIAS",
  ];

  const totals = new Map<string, { projectName: string; units: Unit[]; operations: OperationTag[]; days: number }>();
  let atestadoDays = 0;

  for (const day of period.days) {
    if (!day.isBusinessDay) continue;
    if (day.atestado) { atestadoDays += 1; continue; }

    // Cada projeto do dia já vem com todos os centros/operações juntos — não
    // conta o dia duas vezes. Se o dia tiver mais de um projeto, o dia é
    // dividido igualmente entre eles (2 projetos = 0,5 cada; 3 = 0,33 cada...).
    const groups = groupDayItems(day.items);
    if (groups.length === 0) continue;
    const share = 1 / groups.length;
    for (const g of groups) {
      const key = `${g.projectName}|${g.units.join(",")}|${g.operations.join(",")}`;
      const existing = totals.get(key);
      if (existing) existing.days += share;
      else totals.set(key, { projectName: g.projectName, units: g.units, operations: g.operations, days: share });
    }
  }

  const rows: (string | number)[][] = [header];
  for (const t of totals.values()) {
    t.days = Math.round(t.days * 100) / 100;
    const empresaText = unitsToExportText(t.units);
    const operacaoText = t.units.includes("fraga") ? operationsToExportText(t.operations) : "";
    rows.push(["", competencia, displayName, t.projectName, empresaText, "", operacaoText, "", t.days]);
  }
  if (atestadoDays > 0) {
    rows.push(["", competencia, displayName, "Atestado", "", "", "", "", atestadoDays]);
  }

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 2 }, { wch: 12 }, { wch: 28 }, { wch: 40 },
    { wch: 16 }, { wch: 14 }, { wch: 34 }, { wch: 14 }, { wch: 11 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Atividades");
  XLSX.writeFile(workbook, `Rateio Diário - ${MONTHS[period.month - 1]} ${period.year}.xlsx`);
}

// ─── Formulário de lançamento (serve tanto pra adicionar quanto pra editar) ──

function ProjectEntryForm({
  projectCatalog,
  initialName = "",
  initialUnits = [],
  initialOperations = [],
  submitLabel = "Adicionar",
  onSubmit,
  onCancel,
}: {
  projectCatalog: ProjectCatalogEntry[];
  initialName?: string;
  initialUnits?: Unit[];
  initialOperations?: OperationTag[];
  submitLabel?: string;
  onSubmit: (units: Unit[], projectName: string, operations?: OperationTag[]) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [units, setUnits] = useState<Unit[]>(initialUnits);
  const [operations, setOperations] = useState<OperationTag[]>(initialOperations);

  const allSelected = units.length === UNITS.length;

  const toggleUnit = (u: Unit) => {
    setUnits((prev) => (prev.includes(u) ? prev.filter((x) => x !== u) : [...prev, u]));
    if (u === "fraga") setOperations([]);
  };

  const toggleAll = () => {
    if (allSelected) { setUnits([]); setOperations([]); }
    else setUnits([...UNITS]);
  };

  // Projeto já usado antes: sugere de novo os centros de custo ligados a ele,
  // pra não ter que marcar tudo de novo toda vez que repetir o mesmo projeto.
  const handleNameChange = (value: string) => {
    setName(value);
    if (units.length === 0) {
      const known = projectCatalog.find((p) => p.name.toLowerCase() === value.trim().toLowerCase());
      if (known && known.units.length > 0) setUnits(known.units);
    }
  };

  const valid = name.trim().length > 0 && units.length > 0 && (!units.includes("fraga") || operations.length > 0);

  const submit = () => {
    if (!valid) return;
    onSubmit(units, name.trim(), units.includes("fraga") ? operations : undefined);
    if (!onCancel) {
      setName("");
      setUnits([]);
      setOperations([]);
    }
  };

  return (
    <div className="bg-[#f7f7f8] rounded-lg p-2.5 space-y-2.5">
      <div>
        <label className="block text-[9px] font-semibold uppercase tracking-wider text-[#a1a1aa] mb-1">Projeto</label>
        <input
          type="text"
          value={name}
          list="daily-project-catalog"
          placeholder="Nome do projeto…"
          onChange={(e) => handleNameChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          className="w-full h-7 px-2.5 text-xs bg-white border border-[rgba(0,0,0,0.1)] rounded-lg outline-none focus:border-[#18181b]"
        />
      </div>
      <div>
        <label className="block text-[9px] font-semibold uppercase tracking-wider text-[#a1a1aa] mb-1">Centro de custo</label>
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={toggleAll}
            className="h-6 px-2 rounded-md text-[10px] font-semibold border transition-all"
            style={allSelected
              ? { backgroundColor: "#18181b", borderColor: "#18181b", color: "#fff" }
              : { backgroundColor: "#fff", borderColor: "rgba(0,0,0,0.1)", color: "#71717a" }}
          >
            Todos
          </button>
          {UNITS.map((u) => {
            const active = units.includes(u);
            return (
              <button
                key={u}
                type="button"
                onClick={() => toggleUnit(u)}
                className="h-6 px-2 rounded-md text-[10px] font-semibold border transition-all"
                style={active
                  ? { backgroundColor: UNIT_COLORS[u], borderColor: UNIT_COLORS[u], color: "#fff" }
                  : { backgroundColor: "#fff", borderColor: "rgba(0,0,0,0.1)", color: "#71717a" }}
              >
                {UNIT_NAMES[u]}
              </button>
            );
          })}
        </div>
      </div>
      {units.includes("fraga") && (
        <div>
          <label className="block text-[9px] font-semibold uppercase tracking-wider text-[#a1a1aa] mb-1">Operação</label>
          <OperationTagPicker value={operations} onChange={setOperations} />
        </div>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button onClick={onCancel} className="h-7 px-3 text-xs font-medium text-[#71717a] hover:text-[#18181b] rounded-lg hover:bg-white transition-all">
            Cancelar
          </button>
        )}
        <button
          onClick={submit}
          disabled={!valid}
          className="h-7 px-3 flex items-center gap-1 rounded-lg bg-[#18181b] text-white text-xs font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#27272a] transition-all"
        >
          <Plus size={13} />{submitLabel}
        </button>
      </div>
    </div>
  );
}

// ─── Lançamento já salvo (exibição + edição) ─────────────────────────────────

function ItemGroupRow({
  group,
  disabled,
  onEdit,
  onRemove,
}: {
  group: GroupedEntry;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 group">
      <span className="text-xs flex-1 truncate">{group.projectName}</span>
      <div className="flex items-center gap-1 flex-wrap justify-end shrink-0">
        {group.units.map((u) => (
          <span key={u} className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#f1f1f3]" style={{ color: UNIT_COLORS[u] }}>
            {UNIT_NAMES[u]}
          </span>
        ))}
        {group.operations.length > 0 && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#f1f1f3] text-[#71717a]">
            {operationsToExportText(group.operations)}
          </span>
        )}
      </div>
      {!disabled && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
          <button onClick={onEdit} className="w-5 h-5 flex items-center justify-center rounded hover:bg-[#f1f1f3] text-[#a1a1aa] hover:text-[#18181b] transition-all">
            <Pencil size={10} />
          </button>
          <button onClick={onRemove} className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-50 hover:text-red-400 text-[#c0c0c8] transition-all">
            <X size={10} strokeWidth={2.5} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Linha de um dia ──────────────────────────────────────────────────────────

function DayRow({
  day,
  disabled,
  projectCatalog = [],
  onPatch,
  onAddItem,
  onEditGroup,
  onRemoveGroup,
}: {
  day: DailyDay;
  disabled: boolean;
  projectCatalog?: ProjectCatalogEntry[];
  onPatch: (dayId: number, body: { atestado?: boolean; holidayOverride?: boolean }) => void;
  onAddItem: (dayId: number, units: Unit[], projectName: string, operations?: OperationTag[]) => void;
  onEditGroup: (dayId: number, oldItemIds: number[], units: Unit[], projectName: string, operations?: OperationTag[]) => void;
  onRemoveGroup: (itemIds: number[]) => void;
}) {
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const excludedHoliday = !!day.holidayName && !day.isBusinessDay;

  return (
    <div className={`rounded-xl border p-3.5 ${excludedHoliday ? "bg-[#fafafa] border-[rgba(0,0,0,0.05)]" : "bg-white border-[rgba(0,0,0,0.07)]"}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold tabular-nums w-16" style={{ fontFamily: "var(--font-mono)" }}>{fmtDayLabel(day.date)}</span>
          {day.holidayName && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600">Feriado: {day.holidayName}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {day.holidayName && !disabled && (
            <button
              onClick={() => onPatch(day.id, { holidayOverride: !day.isBusinessDay })}
              className="text-[11px] font-medium text-[#71717a] hover:text-[#18181b] underline decoration-dotted"
            >
              {day.isBusinessDay ? "Marcar como não útil" : "Considerar como dia útil"}
            </button>
          )}
          {day.isBusinessDay && (
            <label className={`flex items-center gap-1.5 text-xs ${disabled ? "text-[#c0c0c8]" : "text-[#71717a] cursor-pointer"}`}>
              <input
                type="checkbox"
                checked={day.atestado}
                disabled={disabled}
                onChange={(e) => onPatch(day.id, { atestado: e.target.checked })}
                className="accent-[#18181b]"
              />
              <Stethoscope size={12} />Atestado
            </label>
          )}
        </div>
      </div>

      {day.isBusinessDay && !day.atestado && (
        <div className="mt-2.5 space-y-1.5">
          {groupDayItems(day.items).map((group) =>
            editingProject === group.projectName ? (
              <ProjectEntryForm
                key={group.projectName}
                projectCatalog={projectCatalog}
                initialName={group.projectName}
                initialUnits={group.units}
                initialOperations={group.operations}
                submitLabel="Salvar"
                onCancel={() => setEditingProject(null)}
                onSubmit={(units, name, ops) => {
                  onEditGroup(day.id, group.itemIds, units, name, ops);
                  setEditingProject(null);
                }}
              />
            ) : (
              <ItemGroupRow
                key={group.projectName}
                group={group}
                disabled={disabled}
                onEdit={() => setEditingProject(group.projectName)}
                onRemove={() => onRemoveGroup(group.itemIds)}
              />
            )
          )}
          {!disabled && editingProject === null && (
            <ProjectEntryForm projectCatalog={projectCatalog} onSubmit={(units, name, ops) => onAddItem(day.id, units, name, ops)} />
          )}
          {disabled && day.items.length === 0 && <p className="text-xs text-[#c0c0c8]">Sem lançamentos</p>}
        </div>
      )}

      {day.atestado && <p className="mt-2 text-xs text-[#a1a1aa]">Dia registrado como atestado.</p>}
    </div>
  );
}

// ─── Navegador de dia (mostra só um dia por vez) ─────────────────────────────

function DayNavigator({
  days,
  index,
  defaultIndex,
  onChange,
}: {
  days: DailyDay[];
  index: number;
  defaultIndex: number;
  onChange: (index: number) => void;
}) {
  const day = days[index];
  return (
    <div className="flex items-center justify-between gap-2">
      <button
        onClick={() => onChange(Math.max(0, index - 1))}
        disabled={index === 0}
        className="h-8 px-3 text-xs font-medium bg-white border border-[rgba(0,0,0,0.1)] rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:border-[rgba(0,0,0,0.2)] transition-all flex items-center gap-1 shrink-0"
      >
        <ChevronLeft size={14} />Dia anterior
      </button>
      <div className="text-center min-w-0">
        <p className="text-sm font-semibold truncate">{fmtDayFull(day.date)}</p>
        {index !== defaultIndex && (
          <button onClick={() => onChange(defaultIndex)} className="text-[11px] text-[#71717a] hover:text-[#18181b] underline decoration-dotted">
            Voltar para hoje
          </button>
        )}
      </div>
      <button
        onClick={() => onChange(Math.min(days.length - 1, index + 1))}
        disabled={index === days.length - 1}
        className="h-8 px-3 text-xs font-medium bg-white border border-[rgba(0,0,0,0.1)] rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:border-[rgba(0,0,0,0.2)] transition-all flex items-center gap-1 shrink-0"
      >
        Próximo dia<ChevronRight size={14} />
      </button>
    </div>
  );
}

// ─── Linha compacta da visão geral do mês ────────────────────────────────────

function MonthOverviewRow({ day, onOpen }: { day: DailyDay; onOpen: () => void }) {
  const excludedHoliday = !!day.holidayName && !day.isBusinessDay;
  return (
    <button
      onClick={onOpen}
      className={`w-full text-left rounded-lg border px-3 py-2 flex items-center gap-3 transition-all hover:border-[rgba(0,0,0,0.2)] ${excludedHoliday ? "bg-[#fafafa] border-[rgba(0,0,0,0.05)]" : "bg-white border-[rgba(0,0,0,0.07)]"}`}
    >
      <span className="text-xs font-semibold tabular-nums w-16 shrink-0" style={{ fontFamily: "var(--font-mono)" }}>{fmtDayLabel(day.date)}</span>
      {day.holidayName && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 shrink-0">
          Feriado{day.isBusinessDay ? " (útil)" : ""}
        </span>
      )}
      {day.isBusinessDay && day.atestado && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 shrink-0">Atestado</span>
      )}
      {day.isBusinessDay && !day.atestado && day.items.length === 0 && (
        <span className="text-xs text-[#c0c0c8]">Sem lançamentos</span>
      )}
      {day.isBusinessDay && !day.atestado && day.items.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap min-w-0 flex-1">
          {groupDayItems(day.items).map((group) => (
            <span key={group.projectName} className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#f1f1f3] text-[#71717a] shrink-0">
              {group.projectName}
            </span>
          ))}
        </div>
      )}
      <ChevronRight size={14} className="text-[#c0c0c8] ml-auto shrink-0" />
    </button>
  );
}

// ─── Tela principal ───────────────────────────────────────────────────────────

export default function DailyRateio({ displayName }: { displayName: string }) {
  const now = new Date();
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<DailyPeriod | null>(null);
  const [pastPeriods, setPastPeriods] = useState<PeriodSummary[]>([]);
  const [projectCatalog, setProjectCatalog] = useState<ProjectCatalogEntry[]>([]);
  const [viewing, setViewing] = useState<DailyPeriod | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [viewingDayIndex, setViewingDayIndex] = useState(0);
  const [monthView, setMonthView] = useState(false);
  const [firstMonth, setFirstMonth] = useState(now.getMonth() + 1);
  const [firstYear, setFirstYear] = useState(now.getFullYear());

  useEffect(() => { if (period) setDayIndex(defaultDayIndex(period.days)); }, [period?.id]);
  useEffect(() => { if (viewing) setViewingDayIndex(defaultDayIndex(viewing.days)); }, [viewing?.id]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([apiGet("/daily/current"), apiGet("/daily/projects"), apiGet("/daily/periods")])
      .then(([cur, projs, periods]) => {
        setPeriod(cur);
        setProjectCatalog(projs);
        setPastPeriods(periods);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const startFirstPeriod = () => {
    apiPost("/daily/periods", { month: firstMonth, year: firstYear })
      .then((p) => { setPeriod(p); load(); })
      .catch((e) => alert(e.message));
  };

  const patchDay = (dayId: number, body: { atestado?: boolean; holidayOverride?: boolean }) => {
    if (!period) return;
    apiPatch(`/daily/days/${dayId}`, body)
      .then((updated: DailyDay) => {
        setPeriod((p) => p ? { ...p, days: p.days.map((d) => d.id === dayId ? updated : d) } : p);
      })
      .catch((e) => alert(e.message));
  };

  const addItem = (dayId: number, units: Unit[], projectName: string, operations?: OperationTag[]) => {
    if (!period) return;
    Promise.all(
      units.map((unit) =>
        apiPost(`/daily/days/${dayId}/items`, { unit, projectName, operations: unit === "fraga" ? operations : undefined })
      )
    )
      .then((items: DailyItem[]) => {
        setPeriod((p) => p ? { ...p, days: p.days.map((d) => d.id === dayId ? { ...d, items: [...d.items, ...items] } : d) } : p);
        setProjectCatalog((c) => {
          const idx = c.findIndex((p) => p.name === projectName);
          if (idx === -1) {
            return [...c, { name: projectName, units: [...units] }].sort((a, b) => a.name.localeCompare(b.name));
          }
          const merged = UNITS.filter((u) => c[idx].units.includes(u) || units.includes(u));
          const next = [...c];
          next[idx] = { name: projectName, units: merged };
          return next;
        });
      })
      .catch((e) => alert(e.message));
  };

  const removeItems = (itemIds: number[]) => {
    if (!period) return;
    Promise.all(itemIds.map((id) => apiDelete(`/daily/items/${id}`)))
      .then(() => {
        setPeriod((p) => p ? { ...p, days: p.days.map((d) => ({ ...d, items: d.items.filter((it) => !itemIds.includes(it.id)) })) } : p);
      })
      .catch((e) => alert(e.message));
  };

  // Editar um lançamento já salvo = trocar todos os itens antigos do projeto
  // (um por centro de custo) pelos novos, com o nome/centros/operação atualizados.
  const editGroup = (dayId: number, oldItemIds: number[], units: Unit[], projectName: string, operations?: OperationTag[]) => {
    if (!period) return;
    Promise.all(oldItemIds.map((id) => apiDelete(`/daily/items/${id}`)))
      .then(() =>
        Promise.all(
          units.map((unit) =>
            apiPost(`/daily/days/${dayId}/items`, { unit, projectName, operations: unit === "fraga" ? operations : undefined })
          )
        )
      )
      .then((newItems: DailyItem[]) => {
        setPeriod((p) => p ? {
          ...p,
          days: p.days.map((d) => d.id === dayId
            ? { ...d, items: [...d.items.filter((it) => !oldItemIds.includes(it.id)), ...newItems] }
            : d),
        } : p);
        setProjectCatalog((c) => {
          const idx = c.findIndex((p) => p.name === projectName);
          if (idx === -1) {
            return [...c, { name: projectName, units: [...units] }].sort((a, b) => a.name.localeCompare(b.name));
          }
          const merged = UNITS.filter((u) => c[idx].units.includes(u) || units.includes(u));
          const next = [...c];
          next[idx] = { name: projectName, units: merged };
          return next;
        });
      })
      .catch((e) => alert(e.message));
  };

  const advanceMonth = () => {
    if (!period) return;
    if (!window.confirm(`Encerrar ${MONTHS[period.month - 1]}/${period.year} e iniciar o próximo mês? Isso não pode ser desfeito.`)) return;
    apiPost(`/daily/periods/${period.id}/advance`, {})
      .then((next: DailyPeriod) => { setPeriod(next); load(); })
      .catch((e) => alert(e.message));
  };

  const openPastPeriod = (id: string) => {
    apiGet(`/daily/periods/${id}`).then(setViewing).catch((e) => alert(e.message));
  };

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-sm text-[#a1a1aa]">Carregando…</div>;
  }

  if (viewing) {
    const idx = Math.min(viewingDayIndex, viewing.days.length - 1);
    const defIdx = defaultDayIndex(viewing.days);
    return (
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-8 py-8 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <button onClick={() => setViewing(null)} className="text-xs text-[#71717a] hover:text-[#18181b] mb-1">← Voltar ao mês atual</button>
              <h1 className="text-xl font-semibold tracking-tight">{MONTHS[viewing.month - 1]} {viewing.year} <span className="text-xs font-normal text-[#a1a1aa]">(encerrado)</span></h1>
            </div>
            <button
              onClick={() => exportDailyPeriodToExcel(viewing, displayName)}
              className="h-8 px-3.5 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all flex items-center gap-1.5"
            >
              <FileSpreadsheet size={14} />Exportar Excel
            </button>
          </div>
          <DayNavigator days={viewing.days} index={idx} defaultIndex={defIdx} onChange={setViewingDayIndex} />
          <DayRow key={viewing.days[idx].id} day={viewing.days[idx]} disabled onPatch={() => {}} onAddItem={() => {}} onEditGroup={() => {}} onRemoveGroup={() => {}} />
        </div>
      </div>
    );
  }

  if (!period) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="max-w-md mx-auto px-8 py-16">
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-8 text-center">
            <div className="w-10 h-10 bg-[#f1f1f3] rounded-xl flex items-center justify-center mb-3 mx-auto"><CalendarDays size={18} className="text-[#a1a1aa]" /></div>
            <p className="text-sm font-semibold">Iniciar rateio diário</p>
            <p className="text-xs text-[#a1a1aa] mt-1 mb-5">Escolha o mês para começar a lançar suas atividades dia a dia</p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="relative">
                <select value={firstMonth} onChange={(e) => setFirstMonth(Number(e.target.value))} className="w-full appearance-none h-8 pl-3 pr-7 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none cursor-pointer">
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#a1a1aa] pointer-events-none" />
              </div>
              <input type="number" value={firstYear} onChange={(e) => setFirstYear(Number(e.target.value))} className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none" style={{ fontFamily: "var(--font-mono)" }} />
            </div>
            <button onClick={startFirstPeriod} className="w-full h-8 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all">Iniciar mês</button>
          </div>
          {pastPeriods.length > 0 && (
            <div className="mt-6">
              <p className="text-xs font-medium text-[#71717a] mb-2 flex items-center gap-1.5"><History size={12} />Meses anteriores</p>
              <div className="space-y-1.5">
                {[...pastPeriods].reverse().map((p) => (
                  <button key={p.id} onClick={() => openPastPeriod(p.id)} className="w-full text-left text-xs px-3 py-2 rounded-lg bg-white border border-[rgba(0,0,0,0.07)] hover:border-[rgba(0,0,0,0.14)] transition-all">
                    {MONTHS[p.month - 1]} {p.year}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const businessDays = period.days.filter((d) => d.isBusinessDay);
  const workedDays = businessDays.filter((d) => d.atestado || d.items.length > 0).length;
  const atestadoDays = businessDays.filter((d) => d.atestado).length;
  const pendingDays = businessDays.length - workedDays;
  const idx = Math.min(dayIndex, period.days.length - 1);
  const defIdx = defaultDayIndex(period.days);

  return (
    <div className="flex-1 overflow-auto">
      <datalist id="daily-project-catalog">
        {projectCatalog.map((p) => <option key={p.name} value={p.name} />)}
      </datalist>
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Meu Rateio Diário</h1>
            <p className="text-xs text-[#71717a] mt-0.5">{MONTHS[period.month - 1]} {period.year}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => exportDailyPeriodToExcel(period, displayName)}
              className="h-8 px-3.5 text-sm font-medium bg-white border border-[rgba(0,0,0,0.1)] rounded-lg hover:border-[rgba(0,0,0,0.2)] transition-all flex items-center gap-1.5"
            >
              <FileSpreadsheet size={14} />Exportar Excel
            </button>
            <button
              onClick={advanceMonth}
              className="h-8 px-3.5 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all flex items-center gap-1.5"
            >
              Iniciar próximo mês<ArrowRight size={14} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[#a1a1aa]">Dias úteis</p>
            <p className="text-lg font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{businessDays.length}</p>
          </div>
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[#a1a1aa]">Lançados</p>
            <p className="text-lg font-semibold tabular-nums text-emerald-600" style={{ fontFamily: "var(--font-mono)" }}>{workedDays}</p>
          </div>
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[#a1a1aa]">Atestado</p>
            <p className="text-lg font-semibold tabular-nums text-amber-600" style={{ fontFamily: "var(--font-mono)" }}>{atestadoDays}</p>
          </div>
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[#a1a1aa]">Pendentes</p>
            <p className={`text-lg font-semibold tabular-nums ${pendingDays > 0 ? "text-red-500" : ""}`} style={{ fontFamily: "var(--font-mono)" }}>{pendingDays}</p>
          </div>
        </div>

        <div className="flex items-center gap-1 bg-[#f1f1f3] rounded-lg p-1 w-fit">
          <button
            onClick={() => setMonthView(false)}
            className={`h-7 px-3 text-xs font-medium rounded-md transition-all ${!monthView ? "bg-white shadow-sm text-[#18181b]" : "text-[#71717a]"}`}
          >
            Dia atual
          </button>
          <button
            onClick={() => setMonthView(true)}
            className={`h-7 px-3 text-xs font-medium rounded-md transition-all ${monthView ? "bg-white shadow-sm text-[#18181b]" : "text-[#71717a]"}`}
          >
            Visão do mês
          </button>
        </div>

        {monthView ? (
          <div className="space-y-1.5">
            {period.days.map((day) => (
              <MonthOverviewRow
                key={day.id}
                day={day}
                onOpen={() => { setDayIndex(period.days.findIndex((d) => d.id === day.id)); setMonthView(false); }}
              />
            ))}
          </div>
        ) : (
          <>
            <DayNavigator days={period.days} index={idx} defaultIndex={defIdx} onChange={setDayIndex} />
            <DayRow
              key={period.days[idx].id}
              day={period.days[idx]}
              disabled={false}
              projectCatalog={projectCatalog}
              onPatch={patchDay}
              onAddItem={addItem}
              onEditGroup={editGroup}
              onRemoveGroup={removeItems}
            />
          </>
        )}
      </div>
    </div>
  );
}
