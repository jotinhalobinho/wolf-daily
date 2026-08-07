import { useState, useEffect, useCallback } from "react";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from "./api";
import * as XLSX from "xlsx";
import {
  LayoutDashboard, Users, FileBarChart2, Settings, Plus,
  ChevronDown, CheckCircle2, AlertCircle, Clock, FileSpreadsheet, Printer,
  Trash2, Pencil, X, Check, Zap, Lock, Unlock, Shield,
  User, ChevronRight, CalendarDays, Send, MessageSquare,
  ExternalLink, LogOut, KeyRound,
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import DailyRateio from "./DailyRateio";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Unit = "wolf" | "fraga" | "woncred" | "profit";
type View = "dashboard" | "rateio" | "diario" | "projetos" | "colaboradores" | "acessos" | "relatorios" | "configuracoes";
type UserRole = "admin" | "collaborator";
type RateioStatus = "open" | "approved";

interface Collaborator {
  id: string;
  name: string;
  role: string;
  salary: number;
}

interface UnitProject {
  name: string;
  days: number;
  // Tags de operação — só usadas para itens do centro de custo "fraga".
  operations?: OperationTag[];
}

// "ALL" representa a opção "Todas as operações".
export type OperationTag = "HS" | "NC" | "NAS" | "ALL";

export const OPERATION_CHIP_LABELS: Record<OperationTag, string> = {
  ALL: "Todas",
  HS: "HS",
  NC: "NC",
  NAS: "NA's",
};

const OPERATION_EXPORT_LABELS: Record<Exclude<OperationTag, "ALL">, string> = {
  HS: "Contemplada (HS)",
  NAS: "Contemplada (Outras ADM's)",
  NC: "Não Contemplada",
};

export function operationsToExportText(operations?: OperationTag[]): string {
  if (!operations || operations.length === 0) return "";
  if (operations.includes("ALL")) return "Todas";
  return operations
    .filter((t): t is Exclude<OperationTag, "ALL"> => t !== "ALL")
    .map((t) => OPERATION_EXPORT_LABELS[t])
    .join(" + ");
}

interface RateioEntry {
  collaboratorId: string;
  unitProjects: Record<Unit, UnitProject[]>;
  generalProjects: UnitProject[];
  // Dias de atestado/afastamento no período — cada dia lançado aqui reduz em 1
  // o total de dias que o colaborador precisa distribuir para completar o rateio.
  atestados: UnitProject[];
  observations: string;
  submitted: boolean;
}

interface RateioRelease {
  id: string;
  month: number;
  year: number;
  workingDays: number;
  deadline: string; // ISO date string
  status: RateioStatus;
  entries: RateioEntry[];
  approvedAt?: string;
}

interface ProjectMember {
  collaboratorId: string;
  days: number;
}

interface Project {
  id: string;
  name: string;
  description: string;
  requester: string;
  month: number;
  year: number;
  startDate: string;
  endDate: string;
  costCenters: Unit[];
  splits: Record<Unit, number>;
  members: ProjectMember[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const UNITS: Unit[] = ["wolf", "fraga", "woncred", "profit"];

export const UNIT_NAMES: Record<Unit, string> = {
  wolf: "Wolf Consórcios",
  fraga: "Fraga & Bitello",
  woncred: "Woncred",
  profit: "Profit",
};

export const UNIT_COLORS: Record<Unit, string> = {
  wolf: "#3b82f6",
  fraga: "#8b5cf6",
  woncred: "#10b981",
  profit: "#f59e0b",
};

export const UNIT_LIGHT: Record<Unit, string> = {
  wolf: "#eff6ff",
  fraga: "#f5f3ff",
  woncred: "#ecfdf5",
  profit: "#fffbeb",
};

export const MONTHS = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

// Abreviações usadas na coluna COMPETÊNCIA da planilha (ex: "Jun-26").
export const MONTHS_SHORT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

// Nomes de empresa usados no modelo de planilha de exportação (podem diferir dos rótulos exibidos na tela).
export const UNIT_EXPORT_NAMES: Record<Unit, string> = {
  wolf: "Wolf Vendas",
  fraga: "Fraga e Bitello",
  woncred: "Woncred",
  profit: "Profit",
};

// Nenhum colaborador vem pré-cadastrado: a lista é carregada do banco de dados via API.

// ─── Utilities ────────────────────────────────────────────────────────────────

const fmt = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

const dailyRate = (salary: number, workingDays: number) => salary / workingDays;

const unitTotal = (e: RateioEntry, u: Unit) =>
  (e.unitProjects?.[u] ?? []).reduce((s, p) => s + p.days, 0);

const generalTotal = (e: RateioEntry) =>
  (e.generalProjects ?? []).reduce((s, p) => s + p.days, 0);

const entryTotal = (e: RateioEntry) =>
  UNITS.reduce((s, u) => s + unitTotal(e, u), 0) + generalTotal(e);

const atestadoTotal = (e: RateioEntry) =>
  (e.atestados ?? []).reduce((s, p) => s + p.days, 0);

// Total de dias que o colaborador precisa distribuir para "completar" o
// período: os dias úteis do período menos os dias de atestado lançados.
const requiredDays = (workingDays: number, e: RateioEntry) =>
  Math.max(0, workingDays - atestadoTotal(e));

const blankEntry = (collaboratorId: string): RateioEntry => ({
  collaboratorId,
  unitProjects: { wolf: [], fraga: [], woncred: [], profit: [] },
  generalProjects: [],
  atestados: [],
  observations: "", submitted: false,
});

const equalSplit = (units: Unit[]): Record<Unit, number> => {
  const base = units.length > 0 ? Math.floor(100 / units.length) : 0;
  const rem = 100 - base * units.length;
  const result = { wolf: 0, fraga: 0, woncred: 0, profit: 0 } as Record<Unit, number>;
  units.forEach((u, i) => { result[u] = base + (i === 0 ? rem : 0); });
  return result;
};

const projectCost = (project: Project, collaborators: Collaborator[], workingDays: number) =>
  project.members.reduce((sum, m) => {
    const c = collaborators.find((x) => x.id === m.collaboratorId);
    return sum + (c ? m.days * dailyRate(c.salary, workingDays) : 0);
  }, 0);

const projectUnitCost = (project: Project, unit: Unit, collaborators: Collaborator[], workingDays: number) =>
  projectCost(project, collaborators, workingDays) * (project.splits[unit] / 100);

const computeProjectDays = (
  projects: Project[], month: number, year: number
): Map<string, Record<Unit, number>> => {
  const result = new Map<string, Record<Unit, number>>();
  for (const project of projects) {
    if (project.month !== month || project.year !== year) continue;
    for (const member of project.members) {
      if (!member.days) continue;
      const entry = result.get(member.collaboratorId) ?? { wolf: 0, fraga: 0, woncred: 0, profit: 0 };
      for (const unit of project.costCenters) {
        entry[unit] += member.days * (project.splits[unit] / 100);
      }
      result.set(member.collaboratorId, entry);
    }
  }
  result.forEach((v) => { UNITS.forEach((u) => { v[u] = Math.round(v[u]); }); });
  return result;
};

const fmtDate = (iso: string) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

// ─── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ total, workingDays }: { total: number; workingDays: number }) {
  if (total === 0) return <span className="inline-flex items-center gap-1 text-xs text-[#a1a1aa]"><Clock size={11} />Pendente</span>;
  if (total === workingDays) return <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"><CheckCircle2 size={11} />Completo</span>;
  if (total > workingDays) return <span className="inline-flex items-center gap-1 text-xs font-medium text-red-500"><AlertCircle size={11} />{total}/{workingDays}</span>;
  return <span className="inline-flex items-center gap-1 text-xs text-amber-600"><AlertCircle size={11} />{total}/{workingDays}</span>;
}

function ProgressBar({ total, workingDays }: { total: number; workingDays: number }) {
  const pct = workingDays > 0 ? Math.min((total / workingDays) * 100, 100) : 0;
  const color = total === workingDays ? "#10b981" : total > workingDays ? "#ef4444" : total > 0 ? "#f59e0b" : "#e4e4e7";
  return (
    <div className="w-full h-1 bg-[#f1f1f3] rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

function Avatar({ name, size = 7 }: { name: string; size?: number }) {
  return (
    <div
      className={`rounded-full bg-[#f1f1f3] flex items-center justify-center text-xs font-semibold text-[#71717a] shrink-0`}
      style={{ width: size * 4, height: size * 4 }}
    >
      {name.charAt(0)}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

interface SidebarProps {
  active: View;
  onNav: (v: View) => void;
  role: UserRole;
  displayName: string;
  displaySubtitle: string;
  onLogout: () => void;
}

const ADMIN_NAV: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={16} /> },
  { id: "rateio", label: "Rateio Mensal", icon: <FileBarChart2 size={16} /> },
  { id: "diario", label: "Meu Rateio Diário", icon: <CalendarDays size={16} /> },
  { id: "projetos", label: "Projetos", icon: <FileSpreadsheet size={16} /> },
  { id: "colaboradores", label: "Colaboradores", icon: <Users size={16} /> },
  { id: "acessos", label: "Acessos", icon: <KeyRound size={16} /> },
  { id: "configuracoes", label: "Configurações", icon: <Settings size={16} /> },
];

const COLLAB_NAV: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={16} /> },
  { id: "rateio", label: "Meu Rateio", icon: <FileBarChart2 size={16} /> },
  { id: "diario", label: "Meu Rateio Diário", icon: <CalendarDays size={16} /> },
];

function Sidebar({ active, onNav, role, displayName, displaySubtitle, onLogout }: SidebarProps) {
  const nav = role === "admin" ? ADMIN_NAV : COLLAB_NAV;
  return (
    <aside className="w-56 shrink-0 h-screen flex flex-col border-r border-[rgba(0,0,0,0.06)] bg-white">
      <div className="h-14 flex items-center px-5 border-b border-[rgba(0,0,0,0.06)]">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 bg-[#18181b] rounded-md flex items-center justify-center">
            <Zap size={12} className="text-white" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Rateio TI</span>
        </div>
      </div>
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {nav.map((item) => (
          <button
            key={item.id}
            onClick={() => onNav(item.id)}
            className={`w-full flex items-center gap-2.5 px-3 h-8 rounded-lg text-sm transition-all text-left ${
              active === item.id
                ? "bg-[#f1f1f3] text-[#18181b] font-medium"
                : "text-[#71717a] hover:text-[#18181b] hover:bg-[#f7f7f8]"
            }`}
          >
            <span className={active === item.id ? "text-[#18181b]" : "text-[#a1a1aa]"}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      {/* Usuário logado */}
      <div className="px-3 py-3 border-t border-[rgba(0,0,0,0.06)]">
        <div className="flex items-center gap-2.5 px-1 mb-2">
          <div className="w-7 h-7 rounded-full bg-[#f1f1f3] flex items-center justify-center shrink-0">
            {role === "admin" ? <Shield size={12} className="text-[#71717a]" /> : <User size={12} className="text-[#71717a]" />}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium truncate">{displayName}</p>
            <p className="text-[10px] text-[#a1a1aa] truncate">{displaySubtitle}</p>
          </div>
        </div>
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-2 px-3 h-7 rounded-lg text-xs text-[#71717a] hover:text-red-500 hover:bg-red-50 transition-all"
        >
          <LogOut size={13} />Sair
        </button>
      </div>
    </aside>
  );
}

// ─── CollaboratorForm ─────────────────────────────────────────────────────────

interface CollaboratorFormProps {
  initial?: Partial<Collaborator>;
  workingDays: number;
  onSave: (c: Omit<Collaborator, "id">) => void;
  onCancel: () => void;
}

function CollaboratorForm({ initial, workingDays, onSave, onCancel }: CollaboratorFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? "");
  const [salary, setSalary] = useState(initial?.salary?.toString() ?? "");
  const salaryNum = parseFloat(salary.replace(",", ".")) || 0;
  const daily = workingDays > 0 ? salaryNum / workingDays : 0;
  const valid = name.trim() && role.trim() && salaryNum > 0;
  return (
    <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-[#71717a] mb-1.5">Nome</label>
          <input className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" placeholder="Nome completo" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#71717a] mb-1.5">Cargo</label>
          <input className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" placeholder="Cargo" value={role} onChange={(e) => setRole(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#71717a] mb-1.5">Salário Mensal</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-[#a1a1aa]">R$</span>
            <input className="w-full h-8 pl-7 pr-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" placeholder="0,00" value={salary} onChange={(e) => setSalary(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-[#71717a] mb-1.5">Valor por Dia</label>
          <div className="h-8 px-3 flex items-center text-sm rounded-lg bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] text-[#71717a]" style={{ fontFamily: "var(--font-mono)" }}>
            {daily > 0 ? fmt(daily) : "—"}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onCancel} className="h-8 px-4 text-sm text-[#71717a] hover:text-[#18181b] rounded-lg hover:bg-[#f4f4f6] transition-all">Cancelar</button>
        <button onClick={() => valid && onSave({ name: name.trim(), role: role.trim(), salary: salaryNum })} disabled={!valid} className="h-8 px-4 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] disabled:opacity-40 disabled:cursor-not-allowed transition-all">Salvar</button>
      </div>
    </div>
  );
}

// ─── ProjectEntryInput ────────────────────────────────────────────────────────

interface ProjectEntryInputProps {
  projects: UnitProject[];
  color: string;
  lightBg: string;
  disabled?: boolean;
  showOperations?: boolean;
  // Rótulo usado nos placeholders do campo de nome (ex: "projeto", "atestado").
  itemLabel?: string;
  onChange: (projects: UnitProject[]) => void;
}

export const OPERATION_TAG_ORDER: OperationTag[] = ["ALL", "HS", "NC", "NAS"];

export function OperationTagPicker({ value, disabled, onChange }: { value: OperationTag[]; disabled?: boolean; onChange: (next: OperationTag[]) => void }) {
  const toggle = (tag: OperationTag) => {
    if (disabled) return;
    if (tag === "ALL") {
      onChange(value.includes("ALL") ? [] : ["ALL"]);
      return;
    }
    const withoutAll = value.filter((t) => t !== "ALL");
    if (withoutAll.includes(tag)) {
      onChange(withoutAll.filter((t) => t !== tag));
    } else {
      onChange([...withoutAll, tag]);
    }
  };

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {OPERATION_TAG_ORDER.map((tag) => {
        const active = value.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            disabled={disabled}
            onClick={() => toggle(tag)}
            className={`h-5 px-1.5 rounded text-[9px] font-semibold uppercase tracking-wide border transition-all disabled:cursor-default ${
              active ? "bg-[#8b5cf6] border-[#8b5cf6] text-white" : "bg-white border-[rgba(0,0,0,0.1)] text-[#a1a1aa] hover:border-[#8b5cf6]/50"
            }`}
          >
            {OPERATION_CHIP_LABELS[tag]}
          </button>
        );
      })}
    </div>
  );
}

function ProjectEntryInput({ projects, color, lightBg, disabled, showOperations, itemLabel = "projeto", onChange }: ProjectEntryInputProps) {
  const [nameInput, setNameInput] = useState("");

  const addProject = () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    onChange([...projects, { name: trimmed, days: 0 }]);
    setNameInput("");
  };

  const updateDays = (idx: number, days: number) => {
    onChange(projects.map((p, i) => i === idx ? { ...p, days: Math.max(0, Math.round(days)) } : p));
  };

  const updateName = (idx: number, name: string) => {
    onChange(projects.map((p, i) => i === idx ? { ...p, name } : p));
  };

  const updateOperations = (idx: number, operations: OperationTag[]) => {
    onChange(projects.map((p, i) => i === idx ? { ...p, operations } : p));
  };

  const remove = (idx: number) => {
    onChange(projects.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-1.5 mt-3">
      {projects.map((p, i) => (
        <div key={i} className="space-y-1 group">
          <div className="flex items-center gap-2">
            {/* Name */}
            <input
              type="text"
              value={p.name}
              disabled={disabled}
              onChange={(e) => updateName(i, e.target.value)}
              className="flex-1 h-7 px-2.5 text-xs font-medium bg-transparent border border-transparent rounded-lg outline-none focus:border-[rgba(0,0,0,0.1)] focus:bg-white transition-all disabled:cursor-default"
              style={{ color }}
            />
            {/* Days */}
            <div className="flex items-center gap-1 shrink-0">
              <input
                type="number"
                min={0}
                step={1}
                value={p.days === 0 ? "" : p.days}
                disabled={disabled}
                placeholder="0"
                onChange={(e) => updateDays(i, Number(e.target.value))}
                onBlur={(e) => updateDays(i, Number(e.target.value))}
                className="w-10 h-7 text-center text-xs font-semibold rounded-lg border outline-none transition-all disabled:cursor-default"
                style={{
                  backgroundColor: p.days > 0 ? lightBg : "#f7f7f8",
                  borderColor: p.days > 0 ? color + "40" : "rgba(0,0,0,0.07)",
                  color: p.days > 0 ? color : "#71717a",
                  fontFamily: "var(--font-mono)",
                }}
              />
              <span className="text-[10px] text-[#a1a1aa] w-5">d</span>
            </div>
            {!disabled && (
              <button
                onClick={() => remove(i)}
                className="w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-400 text-[#c0c0c8] transition-all shrink-0"
              >
                <X size={10} strokeWidth={2.5} />
              </button>
            )}
          </div>
          {showOperations && (
            <div className="pl-0.5">
              <OperationTagPicker value={p.operations ?? []} disabled={disabled} onChange={(ops) => updateOperations(i, ops)} />
            </div>
          )}
        </div>
      ))}

      {!disabled && (
        <div className="flex items-center gap-2 mt-1">
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addProject(); }
            }}
            placeholder={projects.length === 0 ? `Nome do ${itemLabel}… Enter` : `+ adicionar ${itemLabel}…`}
            className="flex-1 h-7 px-2.5 text-xs bg-[#f7f7f8] border border-dashed border-[rgba(0,0,0,0.12)] rounded-lg outline-none transition-all placeholder:text-[#c8c8d0] focus:bg-white"
            onFocus={(e) => { e.currentTarget.style.borderColor = color + "60"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = ""; if (nameInput.trim()) addProject(); }}
          />
          <div className="w-10 h-7 shrink-0" />
          {!disabled && <div className="w-5 shrink-0" />}
        </div>
      )}
    </div>
  );
}

// ─── Admin Rateio ─────────────────────────────────────────────────────────────

interface AdminRateioProps {
  releases: RateioRelease[];
  setReleases: React.Dispatch<React.SetStateAction<RateioRelease[]>>;
  collaborators: Collaborator[];
  workingDays: number;
}

function AdminRateio({ releases, setReleases, collaborators, workingDays }: AdminRateioProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ month: new Date().getMonth(), year: new Date().getFullYear(), workingDays: 22, deadline: "" });

  const selected = releases.find((r) => r.id === selectedId) ?? null;

  const createRelease = () => {
    const id = String(Date.now());
    const r: RateioRelease = {
      id,
      month: form.month,
      year: form.year,
      workingDays: form.workingDays,
      deadline: form.deadline,
      status: "open",
      entries: collaborators.map((c) => blankEntry(c.id)),
    };
    setReleases((prev) => [...prev, r]);
    setSelectedId(r.id);
    setCreating(false);
    apiPost("/releases", { id, month: r.month, year: r.year, workingDays: r.workingDays, deadline: r.deadline }).catch(() => {
      alert("Não foi possível liberar o período. Atualize a página e tente novamente.");
    });
  };

  const updateEntry = (releaseId: string, entry: RateioEntry) => {
    setReleases((prev) => prev.map((r) =>
      r.id === releaseId ? { ...r, entries: r.entries.map((e) => e.collaboratorId === entry.collaboratorId ? entry : e) } : r
    ));
    apiPut(`/releases/${releaseId}/entries/${entry.collaboratorId}`, entry).catch(() => {
      alert("Não foi possível salvar o rateio. Atualize a página e tente novamente.");
    });
  };

  const approveRelease = (releaseId: string) => {
    setReleases((prev) => prev.map((r) =>
      r.id === releaseId ? { ...r, status: "approved", approvedAt: new Date().toISOString() } : r
    ));
    apiPatch(`/releases/${releaseId}`, { status: "approved" }).catch(() => {
      alert("Não foi possível aprovar o período. Atualize a página e tente novamente.");
    });
  };

  if (selected) {
    return <AdminRateioDetail
      release={selected}
      collaborators={collaborators}
      onUpdateEntry={(e) => updateEntry(selected.id, e)}
      onApprove={() => approveRelease(selected.id)}
      onBack={() => setSelectedId(null)}
    />;
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Rateio Mensal</h1>
            <p className="text-xs text-[#71717a] mt-0.5">Gerencie e libere os períodos de rateio</p>
          </div>
          <button onClick={() => setCreating(true)} className="h-8 px-4 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all flex items-center gap-1.5">
            <Plus size={14} />Liberar Rateio
          </button>
        </div>

        {creating && (
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold">Novo Período de Rateio</h3>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-[#71717a] mb-1.5">Mês</label>
                <div className="relative">
                  <select value={form.month} onChange={(e) => setForm((f) => ({ ...f, month: Number(e.target.value) }))} className="w-full appearance-none h-8 pl-3 pr-7 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] cursor-pointer">
                    {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                  </select>
                  <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#a1a1aa] pointer-events-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#71717a] mb-1.5">Ano</label>
                <input type="number" value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: Number(e.target.value) }))} className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" style={{ fontFamily: "var(--font-mono)" }} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#71717a] mb-1.5">Dias Úteis</label>
                <input type="number" min={1} max={31} value={form.workingDays} onChange={(e) => setForm((f) => ({ ...f, workingDays: Number(e.target.value) }))} className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" style={{ fontFamily: "var(--font-mono)" }} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#71717a] mb-1.5">Data Limite</label>
                <input type="date" value={form.deadline} onChange={(e) => setForm((f) => ({ ...f, deadline: e.target.value }))} className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setCreating(false)} className="h-8 px-4 text-sm text-[#71717a] hover:text-[#18181b] rounded-lg hover:bg-[#f4f4f6] transition-all">Cancelar</button>
              <button onClick={createRelease} className="h-8 px-4 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all flex items-center gap-1.5"><Unlock size={13} />Liberar</button>
            </div>
          </div>
        )}

        {releases.length === 0 && !creating ? (
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-16 flex flex-col items-center justify-center text-center">
            <div className="w-10 h-10 bg-[#f1f1f3] rounded-xl flex items-center justify-center mb-3"><Lock size={18} className="text-[#a1a1aa]" /></div>
            <p className="text-sm font-medium">Nenhum período liberado</p>
            <p className="text-xs text-[#a1a1aa] mt-1 mb-4">Libere um período para que os colaboradores possam preencher o rateio</p>
            <button onClick={() => setCreating(true)} className="h-8 px-4 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all">Liberar primeiro período</button>
          </div>
        ) : (
          <div className="space-y-3">
            {[...releases].reverse().map((r) => {
              const total = r.entries.reduce((s, e) => s + entryTotal(e), 0);
              const done = r.entries.filter((e) => entryTotal(e) === requiredDays(r.workingDays, e)).length;
              const totalPossible = r.entries.reduce((s, e) => s + requiredDays(r.workingDays, e), 0);
              return (
                <button key={r.id} onClick={() => setSelectedId(r.id)} className="w-full bg-white border border-[rgba(0,0,0,0.07)] rounded-xl px-5 py-4 text-left hover:border-[rgba(0,0,0,0.14)] hover:shadow-sm transition-all flex items-center gap-4">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${r.status === "approved" ? "bg-emerald-50" : "bg-blue-50"}`}>
                    {r.status === "approved" ? <CheckCircle2 size={16} className="text-emerald-500" /> : <Unlock size={16} className="text-blue-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-semibold">{MONTHS[r.month]} {r.year}</p>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${r.status === "approved" ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}>
                        {r.status === "approved" ? "Aprovado" : "Aberto"}
                      </span>
                      {r.deadline && <span className="text-[10px] text-[#a1a1aa]">Limite: {fmtDate(r.deadline)}</span>}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-[#71717a]">
                      <span>{r.workingDays} dias úteis</span>
                      <span>{done}/{r.entries.length} completos</span>
                      <span>{total}/{totalPossible} dias lançados</span>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-[#a1a1aa] shrink-0" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Exportação para Excel (modelo padrão da planilha da empresa) ────────────

function exportReleaseToExcel(release: RateioRelease, collaborators: Collaborator[]) {
  const competencia = `${MONTHS_SHORT[release.month]}-${String(release.year).slice(-2)}`;

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

  const rows: (string | number)[][] = [header];

  for (const c of collaborators) {
    const entry = release.entries.find((e) => e.collaboratorId === c.id) ?? blankEntry(c.id);

    for (const u of UNITS) {
      for (const p of entry.unitProjects?.[u] ?? []) {
        if (!p.days) continue;
        rows.push([
          "",
          competencia,
          c.name,
          p.name,
          UNIT_EXPORT_NAMES[u],
          "",
          u === "fraga" ? operationsToExportText(p.operations) : "",
          "",
          p.days,
        ]);
      }
    }

    for (const p of entry.generalProjects ?? []) {
      if (!p.days) continue;
      rows.push(["", competencia, c.name, p.name, "", "", "", "", p.days]);
    }

    for (const p of entry.atestados ?? []) {
      if (!p.days) continue;
      rows.push(["", competencia, c.name, p.name, "", "Atestado", "", "", p.days]);
    }
  }

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 2 },
    { wch: 12 },
    { wch: 28 },
    { wch: 40 },
    { wch: 16 },
    { wch: 14 },
    { wch: 34 },
    { wch: 14 },
    { wch: 11 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Atividades");
  XLSX.writeFile(workbook, `Rateio de Horas - ${MONTHS[release.month]} ${release.year}.xlsx`);
}

// ─── Admin Rateio Detail ──────────────────────────────────────────────────────

interface AdminRateioDetailProps {
  release: RateioRelease;
  collaborators: Collaborator[];
  onUpdateEntry: (e: RateioEntry) => void;
  onApprove: () => void;
  onBack: () => void;
}

function AdminRateioDetail({ release, collaborators, onUpdateEntry, onApprove, onBack }: AdminRateioDetailProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const totalFolha = collaborators.reduce((s, c) => s + c.salary, 0);
  const unitTotals = UNITS.map((u) => ({
    unit: u,
    valor: release.entries.reduce((s, e) => {
      const c = collaborators.find((x) => x.id === e.collaboratorId);
      return s + (c ? unitTotal(e, u) * dailyRate(c.salary, release.workingDays) : 0);
    }, 0),
  }));
  const totalRateado = unitTotals.reduce((s, u) => s + u.valor, 0);
  const allComplete = release.entries.every((e) => entryTotal(e) === requiredDays(release.workingDays, e));

  return (
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 overflow-auto">
        <div className="px-8 py-6 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <button onClick={onBack} className="text-xs text-[#71717a] hover:text-[#18181b] mb-2 flex items-center gap-1 transition-colors">← Todos os períodos</button>
              <h1 className="text-xl font-semibold tracking-tight">Rateio — {MONTHS[release.month]} {release.year}</h1>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-xs text-[#71717a]">{release.workingDays} dias úteis</span>
                {release.deadline && <span className="text-xs text-[#71717a]">Limite: {fmtDate(release.deadline)}</span>}
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${release.status === "approved" ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}>
                  {release.status === "approved" ? `Aprovado em ${fmtDate(release.approvedAt?.split("T")[0] ?? "")}` : "Aberto"}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => exportReleaseToExcel(release, collaborators)} className="h-8 px-4 text-sm font-medium bg-white border border-[rgba(0,0,0,0.07)] text-[#18181b] rounded-lg hover:border-[rgba(0,0,0,0.14)] transition-all flex items-center gap-1.5">
                <FileSpreadsheet size={14} />Exportar Excel
              </button>
              {release.status === "open" && (
                <button onClick={onApprove} disabled={!allComplete} className="h-8 px-4 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5">
                  <CheckCircle2 size={14} />Aprovar Rateio
                </button>
              )}
            </div>
          </div>

          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[rgba(0,0,0,0.06)]">
                  <th className="text-left px-5 py-3 text-xs font-medium text-[#71717a]">Colaborador</th>
                  <th className="text-right px-3 py-3 text-xs font-medium text-[#71717a]">Salário</th>
                  <th className="text-right px-3 py-3 text-xs font-medium text-[#71717a]">Valor/Dia</th>
                  {UNITS.map((u) => (
                    <th key={u} className="text-center px-3 py-3 text-xs font-medium" style={{ color: UNIT_COLORS[u] }}>
                      {u === "wolf" ? "Wolf" : u === "fraga" ? "Fraga" : u === "woncred" ? "Woncred" : "Profit"}
                    </th>
                  ))}
                  <th className="text-center px-3 py-3 text-xs font-medium text-[#71717a]">Geral</th>
                  <th className="text-center px-3 py-3 text-xs font-medium text-[#71717a] w-36">Progresso</th>
                  <th className="text-center px-3 py-3 text-xs font-medium text-[#71717a]">Status</th>
                </tr>
              </thead>
              <tbody>
                {collaborators.map((c) => {
                  const entry = release.entries.find((e) => e.collaboratorId === c.id) ?? blankEntry(c.id);
                  const total = entryTotal(entry);
                  const target = requiredDays(release.workingDays, entry);
                  const rate = dailyRate(c.salary, release.workingDays);
                  const isExpanded = expandedId === c.id;
                  return (
                    <>
                      <tr
                        key={c.id}
                        className={`border-b border-[rgba(0,0,0,0.04)] transition-colors cursor-pointer group ${total === target ? "bg-emerald-50/20" : total > target ? "bg-red-50/30" : ""}`}
                        onClick={() => setExpandedId(isExpanded ? null : c.id)}
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={c.name} />
                            <div className="flex-1">
                              <div className="flex items-center gap-1.5">
                                <p className="text-sm font-medium leading-tight">{c.name}</p>
                                {UNITS.some((u) => (entry.unitProjects?.[u] ?? []).length > 0) && (
                                  <span className="text-[9px] font-medium px-1 py-0.5 bg-[#f1f1f3] text-[#71717a] rounded">projetos</span>
                                )}
                                {atestadoTotal(entry) > 0 && (
                                  <span className="text-[9px] font-medium px-1 py-0.5 bg-amber-50 text-amber-600 rounded">atestado {atestadoTotal(entry)}d</span>
                                )}
                              </div>
                              <p className="text-[11px] text-[#a1a1aa] leading-tight">{c.role}</p>
                            </div>
                            <ChevronDown size={12} className={`text-[#c0c0c8] shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right text-sm tabular-nums text-[#71717a]" style={{ fontFamily: "var(--font-mono)" }}>{fmt(c.salary)}</td>
                        <td className="px-3 py-3 text-right text-xs tabular-nums text-[#a1a1aa]" style={{ fontFamily: "var(--font-mono)" }}>{fmt(rate)}</td>
                        {UNITS.map((u) => {
                          const ud = unitTotal(entry, u);
                          return (
                            <td key={u} className="px-3 py-3 text-center">
                              <div className="flex flex-col items-center gap-0.5">
                                <span className={`text-xs font-medium px-1.5 py-0.5 rounded-md tabular-nums ${ud > 0 ? "" : "text-[#d1d1d6]"}`} style={ud > 0 ? { color: UNIT_COLORS[u], backgroundColor: UNIT_LIGHT[u], fontFamily: "var(--font-mono)" } : { fontFamily: "var(--font-mono)" }}>
                                  {ud > 0 ? ud : "—"}
                                </span>
                                {ud > 0 && <span className="text-[9px] tabular-nums" style={{ color: UNIT_COLORS[u], fontFamily: "var(--font-mono)", opacity: 0.7 }}>{fmt(ud * rate)}</span>}
                              </div>
                            </td>
                          );
                        })}
                        {/* Geral column */}
                        {(() => { const gd = generalTotal(entry); return (
                          <td className="px-3 py-3 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span className={`text-xs font-medium px-1.5 py-0.5 rounded-md tabular-nums ${gd > 0 ? "bg-[#f4f4f6] text-[#52525b]" : "text-[#d1d1d6]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                                {gd > 0 ? gd : "—"}
                              </span>
                            </div>
                          </td>
                        ); })()}
                        <td className="px-3 py-3">
                          <div className="space-y-1">
                            <span className="text-[10px] text-[#a1a1aa]" style={{ fontFamily: "var(--font-mono)" }}>{total}/{target}</span>
                            <ProgressBar total={total} workingDays={target} />
                          </div>
                        </td>
                        <td className="px-3 py-3 text-center"><StatusBadge total={total} workingDays={target} /></td>
                      </tr>
                      {isExpanded && (
                        <tr key={`obs-${c.id}`} className="border-b border-[rgba(0,0,0,0.04)] bg-[#fafafa]">
                          <td colSpan={8} className="px-5 py-4">
                            <div className="space-y-3">
                              {/* Projects per unit */}
                              {UNITS.some((u) => (entry.unitProjects?.[u] ?? []).length > 0) && (
                                <div>
                                  <p className="text-[10px] font-semibold text-[#71717a] uppercase tracking-wider mb-2">Projetos por unidade</p>
                                  <div className="flex flex-wrap gap-6">
                                    {UNITS.map((u) => {
                                      const projs = entry.unitProjects?.[u] ?? [];
                                      if (projs.length === 0) return null;
                                      return (
                                        <div key={u} className="min-w-[140px]">
                                          <div className="flex items-center gap-1.5 mb-1.5">
                                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: UNIT_COLORS[u] }} />
                                            <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: UNIT_COLORS[u] }}>{UNIT_NAMES[u]}</p>
                                            <span className="text-[10px] font-semibold tabular-nums ml-auto" style={{ color: UNIT_COLORS[u], fontFamily: "var(--font-mono)" }}>{unitTotal(entry, u)}d</span>
                                          </div>
                                          <div className="space-y-1">
                                            {projs.map((p, pi) => (
                                              <div key={pi} className="flex items-center justify-between gap-3">
                                                <span className="text-[11px] text-[#52525b] truncate flex items-center gap-1.5">
                                                  {p.name}
                                                  {u === "fraga" && (p.operations ?? []).length > 0 && (
                                                    <span className="text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded bg-[#8b5cf6]/10 text-[#8b5cf6] shrink-0">
                                                      {(p.operations ?? []).map((t) => OPERATION_CHIP_LABELS[t]).join(" + ")}
                                                    </span>
                                                  )}
                                                </span>
                                                <span className="text-[11px] font-semibold tabular-nums shrink-0 px-1.5 py-0.5 rounded" style={{ backgroundColor: UNIT_LIGHT[u], color: UNIT_COLORS[u], fontFamily: "var(--font-mono)" }}>{p.days}d</span>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                              {/* Observations */}
                              {entry.observations && (
                                <div className="flex items-start gap-2">
                                  <MessageSquare size={13} className="text-[#a1a1aa] mt-0.5 shrink-0" />
                                  <div>
                                    <p className="text-[10px] font-medium text-[#71717a] mb-0.5">Observações de {c.name}</p>
                                    <p className="text-xs text-[#71717a] whitespace-pre-wrap">{entry.observations}</p>
                                  </div>
                                </div>
                              )}
                              {/* General projects */}
                              {(entry.generalProjects ?? []).length > 0 && (
                                <div>
                                  <div className="flex items-center gap-2 mb-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-[#a1a1aa]" />
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[#71717a]">Demandas Gerais</p>
                                    <span className="text-[10px] font-semibold tabular-nums text-[#71717a] ml-auto" style={{ fontFamily: "var(--font-mono)" }}>{generalTotal(entry)}d</span>
                                  </div>
                                  <div className="space-y-1">
                                    {(entry.generalProjects ?? []).map((p, pi) => (
                                      <div key={pi} className="flex items-center justify-between gap-3">
                                        <span className="text-[11px] text-[#52525b] truncate">{p.name}</span>
                                        <span className="text-[11px] font-semibold tabular-nums shrink-0 px-1.5 py-0.5 rounded bg-[#f4f4f6] text-[#52525b]" style={{ fontFamily: "var(--font-mono)" }}>{p.days}d</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {/* Atestado */}
                              {(entry.atestados ?? []).length > 0 && (
                                <div>
                                  <div className="flex items-center gap-2 mb-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-600">Atestado</p>
                                    <span className="text-[10px] font-semibold tabular-nums text-amber-600 ml-auto" style={{ fontFamily: "var(--font-mono)" }}>{atestadoTotal(entry)}d</span>
                                  </div>
                                  <div className="space-y-1">
                                    {(entry.atestados ?? []).map((p, pi) => (
                                      <div key={pi} className="flex items-center justify-between gap-3">
                                        <span className="text-[11px] text-[#52525b] truncate">{p.name}</span>
                                        <span className="text-[11px] font-semibold tabular-nums shrink-0 px-1.5 py-0.5 rounded bg-amber-50 text-amber-600" style={{ fontFamily: "var(--font-mono)" }}>{p.days}d</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {!entry.observations && !UNITS.some((u) => (entry.unitProjects?.[u] ?? []).length > 0) && !(entry.generalProjects ?? []).length && !(entry.atestados ?? []).length && (
                                <p className="text-xs text-[#a1a1aa] italic">Nenhuma informação adicional</p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="w-60 shrink-0 border-l border-[rgba(0,0,0,0.06)] bg-white overflow-auto">
        <div className="p-5 space-y-5">
          <h3 className="text-xs font-semibold text-[#71717a] uppercase tracking-wider">Resumo</h3>
          {UNITS.map((u) => {
            const entry = unitTotals.find((x) => x.unit === u)!;
            const pct = totalRateado > 0 ? (entry.valor / totalRateado) * 100 : 0;
            return (
              <div key={u} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: UNIT_COLORS[u] }} />
                  <p className="text-xs font-medium">{UNIT_NAMES[u]}</p>
                </div>
                <div className="pl-4 flex items-center justify-between text-xs">
                  <span className="text-[#a1a1aa]">Valor</span>
                  <span className="font-medium tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(entry.valor)}</span>
                </div>
                <div className="pl-4 w-full h-1 bg-[#f1f1f3] rounded-full"><div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: UNIT_COLORS[u] }} /></div>
              </div>
            );
          })}
          <div className="pt-3 border-t border-[rgba(0,0,0,0.06)] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#71717a] font-medium">Total Folha</span>
              <span className="font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(totalFolha)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#71717a] font-medium">Total Rateado</span>
              <span className="font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(totalRateado)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Collaborator Rateio ──────────────────────────────────────────────────────

interface CollaboratorRateioProps {
  releases: RateioRelease[];
  setReleases: React.Dispatch<React.SetStateAction<RateioRelease[]>>;
  collaborator: Collaborator;
  workingDays: number;
}

function CollaboratorRateio({ releases, setReleases, collaborator, workingDays }: CollaboratorRateioProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const openReleases = releases.filter((r) => r.status === "open");
  const allReleases = [...releases].reverse();
  const selected = releases.find((r) => r.id === selectedId) ?? null;

  const updateEntry = (releaseId: string, entry: RateioEntry) => {
    setReleases((prev) => prev.map((r) =>
      r.id === releaseId ? { ...r, entries: r.entries.map((e) => e.collaboratorId === entry.collaboratorId ? entry : e) } : r
    ));
    apiPut(`/releases/${releaseId}/entries/${entry.collaboratorId}`, entry).catch(() => {
      alert("Não foi possível salvar o rateio. Atualize a página e tente novamente.");
    });
  };

  if (selected) {
    const entry = selected.entries.find((e) => e.collaboratorId === collaborator.id) ?? blankEntry(collaborator.id);
    return <CollaboratorRateioFill
      release={selected}
      entry={entry}
      collaborator={collaborator}
      onSave={(e) => { updateEntry(selected.id, e); setSelectedId(null); }}
      onBack={() => setSelectedId(null)}
    />;
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Meu Rateio</h1>
          <p className="text-xs text-[#71717a] mt-0.5">Olá, {collaborator.name} · {openReleases.length} período(s) aberto(s)</p>
        </div>

        {openReleases.length > 0 && (
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
            <p className="text-xs font-medium text-blue-700 mb-2">Períodos aguardando preenchimento</p>
            <div className="space-y-2">
              {openReleases.map((r) => {
                const entry = r.entries.find((e) => e.collaboratorId === collaborator.id) ?? blankEntry(collaborator.id);
                const total = entryTotal(entry);
                const target = requiredDays(r.workingDays, entry);
                return (
                  <button key={r.id} onClick={() => setSelectedId(r.id)} className="w-full flex items-center justify-between bg-white rounded-lg px-4 py-2.5 text-left hover:shadow-sm transition-all border border-blue-100">
                    <div>
                      <p className="text-sm font-medium">{MONTHS[r.month]} {r.year}</p>
                      <p className="text-[11px] text-[#71717a]">{r.workingDays} dias úteis{r.deadline ? ` · Limite: ${fmtDate(r.deadline)}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge total={total} workingDays={target} />
                      <ChevronRight size={14} className="text-[#a1a1aa]" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium text-[#71717a] uppercase tracking-wider">Histórico</p>
          {allReleases.length === 0 && <p className="text-sm text-[#a1a1aa]">Nenhum período disponível ainda.</p>}
          {allReleases.map((r) => {
            const entry = r.entries.find((e) => e.collaboratorId === collaborator.id) ?? blankEntry(collaborator.id);
            const total = entryTotal(entry);
            const target = requiredDays(r.workingDays, entry);
            return (
              <button key={r.id} onClick={() => setSelectedId(r.id)} className="w-full bg-white border border-[rgba(0,0,0,0.07)] rounded-xl px-5 py-3.5 text-left hover:border-[rgba(0,0,0,0.14)] transition-all flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${r.status === "approved" ? "bg-emerald-50" : "bg-blue-50"}`}>
                  {r.status === "approved" ? <CheckCircle2 size={14} className="text-emerald-500" /> : <Unlock size={14} className="text-blue-500" />}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">{MONTHS[r.month]} {r.year}</p>
                  <p className="text-[11px] text-[#a1a1aa]">{total}/{target} dias · {r.status === "approved" ? "Aprovado" : "Aberto"}</p>
                </div>
                <StatusBadge total={total} workingDays={target} />
                <ChevronRight size={14} className="text-[#a1a1aa]" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Collaborator Rateio Fill ─────────────────────────────────────────────────

interface CollaboratorRateioFillProps {
  release: RateioRelease;
  entry: RateioEntry;
  collaborator: Collaborator;
  onSave: (e: RateioEntry) => void;
  onBack: () => void;
}

function CollaboratorRateioFill({ release, entry: initialEntry, collaborator, onSave, onBack }: CollaboratorRateioFillProps) {
  const [draft, setDraft] = useState<RateioEntry>({
    ...initialEntry,
    unitProjects: initialEntry.unitProjects ?? { wolf: [], fraga: [], woncred: [], profit: [] },
    atestados: initialEntry.atestados ?? [],
  });
  const [savedFlash, setSavedFlash] = useState(false);
  const isLocked = release.status === "approved";

  const total = entryTotal(draft);
  // Dias de atestado reduzem o total exigido para completar o rateio.
  const target = requiredDays(release.workingDays, draft);
  const remaining = target - total;

  const setUnitProjects = (u: Unit, projects: UnitProject[]) => {
    setDraft((d) => ({ ...d, unitProjects: { ...d.unitProjects, [u]: projects } }));
  };

  const save = () => {
    onSave({ ...draft, submitted: true });
    setSavedFlash(true);
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <button onClick={onBack} className="text-xs text-[#71717a] hover:text-[#18181b] mb-2 flex items-center gap-1 transition-colors">← Meu Rateio</button>
            <h1 className="text-xl font-semibold tracking-tight">Rateio — {MONTHS[release.month]} {release.year}</h1>
            <p className="text-xs text-[#71717a] mt-0.5">
              {release.workingDays} dias úteis
              {release.deadline ? ` · Limite: ${fmtDate(release.deadline)}` : ""}
              {isLocked ? " · Aprovado — somente leitura" : ""}
            </p>
          </div>
          {!isLocked && (
            <button onClick={save} className={`h-8 px-4 text-sm font-medium rounded-lg transition-all flex items-center gap-1.5 ${savedFlash ? "bg-emerald-500 text-white" : "bg-[#18181b] text-white hover:bg-[#27272a]"}`}>
              {savedFlash ? <><Check size={13} />Salvo!</> : <><Send size={13} />Salvar Rateio</>}
            </button>
          )}
        </div>

        {/* Totalizador geral */}
        <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5">
          <div className="flex items-end justify-between mb-3">
            <div>
              <p className="text-[10px] font-semibold text-[#71717a] uppercase tracking-wider mb-0.5">Total geral</p>
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)", color: total > target ? "#ef4444" : total === target ? "#10b981" : "#18181b" }}>{total}</span>
                <span className="text-sm text-[#a1a1aa]">/ {target} dias</span>
              </div>
              {atestadoTotal(draft) > 0 && (
                <p className="text-[10px] text-amber-600 mt-0.5">
                  {release.workingDays} dias úteis − {atestadoTotal(draft)} dia(s) de atestado
                </p>
              )}
            </div>
            <div className="flex items-center gap-4">
              {/* Mini totais por unidade */}
              {UNITS.map((u) => {
                const ud = unitTotal(draft, u);
                return ud > 0 ? (
                  <div key={u} className="text-center">
                    <p className="text-[9px] font-medium uppercase tracking-wider mb-0.5" style={{ color: UNIT_COLORS[u] }}>
                      {u === "wolf" ? "Wolf" : u === "fraga" ? "Fraga" : u === "woncred" ? "Won." : "Profit"}
                    </p>
                    <p className="text-base font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)", color: UNIT_COLORS[u] }}>{ud}</p>
                  </div>
                ) : null;
              })}
              {generalTotal(draft) > 0 && (
                <div className="text-center">
                  <p className="text-[9px] font-medium uppercase tracking-wider mb-0.5 text-[#a1a1aa]">Geral</p>
                  <p className="text-base font-semibold tabular-nums text-[#71717a]" style={{ fontFamily: "var(--font-mono)" }}>{generalTotal(draft)}</p>
                </div>
              )}
              {atestadoTotal(draft) > 0 && (
                <div className="text-center">
                  <p className="text-[9px] font-medium uppercase tracking-wider mb-0.5 text-amber-600">Atestado</p>
                  <p className="text-base font-semibold tabular-nums text-amber-600" style={{ fontFamily: "var(--font-mono)" }}>{atestadoTotal(draft)}</p>
                </div>
              )}
              <StatusBadge total={total} workingDays={target} />
            </div>
          </div>
          <ProgressBar total={total} workingDays={target} />
          {remaining !== 0 && (
            <p className="text-xs mt-1.5" style={{ color: remaining > 0 ? "#f59e0b" : "#ef4444" }}>
              {remaining > 0 ? `${remaining} dia(s) ainda não distribuídos` : `${Math.abs(remaining)} dia(s) excedendo o total`}
            </p>
          )}
          {remaining === 0 && total > 0 && (
            <p className="text-xs mt-1.5 text-emerald-600">Todos os dias distribuídos ✓</p>
          )}
        </div>

        {/* Atestado / Afastamentos */}
        {(() => {
          const ad = atestadoTotal(draft);
          const aItems = draft.atestados ?? [];
          return (
            <div
              className="bg-white border rounded-xl p-5 transition-all"
              style={{ borderColor: ad > 0 ? "rgba(217,119,6,0.35)" : "rgba(0,0,0,0.07)" }}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-amber-500" />
                  <p className="text-sm font-semibold">Atestado</p>
                  <span className="text-[10px] text-[#a1a1aa] font-normal">cada dia lançado reduz 1 dia do total a distribuir</span>
                </div>
                <span
                  className="text-sm font-bold tabular-nums px-2 py-0.5 rounded-lg"
                  style={{
                    fontFamily: "var(--font-mono)",
                    backgroundColor: ad > 0 ? "#fffbeb" : "#f7f7f8",
                    color: ad > 0 ? "#d97706" : "#c0c0c8",
                  }}
                >
                  {ad > 0 ? `${ad}d` : "0d"}
                </span>
              </div>
              {aItems.length === 0 && isLocked && (
                <p className="text-xs text-[#c0c0c8] italic">Nenhum atestado lançado</p>
              )}
              <ProjectEntryInput
                projects={aItems}
                color="#d97706"
                lightBg="#fffbeb"
                disabled={isLocked}
                itemLabel="atestado (ex: data e motivo)"
                onChange={(updated) => setDraft((d) => ({ ...d, atestados: updated }))}
              />
            </div>
          );
        })()}

        {/* Centros de custo */}
        <div className="grid grid-cols-2 gap-4">
          {UNITS.map((u) => {
            const projs = draft.unitProjects?.[u] ?? [];
            const ud = unitTotal(draft, u);
            return (
              <div
                key={u}
                className="bg-white border rounded-xl p-5 transition-all"
                style={{ borderColor: ud > 0 ? UNIT_COLORS[u] + "30" : "rgba(0,0,0,0.07)" }}
              >
                {/* Card header: label + total */}
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: UNIT_COLORS[u] }} />
                    <p className="text-sm font-semibold">{UNIT_NAMES[u]}</p>
                    {u === "fraga" && (
                      <span className="text-[9px] text-[#a1a1aa] font-normal">marque a operação de cada atividade</span>
                    )}
                  </div>
                  {/* Totalizador do centro */}
                  <span
                    className="text-sm font-bold tabular-nums px-2 py-0.5 rounded-lg"
                    style={{
                      fontFamily: "var(--font-mono)",
                      backgroundColor: ud > 0 ? UNIT_LIGHT[u] : "#f7f7f8",
                      color: ud > 0 ? UNIT_COLORS[u] : "#c0c0c8",
                    }}
                  >
                    {ud > 0 ? `${ud}d` : "0d"}
                  </span>
                </div>
                {/* Barra de progresso da unidade */}
                <div className="w-full h-0.5 bg-[#f1f1f3] rounded-full mb-4">
                  {ud > 0 && (
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.min((ud / target) * 100, 100)}%`,
                        backgroundColor: UNIT_COLORS[u],
                      }}
                    />
                  )}
                </div>
                {/* Lista de projetos */}
                {projs.length === 0 && isLocked && (
                  <p className="text-xs text-[#c0c0c8] italic">Nenhum projeto lançado</p>
                )}
                <ProjectEntryInput
                  projects={projs}
                  color={UNIT_COLORS[u]}
                  lightBg={UNIT_LIGHT[u]}
                  disabled={isLocked}
                  showOperations={u === "fraga"}
                  onChange={(updated) => setUnitProjects(u, updated)}
                />
              </div>
            );
          })}
        </div>

        {/* Demandas Gerais */}
        {(() => {
          const gd = generalTotal(draft);
          const gProjs = draft.generalProjects ?? [];
          return (
            <div
              className="bg-white border rounded-xl p-5 transition-all"
              style={{ borderColor: gd > 0 ? "rgba(0,0,0,0.12)" : "rgba(0,0,0,0.07)" }}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#a1a1aa]" />
                  <p className="text-sm font-semibold">Demandas Gerais</p>
                  <span className="text-[10px] text-[#a1a1aa] font-normal">todos os centros de custo</span>
                </div>
                <span
                  className="text-sm font-bold tabular-nums px-2 py-0.5 rounded-lg"
                  style={{
                    fontFamily: "var(--font-mono)",
                    backgroundColor: gd > 0 ? "#f4f4f6" : "#f7f7f8",
                    color: gd > 0 ? "#52525b" : "#c0c0c8",
                  }}
                >
                  {gd > 0 ? `${gd}d` : "0d"}
                </span>
              </div>
              <div className="w-full h-0.5 bg-[#f1f1f3] rounded-full mb-4">
                {gd > 0 && (
                  <div
                    className="h-full rounded-full bg-[#a1a1aa] transition-all"
                    style={{ width: `${Math.min((gd / target) * 100, 100)}%` }}
                  />
                )}
              </div>
              {gProjs.length === 0 && isLocked && (
                <p className="text-xs text-[#c0c0c8] italic">Nenhuma demanda geral lançada</p>
              )}
              <ProjectEntryInput
                projects={gProjs}
                color="#71717a"
                lightBg="#f4f4f6"
                disabled={isLocked}
                onChange={(updated) => setDraft((d) => ({ ...d, generalProjects: updated }))}
              />
            </div>
          );
        })()}

        {/* Observations */}
        <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <MessageSquare size={14} className="text-[#a1a1aa]" />
            <p className="text-sm font-semibold">Observações de Atividades</p>
          </div>
          <p className="text-xs text-[#a1a1aa] mb-3">Explique brevemente o que foi feito em cada unidade e os motivos de cada distribuição de dias.</p>
          <textarea
            value={draft.observations}
            disabled={isLocked}
            onChange={(e) => setDraft({ ...draft, observations: e.target.value })}
            placeholder="Ex: Trabalhei 10 dias na Wolf finalizando o módulo de relatórios. 8 dias na Fraga por conta da integração com o ERP..."
            rows={5}
            className="w-full text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg px-4 py-3 outline-none focus:border-[#18181b] focus:bg-white transition-all resize-none text-[#18181b] placeholder:text-[#c0c0c8] disabled:opacity-50"
          />
        </div>

        {!isLocked && (
          <div className="flex justify-end">
            <button onClick={save} className={`h-9 px-6 text-sm font-medium rounded-lg transition-all flex items-center gap-2 ${savedFlash ? "bg-emerald-500 text-white" : "bg-[#18181b] text-white hover:bg-[#27272a]"}`}>
              {savedFlash ? <><Check size={14} />Rateio Salvo!</> : <><Send size={14} />Salvar Rateio</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Project Export View ──────────────────────────────────────────────────────

interface ProjectExportProps {
  project: Project;
  collaborators: Collaborator[];
  workingDays: number;
  onClose: () => void;
}

function ProjectExport({ project, collaborators, workingDays, onClose }: ProjectExportProps) {
  const total = projectCost(project, collaborators, workingDays);
  const members = project.members.filter((m) => m.days > 0).map((m) => {
    const c = collaborators.find((x) => x.id === m.collaboratorId)!;
    const cost = m.days * dailyRate(c.salary, workingDays);
    return { ...m, name: c.name, role: c.role, cost };
  });
  const today = new Date().toLocaleDateString("pt-BR");

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-8">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[rgba(0,0,0,0.07)] print:hidden">
          <p className="text-sm font-medium">Exportar Projeto</p>
          <div className="flex items-center gap-2">
            <button onClick={() => window.print()} className="h-8 px-3 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all flex items-center gap-1.5">
              <Printer size={13} />Imprimir / PDF
            </button>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-[#71717a] hover:text-[#18181b] hover:bg-[#f4f4f6] rounded-lg transition-all"><X size={16} /></button>
          </div>
        </div>

        {/* Export content */}
        <div className="px-10 py-8 space-y-8">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-5 h-5 bg-[#18181b] rounded flex items-center justify-center">
                  <Zap size={10} className="text-white" />
                </div>
                <span className="text-xs font-semibold text-[#71717a] uppercase tracking-wider">Equipe de TI</span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight mt-3">{project.name}</h1>
              {project.description && <p className="text-sm text-[#71717a] mt-1">{project.description}</p>}
            </div>
            <div className="text-right">
              <p className="text-xs text-[#a1a1aa]">Emitido em</p>
              <p className="text-sm font-medium">{today}</p>
              {project.requester && <><p className="text-xs text-[#a1a1aa] mt-2">Solicitante</p><p className="text-sm font-medium">{project.requester}</p></>}
            </div>
          </div>

          {/* Meta */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Período", value: `${MONTHS[project.month]} ${project.year}` },
              { label: "Início", value: project.startDate ? fmtDate(project.startDate) : "—" },
              { label: "Término", value: project.endDate ? fmtDate(project.endDate) : "—" },
            ].map((item) => (
              <div key={item.label} className="bg-[#f7f7f8] rounded-xl p-4">
                <p className="text-[10px] font-medium text-[#a1a1aa] uppercase tracking-wider mb-1">{item.label}</p>
                <p className="text-sm font-semibold">{item.value}</p>
              </div>
            ))}
          </div>

          <div className="border-t border-[rgba(0,0,0,0.06)]" />

          {/* Team */}
          <div>
            <h2 className="text-sm font-semibold mb-4">Equipe do Projeto</h2>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[rgba(0,0,0,0.08)]">
                  <th className="text-left pb-2 text-xs font-medium text-[#71717a]">Colaborador</th>
                  <th className="text-left pb-2 text-xs font-medium text-[#71717a]">Cargo</th>
                  <th className="text-center pb-2 text-xs font-medium text-[#71717a]">Dias</th>
                  <th className="text-right pb-2 text-xs font-medium text-[#71717a]">Custo</th>
                  <th className="text-right pb-2 text-xs font-medium text-[#71717a]">%</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.collaboratorId} className="border-b border-[rgba(0,0,0,0.04)]">
                    <td className="py-2.5 text-sm font-medium">{m.name}</td>
                    <td className="py-2.5 text-xs text-[#71717a]">{m.role}</td>
                    <td className="py-2.5 text-center text-sm tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{m.days}</td>
                    <td className="py-2.5 text-right text-sm font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(m.cost)}</td>
                    <td className="py-2.5 text-right text-xs text-[#a1a1aa] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{total > 0 ? ((m.cost / total) * 100).toFixed(1) : 0}%</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#18181b]">
                  <td colSpan={2} className="pt-3 text-sm font-bold">Total do Projeto</td>
                  <td className="pt-3 text-center text-sm font-bold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{members.reduce((s, m) => s + m.days, 0)}</td>
                  <td className="pt-3 text-right text-sm font-bold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(total)}</td>
                  <td className="pt-3 text-right text-sm font-bold" style={{ fontFamily: "var(--font-mono)" }}>100%</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="border-t border-[rgba(0,0,0,0.06)]" />

          {/* Cost center breakdown */}
          <div>
            <h2 className="text-sm font-semibold mb-4">Distribuição por Centro de Custo</h2>
            <div className="space-y-2">
              {project.costCenters.map((u) => {
                const uCost = projectUnitCost(project, u, collaborators, workingDays);
                const pct = total > 0 ? (uCost / total) * 100 : 0;
                return (
                  <div key={u} className="flex items-center gap-4">
                    <div className="flex items-center gap-2 w-40">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: UNIT_COLORS[u] }} />
                      <span className="text-sm font-medium">{UNIT_NAMES[u]}</span>
                      {project.costCenters.length > 1 && <span className="text-xs text-[#a1a1aa]">{project.splits[u]}%</span>}
                    </div>
                    <div className="flex-1 h-2 bg-[#f1f1f3] rounded-full">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: UNIT_COLORS[u] }} />
                    </div>
                    <span className="text-sm font-semibold tabular-nums w-28 text-right" style={{ fontFamily: "var(--font-mono)", color: UNIT_COLORS[u] }}>{fmt(uCost)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-[rgba(0,0,0,0.06)] pt-4 flex items-center justify-between">
            <p className="text-[10px] text-[#a1a1aa]">Gerado pelo Sistema de Rateio TI · {today}</p>
            <p className="text-[10px] text-[#a1a1aa]">Documento interno — uso confidencial</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Project Detail ───────────────────────────────────────────────────────────

interface ProjectDetailProps {
  project: Project;
  collaborators: Collaborator[];
  workingDays: number;
  onChange: (p: Project) => void;
  onDelete: () => void;
  onBack: () => void;
}

function ProjectDetail({ project, collaborators, workingDays, onChange, onDelete, onBack }: ProjectDetailProps) {
  const [draft, setDraft] = useState<Project>(project);
  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [exporting, setExporting] = useState(false);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(project);
  const update = (p: Project) => setDraft(p);
  const save = () => { onChange(draft); setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1800); };
  const total = projectCost(draft, collaborators, workingDays);

  const toggleUnit = (unit: Unit) => {
    const next = draft.costCenters.includes(unit)
      ? draft.costCenters.length === 1 ? draft.costCenters : draft.costCenters.filter((u) => u !== unit)
      : [...draft.costCenters, unit];
    update({ ...draft, costCenters: next, splits: equalSplit(next) });
  };

  const toggleMember = (cid: string) => {
    const exists = draft.members.find((m) => m.collaboratorId === cid);
    update({ ...draft, members: exists ? draft.members.filter((m) => m.collaboratorId !== cid) : [...draft.members, { collaboratorId: cid, days: 0 }] });
  };

  const setMemberDays = (cid: string, days: number) => {
    update({ ...draft, members: draft.members.map((m) => m.collaboratorId === cid ? { ...m, days: Math.max(0, Math.round(days)) } : m) });
  };

  const splitsSum = draft.costCenters.reduce((s, u) => s + draft.splits[u], 0);

  return (
    <>
      {exporting && <ProjectExport project={draft} collaborators={collaborators} workingDays={workingDays} onClose={() => setExporting(false)} />}
      <div className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto px-8 py-8 space-y-7">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <button onClick={onBack} className="text-xs text-[#71717a] hover:text-[#18181b] mb-3 flex items-center gap-1 transition-colors">← Todos os projetos</button>
              {editingName ? (
                <input autoFocus className="text-xl font-semibold tracking-tight bg-transparent border-b border-[#18181b] outline-none w-full max-w-sm" value={draft.name} onChange={(e) => update({ ...draft, name: e.target.value })} onBlur={() => setEditingName(false)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />
              ) : (
                <h1 className="text-xl font-semibold tracking-tight cursor-text hover:opacity-70 transition-opacity" onClick={() => setEditingName(true)}>{draft.name}</h1>
              )}
              {editingDesc ? (
                <input autoFocus className="text-sm text-[#71717a] bg-transparent border-b border-[#d1d1d6] outline-none w-full max-w-md mt-1" value={draft.description} placeholder="Adicionar descrição..." onChange={(e) => update({ ...draft, description: e.target.value })} onBlur={() => setEditingDesc(false)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />
              ) : (
                <p className="text-sm text-[#71717a] mt-1 cursor-text hover:opacity-70 transition-opacity" onClick={() => setEditingDesc(true)}>
                  {draft.description || <span className="text-[#c0c0c8] italic">Clique para adicionar descrição...</span>}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative">
                <select value={draft.month} onChange={(e) => update({ ...draft, month: Number(e.target.value) })} className="appearance-none h-8 pl-3 pr-8 text-sm bg-white border border-[rgba(0,0,0,0.07)] rounded-lg outline-none hover:border-[rgba(0,0,0,0.14)] transition-all cursor-pointer">
                  {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                </select>
                <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#a1a1aa] pointer-events-none" />
              </div>
              <span className="text-sm text-[#71717a]">{draft.year}</span>
              <button onClick={() => setExporting(true)} className="h-8 px-3 text-sm text-[#71717a] hover:text-[#18181b] bg-white border border-[rgba(0,0,0,0.07)] rounded-lg hover:border-[rgba(0,0,0,0.14)] transition-all flex items-center gap-1.5">
                <ExternalLink size={13} />Exportar
              </button>
              <button onClick={save} className={`h-8 px-4 text-sm font-medium rounded-lg transition-all flex items-center gap-1.5 ${savedFlash ? "bg-emerald-500 text-white" : isDirty ? "bg-[#18181b] text-white hover:bg-[#27272a]" : "bg-[#f1f1f3] text-[#71717a]"}`}>
                {savedFlash ? <><Check size={13} />Salvo</> : <><Check size={13} />Salvar</>}
              </button>
              <button onClick={onDelete} className="h-8 px-3 text-sm text-red-500 hover:text-red-600 hover:bg-red-50 border border-[rgba(0,0,0,0.07)] rounded-lg transition-all flex items-center gap-1.5">
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {/* Requester + Dates */}
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4">Informações do Projeto</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-[#71717a] mb-1.5">Solicitante</label>
                <input value={draft.requester} onChange={(e) => update({ ...draft, requester: e.target.value })} placeholder="Nome do solicitante" className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#71717a] mb-1.5">Data de Início</label>
                <input type="date" value={draft.startDate} onChange={(e) => update({ ...draft, startDate: e.target.value })} className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#71717a] mb-1.5">Data de Término</label>
                <input type="date" value={draft.endDate} onChange={(e) => update({ ...draft, endDate: e.target.value })} className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" />
              </div>
            </div>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5">
              <p className="text-xs text-[#71717a] font-medium mb-1.5">Custo Total</p>
              <p className="text-xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(total)}</p>
              <p className="text-xs text-[#a1a1aa] mt-1">{draft.members.filter((m) => m.days > 0).length} colaboradores</p>
            </div>
            <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5">
              <p className="text-xs text-[#71717a] font-medium mb-1.5">Dias Trabalhados</p>
              <p className="text-xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{draft.members.filter((m) => m.days > 0).reduce((s, m) => s + m.days, 0)}</p>
              <p className="text-xs text-[#a1a1aa] mt-1">dias no total</p>
            </div>
            <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5">
              <p className="text-xs text-[#71717a] font-medium mb-1.5">Centros de Custo</p>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                {draft.costCenters.map((u) => (
                  <span key={u} className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ backgroundColor: UNIT_LIGHT[u], color: UNIT_COLORS[u] }}>{UNIT_NAMES[u]}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            {/* Cost centers */}
            <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold">Centros de Custo</h3>
              <p className="text-xs text-[#a1a1aa] -mt-2">Selecione a qual unidade este projeto pertence.</p>
              <div className="space-y-2">
                {UNITS.map((u) => {
                  const active = draft.costCenters.includes(u);
                  return (
                    <div key={u} className="space-y-2">
                      <button onClick={() => toggleUnit(u)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all text-left ${active ? "border-transparent" : "border-[rgba(0,0,0,0.07)] hover:border-[rgba(0,0,0,0.14)]"}`} style={active ? { backgroundColor: UNIT_LIGHT[u], borderColor: UNIT_COLORS[u] + "33" } : {}}>
                        <div className="w-4 h-4 rounded flex items-center justify-center border-2 transition-all shrink-0" style={active ? { backgroundColor: UNIT_COLORS[u], borderColor: UNIT_COLORS[u] } : { borderColor: "#d1d1d6" }}>
                          {active && <Check size={10} className="text-white" strokeWidth={3} />}
                        </div>
                        <div className="flex items-center gap-2 flex-1">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: UNIT_COLORS[u] }} />
                          <span className="text-sm font-medium">{UNIT_NAMES[u]}</span>
                        </div>
                        {active && total > 0 && <span className="text-xs tabular-nums" style={{ color: UNIT_COLORS[u], fontFamily: "var(--font-mono)" }}>{fmt(projectUnitCost(draft, u, collaborators, workingDays))}</span>}
                      </button>
                      {active && draft.costCenters.length > 1 && (
                        <div className="pl-10 flex items-center gap-2">
                          <input type="number" min={0} max={100} value={draft.splits[u]} onChange={(e) => update({ ...draft, splits: { ...draft.splits, [u]: Math.max(0, Math.min(100, Number(e.target.value))) } })} className="w-14 h-7 text-center text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" style={{ fontFamily: "var(--font-mono)" }} />
                          <span className="text-xs text-[#a1a1aa]">%</span>
                          {splitsSum !== 100 && <span className="text-[10px] text-amber-500">soma: {splitsSum}%</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {draft.costCenters.length > 1 && (
                <button onClick={() => update({ ...draft, splits: equalSplit(draft.costCenters) })} className="text-xs text-[#71717a] hover:text-[#18181b] transition-colors">Distribuir igualmente</button>
              )}
            </div>

            {/* Unit cost breakdown */}
            <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold">Custo por Unidade</h3>
              <div className="space-y-3">
                {draft.costCenters.map((u) => {
                  const uCost = projectUnitCost(draft, u, collaborators, workingDays);
                  const pct = total > 0 ? (uCost / total) * 100 : 0;
                  return (
                    <div key={u}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: UNIT_COLORS[u] }} />
                          <span className="text-xs font-medium">{UNIT_NAMES[u]}</span>
                          {draft.costCenters.length > 1 && <span className="text-[10px] text-[#a1a1aa]">{draft.splits[u]}%</span>}
                        </div>
                        <span className="text-sm font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)", color: UNIT_COLORS[u] }}>{fmt(uCost)}</span>
                      </div>
                      <div className="w-full h-1 bg-[#f1f1f3] rounded-full"><div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: UNIT_COLORS[u] }} /></div>
                    </div>
                  );
                })}
              </div>
              {total === 0 && <p className="text-xs text-[#c0c0c8] italic pt-2">Adicione colaboradores com dias trabalhados para ver o custo.</p>}
            </div>
          </div>

          {/* Collaborators */}
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[rgba(0,0,0,0.05)] flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Equipe do Projeto</h3>
                <p className="text-xs text-[#a1a1aa] mt-0.5">Selecione os colaboradores e informe os dias trabalhados</p>
              </div>
              <span className="text-xs text-[#a1a1aa]">{draft.members.filter((m) => m.days > 0).length} ativos</span>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[rgba(0,0,0,0.04)]">
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-[#71717a] w-8" />
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-[#71717a]">Colaborador</th>
                  <th className="text-right px-5 py-2.5 text-xs font-medium text-[#71717a]">Valor/Dia</th>
                  <th className="text-center px-5 py-2.5 text-xs font-medium text-[#71717a]">Dias</th>
                  <th className="text-right px-5 py-2.5 text-xs font-medium text-[#71717a]">Custo</th>
                  <th className="text-right px-5 py-2.5 text-xs font-medium text-[#71717a]">%</th>
                </tr>
              </thead>
              <tbody>
                {collaborators.map((c) => {
                  const member = draft.members.find((m) => m.collaboratorId === c.id);
                  const selected = !!member;
                  const rate = dailyRate(c.salary, workingDays);
                  const cost = selected ? member.days * rate : 0;
                  return (
                    <tr key={c.id} className={`border-b border-[rgba(0,0,0,0.04)] last:border-0 transition-colors ${selected ? "" : "opacity-40"}`}>
                      <td className="px-5 py-3">
                        <button onClick={() => toggleMember(c.id)} className="w-4 h-4 rounded border-2 flex items-center justify-center transition-all" style={selected ? { backgroundColor: "#18181b", borderColor: "#18181b" } : { borderColor: "#d1d1d6" }}>
                          {selected && <Check size={9} className="text-white" strokeWidth={3} />}
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={c.name} />
                          <div><p className="text-sm font-medium leading-tight">{c.name}</p><p className="text-[11px] text-[#a1a1aa] leading-tight">{c.role}</p></div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right text-xs tabular-nums text-[#a1a1aa]" style={{ fontFamily: "var(--font-mono)" }}>{fmt(rate)}</td>
                      <td className="px-5 py-3 text-center">
                        {selected ? (
                          <input type="number" min={0} step={1} value={member.days} onChange={(e) => setMemberDays(c.id, Number(e.target.value))} onBlur={(e) => setMemberDays(c.id, Math.round(Number(e.target.value)))} className="w-14 h-7 text-center text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" style={{ fontFamily: "var(--font-mono)" }} />
                        ) : <span className="text-xs text-[#d1d1d6]">—</span>}
                      </td>
                      <td className="px-5 py-3 text-right text-sm tabular-nums font-medium" style={{ fontFamily: "var(--font-mono)" }}>{selected && cost > 0 ? fmt(cost) : <span className="text-[#d1d1d6] text-xs">—</span>}</td>
                      <td className="px-5 py-3 text-right text-xs tabular-nums text-[#a1a1aa]" style={{ fontFamily: "var(--font-mono)" }}>{selected && total > 0 ? `${((cost / total) * 100).toFixed(1)}%` : <span className="text-[#d1d1d6]">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
              {total > 0 && (
                <tfoot>
                  <tr className="bg-[#f7f7f8] border-t border-[rgba(0,0,0,0.06)]">
                    <td colSpan={3} className="px-5 py-2.5 text-xs font-semibold text-[#71717a]">Total</td>
                    <td className="px-5 py-2.5 text-center text-xs font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{draft.members.filter((m) => m.days > 0).reduce((s, m) => s + m.days, 0)}</td>
                    <td className="px-5 py-2.5 text-right text-sm font-bold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(total)}</td>
                    <td className="px-5 py-2.5 text-right text-xs font-semibold" style={{ fontFamily: "var(--font-mono)" }}>100%</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Projects View ────────────────────────────────────────────────────────────

interface ProjectsViewProps {
  projects: Project[];
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  collaborators: Collaborator[];
  workingDays: number;
  defaultMonth: number;
  defaultYear: number;
}

function ProjectsView({ projects, setProjects, collaborators, workingDays, defaultMonth, defaultYear }: ProjectsViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterMonth, setFilterMonth] = useState<number | "all">(defaultMonth);
  const filterYear = defaultYear;
  const selected = projects.find((p) => p.id === selectedId) ?? null;

  const newProject = () => {
    const month = filterMonth === "all" ? defaultMonth : filterMonth;
    const p: Project = { id: String(Date.now()), name: "Novo Projeto", description: "", requester: "", month, year: filterYear, startDate: "", endDate: "", costCenters: ["wolf"], splits: { wolf: 100, fraga: 0, woncred: 0, profit: 0 }, members: [] };
    setProjects((prev) => [...prev, p]);
    setSelectedId(p.id);
    apiPost("/projects", p).catch(() => {
      alert("Não foi possível criar o projeto. Atualize a página e tente novamente.");
    });
  };

  const updateProject = (p: Project) => {
    setProjects((prev) => prev.map((x) => (x.id === p.id ? p : x)));
    apiPut(`/projects/${p.id}`, p).catch(() => {
      alert("Não foi possível salvar o projeto. Atualize a página e tente novamente.");
    });
  };
  const deleteProject = (id: string) => {
    setProjects((prev) => prev.filter((x) => x.id !== id));
    setSelectedId(null);
    apiDelete(`/projects/${id}`).catch(() => {
      alert("Não foi possível remover o projeto. Atualize a página e tente novamente.");
    });
  };

  if (selected) {
    return <ProjectDetail project={selected} collaborators={collaborators} workingDays={workingDays} onChange={updateProject} onDelete={() => deleteProject(selected.id)} onBack={() => setSelectedId(null)} />;
  }

  const filtered = filterMonth === "all" ? projects.filter((p) => p.year === filterYear) : projects.filter((p) => p.month === filterMonth && p.year === filterYear);
  const totalCost = filtered.reduce((s, p) => s + projectCost(p, collaborators, workingDays), 0);

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Projetos</h1>
            <p className="text-xs text-[#71717a] mt-0.5">Calculadora de custos de projeto · {filterYear}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <select value={filterMonth === "all" ? "all" : filterMonth} onChange={(e) => setFilterMonth(e.target.value === "all" ? "all" : Number(e.target.value))} className="appearance-none h-8 pl-3 pr-8 text-sm bg-white border border-[rgba(0,0,0,0.07)] rounded-lg outline-none hover:border-[rgba(0,0,0,0.14)] transition-all cursor-pointer">
                <option value="all">Todos os meses</option>
                {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
              </select>
              <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#a1a1aa] pointer-events-none" />
            </div>
            <button onClick={newProject} className="h-8 px-4 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all flex items-center gap-1.5"><Plus size={14} />Novo Projeto</button>
          </div>
        </div>

        {filtered.length > 0 && (
          <div className="flex items-center gap-6 text-xs">
            <span className="text-[#71717a]"><span className="font-medium text-[#18181b]">{filtered.length}</span> projetos</span>
            <span className="text-[#71717a]">Custo total: <span className="font-medium text-[#18181b]" style={{ fontFamily: "var(--font-mono)" }}>{fmt(totalCost)}</span></span>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-16 flex flex-col items-center justify-center text-center">
            <div className="w-10 h-10 bg-[#f1f1f3] rounded-xl flex items-center justify-center mb-3"><FileSpreadsheet size={18} className="text-[#a1a1aa]" /></div>
            <p className="text-sm font-medium">{projects.length === 0 ? "Nenhum projeto ainda" : "Nenhum projeto neste período"}</p>
            <p className="text-xs text-[#a1a1aa] mt-1 mb-4">Crie um projeto para estimar custos por colaborador e centro de custo</p>
            <button onClick={newProject} className="h-8 px-4 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all">Criar projeto</button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {filtered.map((p) => {
              const cost = projectCost(p, collaborators, workingDays);
              const memberCount = p.members.filter((m) => m.days > 0).length;
              const totalDays = p.members.reduce((s, m) => s + m.days, 0);
              return (
                <button key={p.id} onClick={() => setSelectedId(p.id)} className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5 text-left hover:border-[rgba(0,0,0,0.14)] hover:shadow-sm transition-all">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold truncate">{p.name}</p>
                        <span className="text-[10px] text-[#a1a1aa] shrink-0">{MONTHS[p.month]}</span>
                      </div>
                      {p.description && <p className="text-xs text-[#a1a1aa] mt-0.5 truncate">{p.description}</p>}
                      {p.requester && <p className="text-[10px] text-[#a1a1aa] mt-0.5">Solicitante: {p.requester}</p>}
                    </div>
                    <div className="flex items-center gap-1 ml-2 shrink-0">
                      {p.costCenters.map((u) => <div key={u} className="w-2 h-2 rounded-full" style={{ backgroundColor: UNIT_COLORS[u] }} />)}
                    </div>
                  </div>
                  {(p.startDate || p.endDate) && (
                    <div className="flex items-center gap-1 text-[10px] text-[#a1a1aa] mb-2">
                      <CalendarDays size={10} />
                      <span>{p.startDate ? fmtDate(p.startDate) : "?"} → {p.endDate ? fmtDate(p.endDate) : "?"}</span>
                    </div>
                  )}
                  <div className="flex items-end justify-between">
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-[#a1a1aa]">{memberCount} colaboradores · {totalDays} dias</p>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {p.costCenters.map((u) => <span key={u} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ backgroundColor: UNIT_LIGHT[u], color: UNIT_COLORS[u] }}>{UNIT_NAMES[u]}{p.costCenters.length > 1 ? ` ${p.splits[u]}%` : ""}</span>)}
                      </div>
                    </div>
                    <p className="text-base font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                      {cost > 0 ? fmt(cost) : <span className="text-[#d1d1d6] text-sm">—</span>}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Colaboradores View ───────────────────────────────────────────────────────

interface ColaboradoresViewProps {
  collaborators: Collaborator[];
  setCollaborators: React.Dispatch<React.SetStateAction<Collaborator[]>>;
  workingDays: number;
}

function ColaboradoresView({ collaborators, setCollaborators, workingDays }: ColaboradoresViewProps) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const totalFolha = collaborators.reduce((s, c) => s + c.salary, 0);

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Colaboradores</h1>
            <p className="text-xs text-[#71717a] mt-0.5">{collaborators.length} pessoas · Folha total {fmt(totalFolha)}</p>
          </div>
          <button onClick={() => setAdding(true)} className="h-8 px-4 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all flex items-center gap-1.5"><Plus size={14} />Novo Colaborador</button>
        </div>
        {adding && <CollaboratorForm workingDays={workingDays} onSave={(d) => {
          const tempId = String(Date.now());
          setCollaborators((p) => [...p, { ...d, id: tempId }]);
          setAdding(false);
          apiPost("/collaborators", { ...d, id: tempId }).catch(() => {
            setCollaborators((p) => p.filter((x) => x.id !== tempId));
            alert("Não foi possível salvar o colaborador. Tente novamente.");
          });
        }} onCancel={() => setAdding(false)} />}
        <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[rgba(0,0,0,0.06)]">
                <th className="text-left px-5 py-3 text-xs font-medium text-[#71717a]">Nome</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#71717a]">Cargo</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-[#71717a]">Salário</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-[#71717a]">Valor/Dia</th>
                <th className="px-5 py-3 w-20" />
              </tr>
            </thead>
            <tbody>
              {collaborators.map((c) => (
                <>
                  <tr key={c.id} className="border-b border-[rgba(0,0,0,0.04)] last:border-0 group">
                    <td className="px-5 py-3"><div className="flex items-center gap-2.5"><Avatar name={c.name} /><span className="text-sm font-medium">{c.name}</span></div></td>
                    <td className="px-5 py-3 text-sm text-[#71717a]">{c.role}</td>
                    <td className="px-5 py-3 text-right text-sm tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(c.salary)}</td>
                    <td className="px-5 py-3 text-right text-xs tabular-nums text-[#a1a1aa]" style={{ fontFamily: "var(--font-mono)" }}>{fmt(dailyRate(c.salary, workingDays))}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                        <button onClick={() => setEditId(c.id)} className="w-6 h-6 rounded-md flex items-center justify-center text-[#a1a1aa] hover:text-[#18181b] hover:bg-[#f4f4f6] transition-all"><Pencil size={12} /></button>
                        <button onClick={() => {
                          if (!confirm(`Remover ${c.name}? Isso também apaga o acesso de login vinculado, se existir.`)) return;
                          setCollaborators((p) => p.filter((x) => x.id !== c.id));
                          apiDelete(`/collaborators/${c.id}`).catch(() => { alert("Não foi possível remover. Atualize a página."); });
                        }} className="w-6 h-6 rounded-md flex items-center justify-center text-[#a1a1aa] hover:text-red-500 hover:bg-red-50 transition-all"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                  {editId === c.id && (
                    <tr key={`edit-${c.id}`}>
                      <td colSpan={5} className="px-5 pb-3">
                        <CollaboratorForm initial={c} workingDays={workingDays} onSave={(d) => {
                          setCollaborators((p) => p.map((x) => x.id === c.id ? { ...x, ...d } : x));
                          setEditId(null);
                          apiPut(`/collaborators/${c.id}`, d).catch(() => { alert("Não foi possível salvar as alterações. Atualize a página."); });
                        }} onCancel={() => setEditId(null)} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard View ───────────────────────────────────────────────────────────

interface DashboardViewProps {
  collaborators: Collaborator[];
  releases: RateioRelease[];
  projects: Project[];
  workingDays: number;
  role: UserRole;
  currentCollaboratorId: string;
  onNav: (v: View) => void;
}

function DashboardView({ collaborators, releases, projects, workingDays, role, currentCollaboratorId, onNav }: DashboardViewProps) {
  const now = new Date();
  const openReleases = releases.filter((r) => r.status === "open");
  const approvedReleases = releases.filter((r) => r.status === "approved");
  const totalFolha = collaborators.reduce((s, c) => s + c.salary, 0);

  if (role === "collaborator") {
    const c = collaborators.find((x) => x.id === currentCollaboratorId);
    if (!c) return null;
    return (
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
          <div className="flex items-center gap-3">
            <Avatar name={c.name} size={10} />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Olá, {c.name.split(" ")[0]}</h1>
              <p className="text-xs text-[#71717a]">{c.role}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5">
              <p className="text-xs text-[#71717a] font-medium mb-1.5">Períodos Abertos</p>
              <p className="text-2xl font-semibold" style={{ fontFamily: "var(--font-mono)" }}>{openReleases.length}</p>
              <p className="text-xs text-[#a1a1aa] mt-1">aguardando preenchimento</p>
            </div>
            <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5">
              <p className="text-xs text-[#71717a] font-medium mb-1.5">Períodos Aprovados</p>
              <p className="text-2xl font-semibold" style={{ fontFamily: "var(--font-mono)" }}>{approvedReleases.length}</p>
              <p className="text-xs text-[#a1a1aa] mt-1">este ano</p>
            </div>
          </div>
          {openReleases.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-[#71717a] uppercase tracking-wider mb-3">Pendente</p>
              <button onClick={() => onNav("rateio")} className="w-full bg-blue-50 border border-blue-100 rounded-xl px-5 py-4 text-left hover:bg-blue-100/60 transition-all flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-blue-800">{openReleases.map((r) => `${MONTHS[r.month]} ${r.year}`).join(", ")}</p>
                  <p className="text-xs text-blue-600 mt-0.5">Clique para preencher seu rateio</p>
                </div>
                <ChevronRight size={16} className="text-blue-400" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const pieData = UNITS.map((u) => ({
    name: UNIT_NAMES[u],
    value: releases.flatMap((r) => r.entries).reduce((s, e) => {
      const c = collaborators.find((x) => x.id === e.collaboratorId);
      return s + (c ? unitTotal(e, u) * dailyRate(c.salary, workingDays) : 0);
    }, 0),
    color: UNIT_COLORS[u],
  })).filter((d) => d.value > 0);

  const totalRateado = pieData.reduce((s, d) => s + d.value, 0);

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-8 py-8 space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-xs text-[#71717a] mt-1">{now.toLocaleDateString("pt-BR", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
        </div>
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Total da Folha", value: fmt(totalFolha), sub: `${collaborators.length} colaboradores` },
            { label: "Períodos Abertos", value: String(openReleases.length), sub: "aguardando preenchimento" },
            { label: "Períodos Aprovados", value: String(approvedReleases.length), sub: "este ano" },
            { label: "Projetos", value: String(projects.length), sub: "cadastrados" },
          ].map((card) => (
            <div key={card.label} className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5">
              <p className="text-xs text-[#71717a] font-medium mb-2">{card.label}</p>
              <p className="text-xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{card.value}</p>
              <p className="text-xs text-[#a1a1aa] mt-1">{card.sub}</p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-6">
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-6">
            <h3 className="text-sm font-semibold mb-4">Distribuição Acumulada por Unidade</h3>
            {totalRateado > 0 ? (
              <div className="flex items-center gap-6">
                <div style={{ width: 160, height: 160 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius={48} outerRadius={72} dataKey="value" strokeWidth={2} stroke="#f7f7f8">
                        {pieData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                      </Pie>
                      <Tooltip formatter={(v: number) => [fmt(v), ""]} contentStyle={{ border: "1px solid rgba(0,0,0,0.07)", borderRadius: 8, fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2 flex-1">
                  {pieData.map((d) => (
                    <div key={d.name}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} /><span className="text-xs text-[#71717a]">{d.name}</span></div>
                        <span className="text-xs font-medium tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(d.value)}</span>
                      </div>
                      <div className="w-full h-1 bg-[#f1f1f3] rounded-full"><div className="h-full rounded-full" style={{ width: `${(d.value / totalRateado) * 100}%`, backgroundColor: d.color }} /></div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-40 text-sm text-[#a1a1aa]">Nenhum rateio lançado ainda</div>
            )}
          </div>
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-6">
            <h3 className="text-sm font-semibold mb-4">Períodos Recentes</h3>
            <div className="space-y-2">
              {[...releases].reverse().slice(0, 5).map((r) => {
                const done = r.entries.filter((e) => entryTotal(e) === requiredDays(r.workingDays, e)).length;
                return (
                  <div key={r.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full ${r.status === "approved" ? "bg-emerald-500" : "bg-blue-400"}`} />
                      <span className="text-sm">{MONTHS[r.month]} {r.year}</span>
                    </div>
                    <span className="text-xs text-[#a1a1aa]">{done}/{r.entries.length} completos</span>
                  </div>
                );
              })}
              {releases.length === 0 && <p className="text-sm text-[#a1a1aa]">Nenhum período liberado ainda</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Settings View ────────────────────────────────────────────────────────────

function SettingsView({ workingDays, setWorkingDays }: { workingDays: number; setWorkingDays: (n: number) => void }) {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-xl mx-auto px-8 py-8 space-y-6">
        <div><h1 className="text-xl font-semibold tracking-tight">Configurações</h1><p className="text-xs text-[#71717a] mt-0.5">Parâmetros globais do sistema</p></div>
        <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl divide-y divide-[rgba(0,0,0,0.05)]">
          <div className="px-5 py-4 flex items-center justify-between">
            <div><p className="text-sm font-medium">Dias Úteis Padrão</p><p className="text-xs text-[#a1a1aa] mt-0.5">Referência para cálculo do valor diário dos colaboradores</p></div>
            <input type="number" value={workingDays} onChange={(e) => setWorkingDays(Math.max(1, Number(e.target.value)))} className="w-16 h-8 text-center text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" style={{ fontFamily: "var(--font-mono)" }} min={1} max={31} />
          </div>
          <div className="px-5 py-4 flex items-center justify-between">
            <div><p className="text-sm font-medium">Centros de Custo</p><p className="text-xs text-[#a1a1aa] mt-0.5">Wolf Consórcios · Fraga & Bitello · Woncred · Profit</p></div>
            <div className="flex items-center gap-1.5">
              {UNITS.map((u) => <div key={u} className="w-2 h-2 rounded-full" style={{ backgroundColor: UNIT_COLORS[u] }} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Auth types & screens ─────────────────────────────────────────────────────

interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  collaboratorId: string | null;
  collaboratorName: string | null;
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f7f7f8]" style={{ fontFamily: "var(--font-family)" }}>
      <div className="w-full max-w-sm bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-[#18181b] rounded-md flex items-center justify-center"><Zap size={14} className="text-white" /></div>
          <span className="text-sm font-semibold tracking-tight">Rateio TI</span>
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="text-xs text-[#71717a] mt-0.5">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function Setup({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = () => {
    setError("");
    if (!username.trim()) { setError("Informe um nome de usuário"); return; }
    if (password.length < 6) { setError("A senha deve ter ao menos 6 caracteres"); return; }
    if (password !== confirm) { setError("As senhas não coincidem"); return; }
    setLoading(true);
    apiPost("/auth/setup", { username: username.trim(), password })
      .then(() => onDone())
      .catch((e: Error) => { setError(e.message || "Não foi possível concluir a configuração"); setLoading(false); });
  };

  return (
    <AuthShell title="Configuração inicial" subtitle="Crie a conta do primeiro administrador para começar a usar o sistema. Nenhum funcionário vem pré-cadastrado.">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-[#71717a] mb-1.5">Usuário</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" autoFocus />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#71717a] mb-1.5">Senha</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#71717a] mb-1.5">Confirmar senha</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" />
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button onClick={submit} disabled={loading} className="w-full h-9 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] disabled:opacity-50 transition-all">{loading ? "Criando…" : "Criar administrador"}</button>
      </div>
    </AuthShell>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = () => {
    setError("");
    if (!username.trim() || !password) { setError("Informe usuário e senha"); return; }
    setLoading(true);
    apiPost("/auth/login", { username: username.trim(), password })
      .then(() => onDone())
      .catch((e: Error) => { setError(e.message || "Usuário ou senha inválidos"); setLoading(false); });
  };

  return (
    <AuthShell title="Entrar" subtitle="Acesse o sistema de rateio de horas">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-[#71717a] mb-1.5">Usuário</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" autoFocus />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#71717a] mb-1.5">Senha</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none focus:border-[#18181b] focus:bg-white transition-all" />
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button onClick={submit} disabled={loading} className="w-full h-9 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] disabled:opacity-50 transition-all">{loading ? "Entrando…" : "Entrar"}</button>
      </div>
    </AuthShell>
  );
}

// ─── Acessos View (gestão de logins) ──────────────────────────────────────────

interface AcessosViewProps {
  collaborators: Collaborator[];
  currentUserId: number;
}

interface AccessRow {
  id: number;
  username: string;
  role: UserRole;
  collaboratorId: string | null;
  collaboratorName: string | null;
}

function AcessosView({ collaborators, currentUserId }: AcessosViewProps) {
  const [users, setUsers] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState<UserRole>("collaborator");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newCollaboratorId, setNewCollaboratorId] = useState("");
  const [error, setError] = useState("");
  const [resetId, setResetId] = useState<number | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const load = () => {
    setLoading(true);
    apiGet("/users").then((u) => { setUsers(u); setLoading(false); }).catch(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const withoutLogin = collaborators.filter((c) => !users.some((u) => u.collaboratorId === c.id));

  const createAccess = () => {
    setError("");
    if (!newUsername.trim() || newPassword.length < 6) { setError("Informe usuário e senha (mín. 6 caracteres)"); return; }
    if (newType === "collaborator" && !newCollaboratorId) { setError("Selecione o colaborador"); return; }
    apiPost("/users", {
      username: newUsername.trim(),
      password: newPassword,
      role: newType,
      collaboratorId: newType === "collaborator" ? newCollaboratorId : undefined,
    })
      .then(() => { setCreating(false); setNewUsername(""); setNewPassword(""); setNewCollaboratorId(""); load(); })
      .catch((e: Error) => setError(e.message || "Não foi possível criar o acesso"));
  };

  const removeAccess = (id: number) => {
    if (!confirm("Remover este acesso?")) return;
    apiDelete(`/users/${id}`).then(load).catch((e: Error) => alert(e.message || "Não foi possível remover"));
  };

  const saveReset = (id: number) => {
    if (resetPassword.length < 6) { alert("Senha deve ter ao menos 6 caracteres"); return; }
    apiPut(`/users/${id}`, { password: resetPassword })
      .then(() => { setResetId(null); setResetPassword(""); })
      .catch((e: Error) => alert(e.message || "Não foi possível redefinir a senha"));
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Acessos</h1>
            <p className="text-xs text-[#71717a] mt-0.5">Contas de login para administradores e colaboradores</p>
          </div>
          <button onClick={() => setCreating(true)} className="h-8 px-4 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all flex items-center gap-1.5"><Plus size={14} />Novo Acesso</button>
        </div>

        {creating && (
          <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold">Novo Acesso</h3>
            <div className="flex rounded-lg bg-[#f4f4f6] p-0.5 w-fit">
              <button onClick={() => setNewType("collaborator")} className={`px-3 h-7 rounded-md text-xs font-medium transition-all ${newType === "collaborator" ? "bg-white shadow-sm text-[#18181b]" : "text-[#a1a1aa]"}`}>Colaborador</button>
              <button onClick={() => setNewType("admin")} className={`px-3 h-7 rounded-md text-xs font-medium transition-all ${newType === "admin" ? "bg-white shadow-sm text-[#18181b]" : "text-[#a1a1aa]"}`}>Administrador</button>
            </div>
            {newType === "collaborator" && (
              <div>
                <label className="block text-xs font-medium text-[#71717a] mb-1.5">Colaborador</label>
                <select value={newCollaboratorId} onChange={(e) => setNewCollaboratorId(e.target.value)} className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none">
                  <option value="">Selecione…</option>
                  {withoutLogin.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {withoutLogin.length === 0 && <p className="text-[11px] text-[#a1a1aa] mt-1">Todos os colaboradores já possuem acesso, ou nenhum colaborador foi cadastrado ainda.</p>}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[#71717a] mb-1.5">Usuário</label>
                <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none" placeholder="ex: joao.silva" />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#71717a] mb-1.5">Senha</label>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full h-8 px-3 text-sm bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg outline-none" placeholder="mínimo 6 caracteres" />
              </div>
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => { setCreating(false); setError(""); }} className="h-8 px-4 text-sm text-[#71717a] hover:text-[#18181b] rounded-lg hover:bg-[#f4f4f6] transition-all">Cancelar</button>
              <button onClick={createAccess} className="h-8 px-4 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all">Criar acesso</button>
            </div>
          </div>
        )}

        <div className="bg-white border border-[rgba(0,0,0,0.07)] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[rgba(0,0,0,0.06)]">
                <th className="text-left px-5 py-3 text-xs font-medium text-[#71717a]">Usuário</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#71717a]">Tipo</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-[#71717a]">Colaborador vinculado</th>
                <th className="px-5 py-3 w-40" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <>
                  <tr key={u.id} className="border-b border-[rgba(0,0,0,0.04)] last:border-0">
                    <td className="px-5 py-3 text-sm font-medium">{u.username}</td>
                    <td className="px-5 py-3 text-sm text-[#71717a]">{u.role === "admin" ? "Administrador" : "Colaborador"}</td>
                    <td className="px-5 py-3 text-sm text-[#71717a]">{u.collaboratorName || "—"}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={() => { setResetId(u.id); setResetPassword(""); }} className="h-6 px-2 text-[11px] rounded-md text-[#71717a] hover:text-[#18181b] hover:bg-[#f4f4f6] transition-all">Redefinir senha</button>
                        {u.id !== currentUserId && (
                          <button onClick={() => removeAccess(u.id)} className="w-6 h-6 rounded-md flex items-center justify-center text-[#a1a1aa] hover:text-red-500 hover:bg-red-50 transition-all"><Trash2 size={12} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {resetId === u.id && (
                    <tr key={`reset-${u.id}`}>
                      <td colSpan={4} className="px-5 pb-3">
                        <div className="flex items-center gap-2 bg-[#f7f7f8] border border-[rgba(0,0,0,0.07)] rounded-lg p-3">
                          <input type="password" autoFocus value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="Nova senha (mín. 6 caracteres)" className="flex-1 h-8 px-3 text-sm bg-white border border-[rgba(0,0,0,0.07)] rounded-lg outline-none" />
                          <button onClick={() => saveReset(u.id)} className="h-8 px-3 text-sm font-medium bg-[#18181b] text-white rounded-lg hover:bg-[#27272a] transition-all">Salvar</button>
                          <button onClick={() => setResetId(null)} className="h-8 px-3 text-sm text-[#71717a] hover:text-[#18181b] rounded-lg transition-all">Cancelar</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {!loading && users.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-[#a1a1aa]">Nenhum acesso cadastrado</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Main App (autenticado) ───────────────────────────────────────────────────

function MainApp({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const now = new Date();
  // Contas sem colaborador vinculado existem só para o rateio diário pessoal —
  // já abrem direto nessa tela em vez do Dashboard, que não tem nada pra mostrar.
  const [view, setView] = useState<View>(user.role === "collaborator" && !user.collaboratorId ? "diario" : "dashboard");
  const role = user.role;
  const currentCollaboratorId = user.collaboratorId ?? "";

  const [workingDays, setWorkingDaysRaw] = useState(22);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [releases, setReleases] = useState<RateioRelease[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingData(true);
    Promise.all([
      apiGet("/collaborators"),
      apiGet("/releases"),
      apiGet("/settings"),
      role === "admin" ? apiGet("/projects") : Promise.resolve([]),
    ])
      .then(([cs, rs, settings, ps]) => {
        if (cancelled) return;
        setCollaborators(cs);
        setReleases(rs);
        setWorkingDaysRaw(settings?.workingDays ?? 22);
        setProjects(ps);
        setLoadingData(false);
      })
      .catch(() => { if (!cancelled) setLoadingData(false); });
    return () => { cancelled = true; };
  }, [role]);

  const setWorkingDays = (n: number) => {
    setWorkingDaysRaw(n);
    apiPut("/settings", { workingDays: n }).catch(() => {});
  };

  const handleNav = (v: View) => setView(v);

  // Sem fallback para collaborators[0]: uma conta sem colaborador vinculado (ex: contas
  // pessoais de rateio diário) não deve "herdar" os dados de outro colaborador qualquer.
  const currentCollaborator = collaborators.find((c) => c.id === currentCollaboratorId);

  if (loadingData) {
    return <div className="flex h-screen items-center justify-center bg-[#f7f7f8] text-sm text-[#a1a1aa]">Carregando…</div>;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#f7f7f8]" style={{ fontFamily: "var(--font-family)" }}>
      <Sidebar
        active={view}
        onNav={handleNav}
        role={role}
        displayName={role === "admin" ? user.username : (currentCollaborator?.name ?? user.username)}
        displaySubtitle={role === "admin" ? "Administrador" : (currentCollaborator?.role ?? "Colaborador")}
        onLogout={onLogout}
      />

      {view === "dashboard" && (
        <DashboardView
          collaborators={collaborators}
          releases={releases}
          projects={projects}
          workingDays={workingDays}
          role={role}
          currentCollaboratorId={currentCollaboratorId}
          onNav={handleNav}
        />
      )}

      {view === "rateio" && role === "admin" && (
        <AdminRateio
          releases={releases}
          setReleases={setReleases}
          collaborators={collaborators}
          workingDays={workingDays}
        />
      )}

      {view === "rateio" && role === "collaborator" && currentCollaborator && (
        <CollaboratorRateio
          releases={releases}
          setReleases={setReleases}
          collaborator={currentCollaborator}
          workingDays={workingDays}
        />
      )}

      {view === "diario" && (
        <DailyRateio displayName={role === "admin" ? user.username : (currentCollaborator?.name ?? user.username)} />
      )}

      {view === "projetos" && role === "admin" && (
        <ProjectsView
          projects={projects}
          setProjects={setProjects}
          collaborators={collaborators}
          workingDays={workingDays}
          defaultMonth={now.getMonth()}
          defaultYear={now.getFullYear()}
        />
      )}

      {view === "colaboradores" && role === "admin" && (
        <ColaboradoresView
          collaborators={collaborators}
          setCollaborators={setCollaborators}
          workingDays={workingDays}
        />
      )}

      {view === "acessos" && role === "admin" && (
        <AcessosView collaborators={collaborators} currentUserId={user.id} />
      )}

      {view === "configuracoes" && role === "admin" && (
        <SettingsView workingDays={workingDays} setWorkingDays={setWorkingDays} />
      )}
    </div>
  );
}

// ─── App (portão de autenticação) ─────────────────────────────────────────────

type AuthStatus = "loading" | "needsSetup" | "needsLogin" | "ready";

export default function App() {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

  const loadStatus = useCallback(() => {
    apiGet("/auth/status")
      .then((d) => {
        if (d.needsSetup) { setStatus("needsSetup"); setUser(null); return; }
        if (!d.authenticated || !d.user) { setStatus("needsLogin"); setUser(null); return; }
        setUser(d.user);
        setStatus("ready");
      })
      .catch(() => { setStatus("needsLogin"); setUser(null); });
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleLogout = () => {
    apiPost("/auth/logout", {}).finally(() => { setUser(null); setStatus("needsLogin"); });
  };

  if (status === "loading") {
    return <div className="flex h-screen items-center justify-center bg-[#f7f7f8] text-sm text-[#a1a1aa]">Carregando…</div>;
  }
  if (status === "needsSetup") return <Setup onDone={loadStatus} />;
  if (status === "needsLogin" || !user) return <Login onDone={loadStatus} />;

  return <MainApp user={user} onLogout={handleLogout} />;
}
