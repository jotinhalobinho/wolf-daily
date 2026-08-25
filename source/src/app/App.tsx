import { useState, useEffect, useCallback } from "react";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from "./api";
import * as XLSX from "xlsx";
import {
  LayoutDashboard, Users, FileBarChart2, Settings, Plus,
  ChevronDown, CheckCircle2, AlertCircle, Clock, FileSpreadsheet, Printer,
  Trash2, Pencil, X, Check, Zap, Lock, Unlock, Shield,
  User, ChevronRight, CalendarDays, Send, MessageSquare,
  ExternalLink, LogOut, KeyRound, Moon, Sun, Laptop2, Building2,
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import DailyRateio from "./DailyRateio";
import HomeOffice from "./HomeOffice";
import { Switch } from "./components/ui/switch";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Unit = "wolf" | "fraga" | "woncred" | "profit";
type View = "dashboard" | "rateio" | "diario" | "homeoffice" | "projetos" | "colaboradores" | "setores" | "acessos" | "relatorios" | "configuracoes";
type UserRole = "admin" | "collaborator";
type RateioStatus = "open" | "approved";

export interface Collaborator {
  id: string;
  name: string;
  role: string;
  salary: number;
  // Opcional — "YYYY-MM-DD". Usado só pra saber o mês do aniversário (o dia
  // off do mês do aniversário é descontado automaticamente do Rateio Mensal).
  birthDate?: string;
  // Campos da Escala de Home Office (ver HomeOffice.tsx):
  sectorId?: string;
  color?: string; // "#RRGGBB" — cor da tag desse colaborador na escala
  hireDate?: string; // "YYYY-MM-DD" — define a cota semanal automática de HO
  active: boolean; // conta pro mínimo presencial do setor quando true
}

// Setor/área — cadastro simples (nome), membros são os colaboradores cujo
// sectorId aponta pra ele (editado no cadastro do colaborador, não aqui).
export interface Sector {
  id: string;
  name: string;
  memberIds: string[];
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
  // Day off de aniversário — normalmente 1 item só, sincronizado a partir do
  // dia marcado no Rateio Diário (ver [[daily-suggestion-feature]]). Também
  // reduz o total de dias a distribuir, igual atestado.
  dayOffs: UnitProject[];
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
  wolf: "var(--unit-wolf-bg)",
  fraga: "var(--unit-fraga-bg)",
  woncred: "var(--unit-woncred-bg)",
  profit: "var(--accent-amber-bg)",
};

export const MONTHS = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

// Abreviações usadas na coluna COMPETÊNCIA da planilha (ex: "Jun-26").
export const MONTHS_SHORT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

// Nomes de empresa usados no modelo de planilha de exportação (podem diferir dos rótulos exibidos na tela).
// Woncred é exportada com a razão social "Fraga e Bitello" (mesma empresa por trás), com a operação
// marcada como "Marketplace" — ver operacaoTextForUnits.
export const UNIT_EXPORT_NAMES: Record<Unit, string> = {
  wolf: "Wolf Vendas",
  fraga: "Fraga e Bitello",
  woncred: "Fraga e Bitello",
  profit: "Profit",
};

// Texto da coluna OPERAÇÃO no export — Fraga usa as tags escolhidas
// (HS/NC/NA's/Todas); Wolf, Woncred e Profit têm operação sempre fixa (não
// têm seletor de tags como a Fraga).
export function operacaoTextForUnits(units: Unit[], operations?: OperationTag[]): string {
  const parts: string[] = [];
  if (units.includes("wolf")) parts.push("Venda de Consórcios (Wolf)");
  if (units.includes("fraga")) {
    const t = operationsToExportText(operations);
    if (t) parts.push(t);
  }
  if (units.includes("woncred")) parts.push("Marketplace");
  if (units.includes("profit")) parts.push("Não Contemplada");
  return parts.join(" + ");
}

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

const dayOffTotal = (e: RateioEntry) =>
  (e.dayOffs ?? []).reduce((s, p) => s + p.days, 0);

// O colaborador aniversariante no mês do período pode marcar um day off no
// Rateio Diário — isto aqui é só usado como dica na tela (mostrar o cartão de
// day off / lembrete); o desconto de verdade vem de dayOffTotal, igual atestado.
// release.month é 0-indexado (0 = Janeiro), igual ao mês extraído de "YYYY-MM-DD".
const isBirthdayMonth = (collaborator: Collaborator | undefined, releaseMonth: number) => {
  const birthDate = collaborator?.birthDate;
  if (!birthDate) return false;
  const month = Number(birthDate.split("-")[1]) - 1;
  return month === releaseMonth;
};

// Total de dias que o colaborador precisa distribuir para "completar" o
// período: os dias úteis do período menos os dias de atestado e de day off lançados.
const requiredDays = (workingDays: number, e: RateioEntry) =>
  Math.max(0, workingDays - atestadoTotal(e) - dayOffTotal(e));

const blankEntry = (collaboratorId: string): RateioEntry => ({
  collaboratorId,
  unitProjects: { wolf: [], fraga: [], woncred: [], profit: [] },
  generalProjects: [],
  atestados: [],
  dayOffs: [],
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

export const fmtDate = (iso: string) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

// ─── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ total, workingDays }: { total: number; workingDays: number }) {
  if (total === 0) return <span className="inline-flex items-center gap-1 text-xs text-[var(--tone-subtle)]"><Clock size={11} />Pendente</span>;
  if (total === workingDays) return <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"><CheckCircle2 size={11} />Completo</span>;
  if (total > workingDays) return <span className="inline-flex items-center gap-1 text-xs font-medium text-red-500"><AlertCircle size={11} />{total}/{workingDays}</span>;
  return <span className="inline-flex items-center gap-1 text-xs text-amber-600"><AlertCircle size={11} />{total}/{workingDays}</span>;
}

function ProgressBar({ total, workingDays }: { total: number; workingDays: number }) {
  const pct = workingDays > 0 ? Math.min((total / workingDays) * 100, 100) : 0;
  const color = total === workingDays ? "#10b981" : total > workingDays ? "#ef4444" : total > 0 ? "#f59e0b" : "var(--tone-track-empty)";
  return (
    <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

export function Avatar({ name, size = 7 }: { name: string; size?: number }) {
  return (
    <div
      className={`rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground shrink-0`}
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
  onChangePassword: () => void;
  nightMode: boolean;
  onToggleNightMode: () => void;
}

const ADMIN_NAV: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={16} /> },
  { id: "rateio", label: "Rateio Mensal", icon: <FileBarChart2 size={16} /> },
  { id: "diario", label: "Meu Rateio Diário", icon: <CalendarDays size={16} /> },
  { id: "homeoffice", label: "Home Office", icon: <Laptop2 size={16} /> },
  { id: "projetos", label: "Projetos", icon: <FileSpreadsheet size={16} /> },
  { id: "colaboradores", label: "Colaboradores", icon: <Users size={16} /> },
  { id: "setores", label: "Setores", icon: <Building2 size={16} /> },
  { id: "acessos", label: "Acessos", icon: <KeyRound size={16} /> },
  { id: "configuracoes", label: "Configurações", icon: <Settings size={16} /> },
];

const COLLAB_NAV: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={16} /> },
  { id: "rateio", label: "Meu Rateio", icon: <FileBarChart2 size={16} /> },
  { id: "diario", label: "Meu Rateio Diário", icon: <CalendarDays size={16} /> },
  { id: "homeoffice", label: "Home Office", icon: <Laptop2 size={16} /> },
];

function Sidebar({ active, onNav, role, displayName, displaySubtitle, onLogout, onChangePassword, nightMode, onToggleNightMode }: SidebarProps) {
  const nav = role === "admin" ? ADMIN_NAV : COLLAB_NAV;
  return (
    <aside className="w-56 shrink-0 h-screen flex flex-col border-r border-border bg-card">
      <div className="h-14 flex items-center px-5 border-b border-border">
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
                ? "bg-muted text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-background"
            }`}
          >
            <span className={active === item.id ? "text-foreground" : "text-[var(--tone-subtle)]"}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      {/* Usuário logado */}
      <div className="px-3 py-3 border-t border-border">
        <div className="flex items-center gap-2.5 px-1 mb-2">
          <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0">
            {role === "admin" ? <Shield size={12} className="text-muted-foreground" /> : <User size={12} className="text-muted-foreground" />}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium truncate">{displayName}</p>
            <p className="text-[10px] text-[var(--tone-subtle)] truncate">{displaySubtitle}</p>
          </div>
        </div>
        <div className="w-full flex items-center gap-2 px-3 h-8 rounded-lg text-xs text-muted-foreground">
          <span className="flex items-center gap-2 flex-1">
            {nightMode ? <Moon size={13} /> : <Sun size={13} />}
            Modo noturno
          </span>
          <Switch checked={nightMode} onCheckedChange={onToggleNightMode} aria-label="Alternar modo noturno" />
        </div>
        <button
          onClick={onChangePassword}
          className="w-full flex items-center gap-2 px-3 h-7 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-background transition-all"
        >
          <KeyRound size={13} />Alterar senha
        </button>
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-2 px-3 h-7 rounded-lg text-xs text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/15 transition-all"
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
  sectors: Sector[];
  onSave: (c: Omit<Collaborator, "id">) => void;
  onCancel: () => void;
}

// Cor padrão sugerida pra colaboradores novos (só um ponto de partida no
// color picker — cada um normalmente troca pra ficar igual à cor usada na
// planilha antiga de Home Office).
const DEFAULT_COLLABORATOR_COLOR = "#3b82f6";

function CollaboratorForm({ initial, workingDays, sectors, onSave, onCancel }: CollaboratorFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? "");
  const [salary, setSalary] = useState(initial?.salary?.toString() ?? "");
  const [birthDate, setBirthDate] = useState(initial?.birthDate ?? "");
  const [sectorId, setSectorId] = useState(initial?.sectorId ?? "");
  const [color, setColor] = useState(initial?.color ?? DEFAULT_COLLABORATOR_COLOR);
  const [hireDate, setHireDate] = useState(initial?.hireDate ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const salaryNum = parseFloat(salary.replace(",", ".")) || 0;
  const daily = workingDays > 0 ? salaryNum / workingDays : 0;
  const validColor = /^#[0-9a-fA-F]{6}$/.test(color);
  const valid = name.trim() && role.trim() && salaryNum > 0 && validColor;
  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Nome</label>
          <input className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" placeholder="Nome completo" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Cargo</label>
          <input className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" placeholder="Cargo" value={role} onChange={(e) => setRole(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Salário Mensal</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-[var(--tone-subtle)]">R$</span>
            <input className="w-full h-8 pl-7 pr-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" placeholder="0,00" value={salary} onChange={(e) => setSalary(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Valor por Dia</label>
          <div className="h-8 px-3 flex items-center text-sm rounded-lg bg-background border border-border text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
            {daily > 0 ? fmt(daily) : "—"}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Aniversário (opcional)</label>
          <input type="date" className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
          <p className="text-[10px] text-[var(--tone-subtle)] mt-1">No mês do aniversário, 1 dia é descontado automaticamente do Rateio Mensal (day off).</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Setor (Home Office)</label>
          <select className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" value={sectorId} onChange={(e) => setSectorId(e.target.value)}>
            <option value="">Sem setor</option>
            {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Admissão (define a cota de Home Office)</label>
          <input type="date" className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" value={hireDate} onChange={(e) => setHireDate(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
          <p className="text-[10px] text-[var(--tone-subtle)] mt-1">Menos de 1 mês: 0 dias/semana · 1 a 2 meses: 1 dia/semana · 2+ meses: 2 dias/semana.</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Cor na Escala de Home Office</label>
          <div className="flex items-center gap-2">
            <input type="color" value={validColor ? color : DEFAULT_COLLABORATOR_COLOR} onChange={(e) => setColor(e.target.value)} className="w-8 h-8 rounded-lg border border-border cursor-pointer bg-background p-0.5" />
            <input className="flex-1 h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" placeholder="#3b82f6" value={color} onChange={(e) => setColor(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
          </div>
          {!validColor && <p className="text-[10px] text-red-500 mt-1">Use o formato #RRGGBB</p>}
        </div>
        <div className="flex items-center justify-between px-1">
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Colaborador ativo</label>
            <p className="text-[10px] text-[var(--tone-subtle)] mt-0.5">Inativos não contam no mínimo presencial do setor</p>
          </div>
          <Switch checked={active} onCheckedChange={setActive} />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onCancel} className="h-8 px-4 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-input-background transition-all">Cancelar</button>
        {/* birthDate/hireDate/sectorId vão como "" (não undefined) quando
            limpos, pra garantir que o JSON enviado ao servidor tenha a chave
            e ele saiba que é pra apagar o valor — undefined simplesmente
            some do corpo da requisição (JSON.stringify descarta a chave). */}
        <button onClick={() => valid && onSave({ name: name.trim(), role: role.trim(), salary: salaryNum, birthDate, sectorId: sectorId || "", color, hireDate, active })} disabled={!valid} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all">Salvar</button>
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
              active ? "bg-[#8b5cf6] border-[#8b5cf6] text-white" : "bg-card border-[var(--border-10)] text-[var(--tone-subtle)] hover:border-[#8b5cf6]/50"
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
              className="flex-1 h-7 px-2.5 text-xs font-medium bg-transparent border border-transparent rounded-lg outline-none focus:border-[var(--border-10)] focus:bg-card transition-all disabled:cursor-default"
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
                  backgroundColor: p.days > 0 ? lightBg : "var(--background)",
                  borderColor: p.days > 0 ? color + "40" : "var(--border)",
                  color: p.days > 0 ? color : "var(--muted-foreground)",
                  fontFamily: "var(--font-mono)",
                }}
              />
              <span className="text-[10px] text-[var(--tone-subtle)] w-5">d</span>
            </div>
            {!disabled && (
              <button
                onClick={() => remove(i)}
                className="w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-400 text-[var(--tone-faint)] transition-all shrink-0"
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
            className="flex-1 h-7 px-2.5 text-xs bg-background border border-dashed border-[var(--border-12)] rounded-lg outline-none transition-all placeholder:text-[var(--tone-faint)] focus:bg-card"
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
            <p className="text-xs text-muted-foreground mt-0.5">Gerencie e libere os períodos de rateio</p>
          </div>
          <button onClick={() => setCreating(true)} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all flex items-center gap-1.5">
            <Plus size={14} />Liberar Rateio
          </button>
        </div>

        {creating && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold">Novo Período de Rateio</h3>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Mês</label>
                <div className="relative">
                  <select value={form.month} onChange={(e) => setForm((f) => ({ ...f, month: Number(e.target.value) }))} className="w-full appearance-none h-8 pl-3 pr-7 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary cursor-pointer">
                    {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                  </select>
                  <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--tone-subtle)] pointer-events-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Ano</label>
                <input type="number" value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: Number(e.target.value) }))} className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" style={{ fontFamily: "var(--font-mono)" }} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Dias Úteis</label>
                <input type="number" min={1} max={31} value={form.workingDays} onChange={(e) => setForm((f) => ({ ...f, workingDays: Number(e.target.value) }))} className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" style={{ fontFamily: "var(--font-mono)" }} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Data Limite</label>
                <input type="date" value={form.deadline} onChange={(e) => setForm((f) => ({ ...f, deadline: e.target.value }))} className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setCreating(false)} className="h-8 px-4 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-input-background transition-all">Cancelar</button>
              <button onClick={createRelease} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all flex items-center gap-1.5"><Unlock size={13} />Liberar</button>
            </div>
          </div>
        )}

        {releases.length === 0 && !creating ? (
          <div className="bg-card border border-border rounded-xl p-16 flex flex-col items-center justify-center text-center">
            <div className="w-10 h-10 bg-muted rounded-xl flex items-center justify-center mb-3"><Lock size={18} className="text-[var(--tone-subtle)]" /></div>
            <p className="text-sm font-medium">Nenhum período liberado</p>
            <p className="text-xs text-[var(--tone-subtle)] mt-1 mb-4">Libere um período para que os colaboradores possam preencher o rateio</p>
            <button onClick={() => setCreating(true)} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all">Liberar primeiro período</button>
          </div>
        ) : (
          <div className="space-y-3">
            {[...releases].reverse().map((r) => {
              const total = r.entries.reduce((s, e) => s + entryTotal(e), 0);
              const done = r.entries.filter((e) => entryTotal(e) === requiredDays(r.workingDays, e)).length;
              const totalPossible = r.entries.reduce((s, e) => s + requiredDays(r.workingDays, e), 0);
              return (
                <button key={r.id} onClick={() => setSelectedId(r.id)} className="w-full bg-card border border-border rounded-xl px-5 py-4 text-left hover:border-[var(--border-14)] hover:shadow-sm transition-all flex items-center gap-4">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${r.status === "approved" ? "bg-emerald-50 dark:bg-emerald-500/15" : "bg-blue-50 dark:bg-blue-500/15"}`}>
                    {r.status === "approved" ? <CheckCircle2 size={16} className="text-emerald-500" /> : <Unlock size={16} className="text-blue-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-semibold">{MONTHS[r.month]} {r.year}</p>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${r.status === "approved" ? "bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600" : "bg-blue-50 dark:bg-blue-500/15 text-blue-600"}`}>
                        {r.status === "approved" ? "Aprovado" : "Aberto"}
                      </span>
                      {r.deadline && <span className="text-[10px] text-[var(--tone-subtle)]">Limite: {fmtDate(r.deadline)}</span>}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span>{r.workingDays} dias úteis</span>
                      <span>{done}/{r.entries.length} completos</span>
                      <span>{total}/{totalPossible} dias lançados</span>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-[var(--tone-subtle)] shrink-0" />
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
          operacaoTextForUnits([u], p.operations),
          "",
          p.days,
        ]);
      }
    }

    // "Demandas Gerais" (sem centro de custo específico) sempre vira uma
    // única linha por projeto — nunca uma por centro de custo — com empresa
    // fixa "Fraga e Bitello" e a observação "Todas".
    for (const p of entry.generalProjects ?? []) {
      if (!p.days) continue;
      rows.push(["", competencia, c.name, p.name, "Fraga e Bitello", "Todas", "", "", p.days]);
    }

    // Atestado e day off só reduzem os dias úteis exigidos do colaborador
    // (ver requiredDays) — não entram na planilha de exportação.
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
              <button onClick={onBack} className="text-xs text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1 transition-colors">← Todos os períodos</button>
              <h1 className="text-xl font-semibold tracking-tight">Rateio — {MONTHS[release.month]} {release.year}</h1>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-xs text-muted-foreground">{release.workingDays} dias úteis</span>
                {release.deadline && <span className="text-xs text-muted-foreground">Limite: {fmtDate(release.deadline)}</span>}
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${release.status === "approved" ? "bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600" : "bg-blue-50 dark:bg-blue-500/15 text-blue-600"}`}>
                  {release.status === "approved" ? `Aprovado em ${fmtDate(release.approvedAt?.split("T")[0] ?? "")}` : "Aberto"}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => exportReleaseToExcel(release, collaborators)} className="h-8 px-4 text-sm font-medium bg-card border border-border text-foreground rounded-lg hover:border-[var(--border-14)] transition-all flex items-center gap-1.5">
                <FileSpreadsheet size={14} />Exportar Excel
              </button>
              {release.status === "open" && (
                <button onClick={onApprove} disabled={!allComplete} className="h-8 px-4 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5">
                  <CheckCircle2 size={14} />Aprovar Rateio
                </button>
              )}
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Colaborador</th>
                  <th className="text-right px-3 py-3 text-xs font-medium text-muted-foreground">Salário</th>
                  <th className="text-right px-3 py-3 text-xs font-medium text-muted-foreground">Valor/Dia</th>
                  {UNITS.map((u) => (
                    <th key={u} className="text-center px-3 py-3 text-xs font-medium" style={{ color: UNIT_COLORS[u] }}>
                      {u === "wolf" ? "Wolf" : u === "fraga" ? "Fraga" : u === "woncred" ? "Woncred" : "Profit"}
                    </th>
                  ))}
                  <th className="text-center px-3 py-3 text-xs font-medium text-muted-foreground">Geral</th>
                  <th className="text-center px-3 py-3 text-xs font-medium text-muted-foreground w-36">Progresso</th>
                  <th className="text-center px-3 py-3 text-xs font-medium text-muted-foreground">Status</th>
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
                        className={`border-b border-[var(--border-4)] transition-colors cursor-pointer group ${total === target ? "bg-emerald-50/20 dark:bg-emerald-500/15" : total > target ? "bg-red-50/30 dark:bg-red-500/15" : ""}`}
                        onClick={() => setExpandedId(isExpanded ? null : c.id)}
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={c.name} />
                            <div className="flex-1">
                              <div className="flex items-center gap-1.5">
                                <p className="text-sm font-medium leading-tight">{c.name}</p>
                                {UNITS.some((u) => (entry.unitProjects?.[u] ?? []).length > 0) && (
                                  <span className="text-[9px] font-medium px-1 py-0.5 bg-muted text-muted-foreground rounded">projetos</span>
                                )}
                                {atestadoTotal(entry) > 0 && (
                                  <span className="text-[9px] font-medium px-1 py-0.5 bg-amber-50 dark:bg-amber-500/15 text-amber-600 rounded">atestado {atestadoTotal(entry)}d</span>
                                )}
                                {dayOffTotal(entry) > 0 && (
                                  <span className="text-[9px] font-medium px-1 py-0.5 bg-pink-50 dark:bg-pink-500/15 text-pink-600 rounded">🎂 day off {dayOffTotal(entry)}d</span>
                                )}
                              </div>
                              <p className="text-[11px] text-[var(--tone-subtle)] leading-tight">{c.role}</p>
                            </div>
                            <ChevronDown size={12} className={`text-[var(--tone-faint)] shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right text-sm tabular-nums text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>{fmt(c.salary)}</td>
                        <td className="px-3 py-3 text-right text-xs tabular-nums text-[var(--tone-subtle)]" style={{ fontFamily: "var(--font-mono)" }}>{fmt(rate)}</td>
                        {UNITS.map((u) => {
                          const ud = unitTotal(entry, u);
                          return (
                            <td key={u} className="px-3 py-3 text-center">
                              <div className="flex flex-col items-center gap-0.5">
                                <span className={`text-xs font-medium px-1.5 py-0.5 rounded-md tabular-nums ${ud > 0 ? "" : "text-[var(--tone-line)]"}`} style={ud > 0 ? { color: UNIT_COLORS[u], backgroundColor: UNIT_LIGHT[u], fontFamily: "var(--font-mono)" } : { fontFamily: "var(--font-mono)" }}>
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
                              <span className={`text-xs font-medium px-1.5 py-0.5 rounded-md tabular-nums ${gd > 0 ? "bg-input-background text-[var(--tone-dim)]" : "text-[var(--tone-line)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                                {gd > 0 ? gd : "—"}
                              </span>
                            </div>
                          </td>
                        ); })()}
                        <td className="px-3 py-3">
                          <div className="space-y-1">
                            <span className="text-[10px] text-[var(--tone-subtle)]" style={{ fontFamily: "var(--font-mono)" }}>{total}/{target}</span>
                            <ProgressBar total={total} workingDays={target} />
                          </div>
                        </td>
                        <td className="px-3 py-3 text-center"><StatusBadge total={total} workingDays={target} /></td>
                      </tr>
                      {isExpanded && (
                        <tr key={`obs-${c.id}`} className="border-b border-[var(--border-4)] bg-[var(--tone-card-alt)]">
                          <td colSpan={8} className="px-5 py-4">
                            <div className="space-y-3">
                              {/* Projects per unit */}
                              {UNITS.some((u) => (entry.unitProjects?.[u] ?? []).length > 0) && (
                                <div>
                                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Projetos por unidade</p>
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
                                                <span className="text-[11px] text-[var(--tone-dim)] truncate flex items-center gap-1.5">
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
                                  <MessageSquare size={13} className="text-[var(--tone-subtle)] mt-0.5 shrink-0" />
                                  <div>
                                    <p className="text-[10px] font-medium text-muted-foreground mb-0.5">Observações de {c.name}</p>
                                    <p className="text-xs text-muted-foreground whitespace-pre-wrap">{entry.observations}</p>
                                  </div>
                                </div>
                              )}
                              {/* General projects */}
                              {(entry.generalProjects ?? []).length > 0 && (
                                <div>
                                  <div className="flex items-center gap-2 mb-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--tone-subtle)]" />
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Demandas Gerais</p>
                                    <span className="text-[10px] font-semibold tabular-nums text-muted-foreground ml-auto" style={{ fontFamily: "var(--font-mono)" }}>{generalTotal(entry)}d</span>
                                  </div>
                                  <div className="space-y-1">
                                    {(entry.generalProjects ?? []).map((p, pi) => (
                                      <div key={pi} className="flex items-center justify-between gap-3">
                                        <span className="text-[11px] text-[var(--tone-dim)] truncate">{p.name}</span>
                                        <span className="text-[11px] font-semibold tabular-nums shrink-0 px-1.5 py-0.5 rounded bg-input-background text-[var(--tone-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{p.days}d</span>
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
                                        <span className="text-[11px] text-[var(--tone-dim)] truncate">{p.name}</span>
                                        <span className="text-[11px] font-semibold tabular-nums shrink-0 px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-500/15 text-amber-600" style={{ fontFamily: "var(--font-mono)" }}>{p.days}d</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {/* Day off de aniversário */}
                              {(entry.dayOffs ?? []).length > 0 && (
                                <div>
                                  <div className="flex items-center gap-2 mb-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-pink-500" />
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-pink-600">🎂 Day off</p>
                                    <span className="text-[10px] font-semibold tabular-nums text-pink-600 ml-auto" style={{ fontFamily: "var(--font-mono)" }}>{dayOffTotal(entry)}d</span>
                                  </div>
                                  <div className="space-y-1">
                                    {(entry.dayOffs ?? []).map((p, pi) => (
                                      <div key={pi} className="flex items-center justify-between gap-3">
                                        <span className="text-[11px] text-[var(--tone-dim)] truncate">{p.name}</span>
                                        <span className="text-[11px] font-semibold tabular-nums shrink-0 px-1.5 py-0.5 rounded bg-pink-50 dark:bg-pink-500/15 text-pink-600" style={{ fontFamily: "var(--font-mono)" }}>{p.days}d</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {!entry.observations && !UNITS.some((u) => (entry.unitProjects?.[u] ?? []).length > 0) && !(entry.generalProjects ?? []).length && !(entry.atestados ?? []).length && !(entry.dayOffs ?? []).length && (
                                <p className="text-xs text-[var(--tone-subtle)] italic">Nenhuma informação adicional</p>
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
      <div className="w-60 shrink-0 border-l border-border bg-card overflow-auto">
        <div className="p-5 space-y-5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Resumo</h3>
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
                  <span className="text-[var(--tone-subtle)]">Valor</span>
                  <span className="font-medium tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(entry.valor)}</span>
                </div>
                <div className="pl-4 w-full h-1 bg-muted rounded-full"><div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: UNIT_COLORS[u] }} /></div>
              </div>
            );
          })}
          <div className="pt-3 border-t border-border space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground font-medium">Total Folha</span>
              <span className="font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(totalFolha)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground font-medium">Total Rateado</span>
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
          <p className="text-xs text-muted-foreground mt-0.5">Olá, {collaborator.name} · {openReleases.length} período(s) aberto(s)</p>
        </div>

        {openReleases.length > 0 && (
          <div className="bg-blue-50 dark:bg-blue-500/15 border border-blue-100 dark:border-blue-500/20 rounded-xl p-4">
            <p className="text-xs font-medium text-blue-700 mb-2">Períodos aguardando preenchimento</p>
            <div className="space-y-2">
              {openReleases.map((r) => {
                const entry = r.entries.find((e) => e.collaboratorId === collaborator.id) ?? blankEntry(collaborator.id);
                const total = entryTotal(entry);
                const target = requiredDays(r.workingDays, entry);
                return (
                  <button key={r.id} onClick={() => setSelectedId(r.id)} className="w-full flex items-center justify-between bg-card rounded-lg px-4 py-2.5 text-left hover:shadow-sm transition-all border border-blue-100 dark:border-blue-500/20">
                    <div>
                      <p className="text-sm font-medium">{MONTHS[r.month]} {r.year}</p>
                      <p className="text-[11px] text-muted-foreground">{r.workingDays} dias úteis{r.deadline ? ` · Limite: ${fmtDate(r.deadline)}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge total={total} workingDays={target} />
                      <ChevronRight size={14} className="text-[var(--tone-subtle)]" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Histórico</p>
          {allReleases.length === 0 && <p className="text-sm text-[var(--tone-subtle)]">Nenhum período disponível ainda.</p>}
          {allReleases.map((r) => {
            const entry = r.entries.find((e) => e.collaboratorId === collaborator.id) ?? blankEntry(collaborator.id);
            const total = entryTotal(entry);
            const target = requiredDays(r.workingDays, entry);
            return (
              <button key={r.id} onClick={() => setSelectedId(r.id)} className="w-full bg-card border border-border rounded-xl px-5 py-3.5 text-left hover:border-[var(--border-14)] transition-all flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${r.status === "approved" ? "bg-emerald-50 dark:bg-emerald-500/15" : "bg-blue-50 dark:bg-blue-500/15"}`}>
                  {r.status === "approved" ? <CheckCircle2 size={14} className="text-emerald-500" /> : <Unlock size={14} className="text-blue-500" />}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">{MONTHS[r.month]} {r.year}</p>
                  <p className="text-[11px] text-[var(--tone-subtle)]">{total}/{target} dias · {r.status === "approved" ? "Aprovado" : "Aberto"}</p>
                </div>
                <StatusBadge total={total} workingDays={target} />
                <ChevronRight size={14} className="text-[var(--tone-subtle)]" />
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
    dayOffs: initialEntry.dayOffs ?? [],
  });
  const [savedFlash, setSavedFlash] = useState(false);
  const [fillingFromDaily, setFillingFromDaily] = useState(false);
  const isLocked = release.status === "approved";

  const total = entryTotal(draft);
  const birthdayMonth = isBirthdayMonth(collaborator, release.month);
  // Dias de atestado e de day off (marcado no Rateio Diário) reduzem o total exigido para completar o rateio.
  const target = requiredDays(release.workingDays, draft);
  const remaining = target - total;

  const setUnitProjects = (u: Unit, projects: UnitProject[]) => {
    setDraft((d) => ({ ...d, unitProjects: { ...d.unitProjects, [u]: projects } }));
  };

  const save = () => {
    onSave({ ...draft, submitted: true });
    setSavedFlash(true);
  };

  // Busca o que já foi lançado no Rateio Diário nesse mesmo mês/ano e
  // preenche os projetos por centro de custo automaticamente — evita
  // digitar tudo de novo pra quem já vem lançando dia a dia. Só sugere, não
  // salva nada sozinho: o colaborador ainda revisa e clica em "Salvar Rateio".
  const fillFromDaily = () => {
    if (total > 0 || atestadoTotal(draft) > 0) {
      if (!window.confirm("Isso vai substituir os projetos já preenchidos aqui pelo que está lançado no Rateio Diário deste mês. Continuar?")) return;
    }
    setFillingFromDaily(true);
    apiGet(`/releases/${release.id}/entries/${collaborator.id}/daily-suggestion`)
      .then((s: { found: boolean; unitProjects: Record<Unit, UnitProject[]>; generalProjects: UnitProject[]; atestados: UnitProject[]; dayOffs: UnitProject[] }) => {
        if (!s.found) {
          alert("Nenhum lançamento encontrado no Rateio Diário para este mês.");
          return;
        }
        setDraft((d) => ({ ...d, unitProjects: s.unitProjects, generalProjects: s.generalProjects, atestados: s.atestados, dayOffs: s.dayOffs }));
      })
      .catch((e) => alert(e.message))
      .finally(() => setFillingFromDaily(false));
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <button onClick={onBack} className="text-xs text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1 transition-colors">← Meu Rateio</button>
            <h1 className="text-xl font-semibold tracking-tight">Rateio — {MONTHS[release.month]} {release.year}</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {release.workingDays} dias úteis
              {release.deadline ? ` · Limite: ${fmtDate(release.deadline)}` : ""}
              {isLocked ? " · Aprovado — somente leitura" : ""}
            </p>
          </div>
          {!isLocked && (
            <div className="flex items-center gap-2">
              <button
                onClick={fillFromDaily}
                disabled={fillingFromDaily}
                title="Preenche os projetos abaixo com o que já foi lançado no Rateio Diário deste mês"
                className="h-8 px-3.5 text-sm font-medium bg-card border border-[var(--border-10)] rounded-lg hover:border-[var(--border-20)] transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Zap size={13} />{fillingFromDaily ? "Buscando…" : "Preencher com o diário"}
              </button>
              <button onClick={save} className={`h-8 px-4 text-sm font-medium rounded-lg transition-all flex items-center gap-1.5 ${savedFlash ? "bg-emerald-500 text-white" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}>
                {savedFlash ? <><Check size={13} />Salvo!</> : <><Send size={13} />Salvar Rateio</>}
              </button>
            </div>
          )}
        </div>

        {/* Totalizador geral */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-end justify-between mb-3">
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Total geral</p>
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)", color: total > target ? "#ef4444" : total === target ? "#10b981" : "var(--foreground)" }}>{total}</span>
                <span className="text-sm text-[var(--tone-subtle)]">/ {target} dias</span>
              </div>
              {atestadoTotal(draft) > 0 && (
                <p className="text-[10px] text-amber-600 mt-0.5">
                  {release.workingDays} dias úteis − {atestadoTotal(draft)} dia(s) de atestado
                </p>
              )}
              {dayOffTotal(draft) > 0 && (
                <p className="text-[10px] text-pink-600 mt-0.5">🎂 Day off de aniversário − {dayOffTotal(draft)} dia(s)</p>
              )}
              {dayOffTotal(draft) === 0 && birthdayMonth && (
                <p className="text-[10px] text-pink-600 mt-0.5">🎂 Este é seu mês de aniversário — marque o day off no Rateio Diário</p>
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
                  <p className="text-[9px] font-medium uppercase tracking-wider mb-0.5 text-[var(--tone-subtle)]">Geral</p>
                  <p className="text-base font-semibold tabular-nums text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>{generalTotal(draft)}</p>
                </div>
              )}
              {atestadoTotal(draft) > 0 && (
                <div className="text-center">
                  <p className="text-[9px] font-medium uppercase tracking-wider mb-0.5 text-amber-600">Atestado</p>
                  <p className="text-base font-semibold tabular-nums text-amber-600" style={{ fontFamily: "var(--font-mono)" }}>{atestadoTotal(draft)}</p>
                </div>
              )}
              {dayOffTotal(draft) > 0 && (
                <div className="text-center">
                  <p className="text-[9px] font-medium uppercase tracking-wider mb-0.5 text-pink-600">Day off</p>
                  <p className="text-base font-semibold tabular-nums text-pink-600" style={{ fontFamily: "var(--font-mono)" }}>{dayOffTotal(draft)}</p>
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
              className="bg-card border rounded-xl p-5 transition-all"
              style={{ borderColor: ad > 0 ? "var(--accent-amber-border)" : "var(--border)" }}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-amber-500" />
                  <p className="text-sm font-semibold">Atestado</p>
                  <span className="text-[10px] text-[var(--tone-subtle)] font-normal">cada dia lançado reduz 1 dia do total a distribuir</span>
                </div>
                <span
                  className="text-sm font-bold tabular-nums px-2 py-0.5 rounded-lg"
                  style={{
                    fontFamily: "var(--font-mono)",
                    backgroundColor: ad > 0 ? "var(--accent-amber-bg)" : "var(--background)",
                    color: ad > 0 ? "#d97706" : "var(--tone-faint)",
                  }}
                >
                  {ad > 0 ? `${ad}d` : "0d"}
                </span>
              </div>
              {aItems.length === 0 && isLocked && (
                <p className="text-xs text-[var(--tone-faint)] italic">Nenhum atestado lançado</p>
              )}
              <ProjectEntryInput
                projects={aItems}
                color="#d97706"
                lightBg="var(--accent-amber-bg)"
                disabled={isLocked}
                itemLabel="atestado (ex: data e motivo)"
                onChange={(updated) => setDraft((d) => ({ ...d, atestados: updated }))}
              />
            </div>
          );
        })()}

        {/* Day off de aniversário — normalmente vem sozinho do dia marcado no
            Rateio Diário (via "Preencher com o diário"); só aparece aqui no
            mês do aniversário ou se já tiver algo lançado. */}
        {(birthdayMonth || dayOffTotal(draft) > 0) && (() => {
          const dd = dayOffTotal(draft);
          const dItems = draft.dayOffs ?? [];
          return (
            <div
              className="bg-card border rounded-xl p-5 transition-all"
              style={{ borderColor: dd > 0 ? "var(--accent-pink-border)" : "var(--border)" }}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-pink-500" />
                  <p className="text-sm font-semibold">🎂 Day off de aniversário</p>
                  <span className="text-[10px] text-[var(--tone-subtle)] font-normal">marcado no Rateio Diário, no dia do aniversário</span>
                </div>
                <span
                  className="text-sm font-bold tabular-nums px-2 py-0.5 rounded-lg"
                  style={{
                    fontFamily: "var(--font-mono)",
                    backgroundColor: dd > 0 ? "var(--accent-pink-bg)" : "var(--background)",
                    color: dd > 0 ? "#db2777" : "var(--tone-faint)",
                  }}
                >
                  {dd > 0 ? `${dd}d` : "0d"}
                </span>
              </div>
              {dItems.length === 0 && (
                <p className="text-xs text-[var(--tone-faint)] italic">Nenhum day off marcado ainda — use "Preencher com o diário" depois de marcar no Rateio Diário.</p>
              )}
              <ProjectEntryInput
                projects={dItems}
                color="#db2777"
                lightBg="var(--accent-pink-bg)"
                disabled={isLocked}
                itemLabel="day off (ex: data do aniversário)"
                onChange={(updated) => setDraft((d) => ({ ...d, dayOffs: updated }))}
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
                className="bg-card border rounded-xl p-5 transition-all"
                style={{ borderColor: ud > 0 ? UNIT_COLORS[u] + "30" : "var(--border)" }}
              >
                {/* Card header: label + total */}
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: UNIT_COLORS[u] }} />
                    <p className="text-sm font-semibold">{UNIT_NAMES[u]}</p>
                    {u === "fraga" && (
                      <span className="text-[9px] text-[var(--tone-subtle)] font-normal">marque a operação de cada atividade</span>
                    )}
                  </div>
                  {/* Totalizador do centro */}
                  <span
                    className="text-sm font-bold tabular-nums px-2 py-0.5 rounded-lg"
                    style={{
                      fontFamily: "var(--font-mono)",
                      backgroundColor: ud > 0 ? UNIT_LIGHT[u] : "var(--background)",
                      color: ud > 0 ? UNIT_COLORS[u] : "var(--tone-faint)",
                    }}
                  >
                    {ud > 0 ? `${ud}d` : "0d"}
                  </span>
                </div>
                {/* Barra de progresso da unidade */}
                <div className="w-full h-0.5 bg-muted rounded-full mb-4">
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
                  <p className="text-xs text-[var(--tone-faint)] italic">Nenhum projeto lançado</p>
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
              className="bg-card border rounded-xl p-5 transition-all"
              style={{ borderColor: gd > 0 ? "var(--border-12)" : "var(--border)" }}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[var(--tone-subtle)]" />
                  <p className="text-sm font-semibold">Demandas Gerais</p>
                  <span className="text-[10px] text-[var(--tone-subtle)] font-normal">todos os centros de custo</span>
                </div>
                <span
                  className="text-sm font-bold tabular-nums px-2 py-0.5 rounded-lg"
                  style={{
                    fontFamily: "var(--font-mono)",
                    backgroundColor: gd > 0 ? "var(--input-background)" : "var(--background)",
                    color: gd > 0 ? "var(--tone-dim)" : "var(--tone-faint)",
                  }}
                >
                  {gd > 0 ? `${gd}d` : "0d"}
                </span>
              </div>
              <div className="w-full h-0.5 bg-muted rounded-full mb-4">
                {gd > 0 && (
                  <div
                    className="h-full rounded-full bg-[var(--tone-subtle)] transition-all"
                    style={{ width: `${Math.min((gd / target) * 100, 100)}%` }}
                  />
                )}
              </div>
              {gProjs.length === 0 && isLocked && (
                <p className="text-xs text-[var(--tone-faint)] italic">Nenhuma demanda geral lançada</p>
              )}
              <ProjectEntryInput
                projects={gProjs}
                color="var(--muted-foreground)"
                lightBg="var(--input-background)"
                disabled={isLocked}
                onChange={(updated) => setDraft((d) => ({ ...d, generalProjects: updated }))}
              />
            </div>
          );
        })()}

        {/* Observations */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <MessageSquare size={14} className="text-[var(--tone-subtle)]" />
            <p className="text-sm font-semibold">Observações de Atividades</p>
          </div>
          <p className="text-xs text-[var(--tone-subtle)] mb-3">Explique brevemente o que foi feito em cada unidade e os motivos de cada distribuição de dias.</p>
          <textarea
            value={draft.observations}
            disabled={isLocked}
            onChange={(e) => setDraft({ ...draft, observations: e.target.value })}
            placeholder="Ex: Trabalhei 10 dias na Wolf finalizando o módulo de relatórios. 8 dias na Fraga por conta da integração com o ERP..."
            rows={5}
            className="w-full text-sm bg-background border border-border rounded-lg px-4 py-3 outline-none focus:border-primary focus:bg-card transition-all resize-none text-foreground placeholder:text-[var(--tone-faint)] disabled:opacity-50"
          />
        </div>

        {!isLocked && (
          <div className="flex justify-end">
            <button onClick={save} className={`h-9 px-6 text-sm font-medium rounded-lg transition-all flex items-center gap-2 ${savedFlash ? "bg-emerald-500 text-white" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}>
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
      <div className="bg-card rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border print:hidden">
          <p className="text-sm font-medium">Exportar Projeto</p>
          <div className="flex items-center gap-2">
            <button onClick={() => window.print()} className="h-8 px-3 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all flex items-center gap-1.5">
              <Printer size={13} />Imprimir / PDF
            </button>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-input-background rounded-lg transition-all"><X size={16} /></button>
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
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Equipe de TI</span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight mt-3">{project.name}</h1>
              {project.description && <p className="text-sm text-muted-foreground mt-1">{project.description}</p>}
            </div>
            <div className="text-right">
              <p className="text-xs text-[var(--tone-subtle)]">Emitido em</p>
              <p className="text-sm font-medium">{today}</p>
              {project.requester && <><p className="text-xs text-[var(--tone-subtle)] mt-2">Solicitante</p><p className="text-sm font-medium">{project.requester}</p></>}
            </div>
          </div>

          {/* Meta */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Período", value: `${MONTHS[project.month]} ${project.year}` },
              { label: "Início", value: project.startDate ? fmtDate(project.startDate) : "—" },
              { label: "Término", value: project.endDate ? fmtDate(project.endDate) : "—" },
            ].map((item) => (
              <div key={item.label} className="bg-background rounded-xl p-4">
                <p className="text-[10px] font-medium text-[var(--tone-subtle)] uppercase tracking-wider mb-1">{item.label}</p>
                <p className="text-sm font-semibold">{item.value}</p>
              </div>
            ))}
          </div>

          <div className="border-t border-border" />

          {/* Team */}
          <div>
            <h2 className="text-sm font-semibold mb-4">Equipe do Projeto</h2>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border-8)]">
                  <th className="text-left pb-2 text-xs font-medium text-muted-foreground">Colaborador</th>
                  <th className="text-left pb-2 text-xs font-medium text-muted-foreground">Cargo</th>
                  <th className="text-center pb-2 text-xs font-medium text-muted-foreground">Dias</th>
                  <th className="text-right pb-2 text-xs font-medium text-muted-foreground">Custo</th>
                  <th className="text-right pb-2 text-xs font-medium text-muted-foreground">%</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.collaboratorId} className="border-b border-[var(--border-4)]">
                    <td className="py-2.5 text-sm font-medium">{m.name}</td>
                    <td className="py-2.5 text-xs text-muted-foreground">{m.role}</td>
                    <td className="py-2.5 text-center text-sm tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{m.days}</td>
                    <td className="py-2.5 text-right text-sm font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(m.cost)}</td>
                    <td className="py-2.5 text-right text-xs text-[var(--tone-subtle)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{total > 0 ? ((m.cost / total) * 100).toFixed(1) : 0}%</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-primary">
                  <td colSpan={2} className="pt-3 text-sm font-bold">Total do Projeto</td>
                  <td className="pt-3 text-center text-sm font-bold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{members.reduce((s, m) => s + m.days, 0)}</td>
                  <td className="pt-3 text-right text-sm font-bold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(total)}</td>
                  <td className="pt-3 text-right text-sm font-bold" style={{ fontFamily: "var(--font-mono)" }}>100%</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="border-t border-border" />

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
                      {project.costCenters.length > 1 && <span className="text-xs text-[var(--tone-subtle)]">{project.splits[u]}%</span>}
                    </div>
                    <div className="flex-1 h-2 bg-muted rounded-full">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: UNIT_COLORS[u] }} />
                    </div>
                    <span className="text-sm font-semibold tabular-nums w-28 text-right" style={{ fontFamily: "var(--font-mono)", color: UNIT_COLORS[u] }}>{fmt(uCost)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-border pt-4 flex items-center justify-between">
            <p className="text-[10px] text-[var(--tone-subtle)]">Gerado pelo Sistema de Rateio TI · {today}</p>
            <p className="text-[10px] text-[var(--tone-subtle)]">Documento interno — uso confidencial</p>
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
              <button onClick={onBack} className="text-xs text-muted-foreground hover:text-foreground mb-3 flex items-center gap-1 transition-colors">← Todos os projetos</button>
              {editingName ? (
                <input autoFocus className="text-xl font-semibold tracking-tight bg-transparent border-b border-primary outline-none w-full max-w-sm" value={draft.name} onChange={(e) => update({ ...draft, name: e.target.value })} onBlur={() => setEditingName(false)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />
              ) : (
                <h1 className="text-xl font-semibold tracking-tight cursor-text hover:opacity-70 transition-opacity" onClick={() => setEditingName(true)}>{draft.name}</h1>
              )}
              {editingDesc ? (
                <input autoFocus className="text-sm text-muted-foreground bg-transparent border-b border-[var(--tone-line)] outline-none w-full max-w-md mt-1" value={draft.description} placeholder="Adicionar descrição..." onChange={(e) => update({ ...draft, description: e.target.value })} onBlur={() => setEditingDesc(false)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />
              ) : (
                <p className="text-sm text-muted-foreground mt-1 cursor-text hover:opacity-70 transition-opacity" onClick={() => setEditingDesc(true)}>
                  {draft.description || <span className="text-[var(--tone-faint)] italic">Clique para adicionar descrição...</span>}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative">
                <select value={draft.month} onChange={(e) => update({ ...draft, month: Number(e.target.value) })} className="appearance-none h-8 pl-3 pr-8 text-sm bg-card border border-border rounded-lg outline-none hover:border-[var(--border-14)] transition-all cursor-pointer">
                  {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                </select>
                <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--tone-subtle)] pointer-events-none" />
              </div>
              <span className="text-sm text-muted-foreground">{draft.year}</span>
              <button onClick={() => setExporting(true)} className="h-8 px-3 text-sm text-muted-foreground hover:text-foreground bg-card border border-border rounded-lg hover:border-[var(--border-14)] transition-all flex items-center gap-1.5">
                <ExternalLink size={13} />Exportar
              </button>
              <button onClick={save} className={`h-8 px-4 text-sm font-medium rounded-lg transition-all flex items-center gap-1.5 ${savedFlash ? "bg-emerald-500 text-white" : isDirty ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-muted text-muted-foreground"}`}>
                {savedFlash ? <><Check size={13} />Salvo</> : <><Check size={13} />Salvar</>}
              </button>
              <button onClick={onDelete} className="h-8 px-3 text-sm text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/15 border border-border rounded-lg transition-all flex items-center gap-1.5">
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {/* Requester + Dates */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4">Informações do Projeto</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Solicitante</label>
                <input value={draft.requester} onChange={(e) => update({ ...draft, requester: e.target.value })} placeholder="Nome do solicitante" className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Data de Início</label>
                <input type="date" value={draft.startDate} onChange={(e) => update({ ...draft, startDate: e.target.value })} className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Data de Término</label>
                <input type="date" value={draft.endDate} onChange={(e) => update({ ...draft, endDate: e.target.value })} className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" />
              </div>
            </div>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-card border border-border rounded-xl p-5">
              <p className="text-xs text-muted-foreground font-medium mb-1.5">Custo Total</p>
              <p className="text-xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(total)}</p>
              <p className="text-xs text-[var(--tone-subtle)] mt-1">{draft.members.filter((m) => m.days > 0).length} colaboradores</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-5">
              <p className="text-xs text-muted-foreground font-medium mb-1.5">Dias Trabalhados</p>
              <p className="text-xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{draft.members.filter((m) => m.days > 0).reduce((s, m) => s + m.days, 0)}</p>
              <p className="text-xs text-[var(--tone-subtle)] mt-1">dias no total</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-5">
              <p className="text-xs text-muted-foreground font-medium mb-1.5">Centros de Custo</p>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                {draft.costCenters.map((u) => (
                  <span key={u} className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ backgroundColor: UNIT_LIGHT[u], color: UNIT_COLORS[u] }}>{UNIT_NAMES[u]}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            {/* Cost centers */}
            <div className="bg-card border border-border rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold">Centros de Custo</h3>
              <p className="text-xs text-[var(--tone-subtle)] -mt-2">Selecione a qual unidade este projeto pertence.</p>
              <div className="space-y-2">
                {UNITS.map((u) => {
                  const active = draft.costCenters.includes(u);
                  return (
                    <div key={u} className="space-y-2">
                      <button onClick={() => toggleUnit(u)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all text-left ${active ? "border-transparent" : "border-border hover:border-[var(--border-14)]"}`} style={active ? { backgroundColor: UNIT_LIGHT[u], borderColor: UNIT_COLORS[u] + "33" } : {}}>
                        <div className="w-4 h-4 rounded flex items-center justify-center border-2 transition-all shrink-0" style={active ? { backgroundColor: UNIT_COLORS[u], borderColor: UNIT_COLORS[u] } : { borderColor: "var(--tone-line)" }}>
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
                          <input type="number" min={0} max={100} value={draft.splits[u]} onChange={(e) => update({ ...draft, splits: { ...draft.splits, [u]: Math.max(0, Math.min(100, Number(e.target.value))) } })} className="w-14 h-7 text-center text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" style={{ fontFamily: "var(--font-mono)" }} />
                          <span className="text-xs text-[var(--tone-subtle)]">%</span>
                          {splitsSum !== 100 && <span className="text-[10px] text-amber-500">soma: {splitsSum}%</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {draft.costCenters.length > 1 && (
                <button onClick={() => update({ ...draft, splits: equalSplit(draft.costCenters) })} className="text-xs text-muted-foreground hover:text-foreground transition-colors">Distribuir igualmente</button>
              )}
            </div>

            {/* Unit cost breakdown */}
            <div className="bg-card border border-border rounded-xl p-5 space-y-4">
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
                          {draft.costCenters.length > 1 && <span className="text-[10px] text-[var(--tone-subtle)]">{draft.splits[u]}%</span>}
                        </div>
                        <span className="text-sm font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)", color: UNIT_COLORS[u] }}>{fmt(uCost)}</span>
                      </div>
                      <div className="w-full h-1 bg-muted rounded-full"><div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: UNIT_COLORS[u] }} /></div>
                    </div>
                  );
                })}
              </div>
              {total === 0 && <p className="text-xs text-[var(--tone-faint)] italic pt-2">Adicione colaboradores com dias trabalhados para ver o custo.</p>}
            </div>
          </div>

          {/* Collaborators */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--border-5)] flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Equipe do Projeto</h3>
                <p className="text-xs text-[var(--tone-subtle)] mt-0.5">Selecione os colaboradores e informe os dias trabalhados</p>
              </div>
              <span className="text-xs text-[var(--tone-subtle)]">{draft.members.filter((m) => m.days > 0).length} ativos</span>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border-4)]">
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground w-8" />
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted-foreground">Colaborador</th>
                  <th className="text-right px-5 py-2.5 text-xs font-medium text-muted-foreground">Valor/Dia</th>
                  <th className="text-center px-5 py-2.5 text-xs font-medium text-muted-foreground">Dias</th>
                  <th className="text-right px-5 py-2.5 text-xs font-medium text-muted-foreground">Custo</th>
                  <th className="text-right px-5 py-2.5 text-xs font-medium text-muted-foreground">%</th>
                </tr>
              </thead>
              <tbody>
                {collaborators.map((c) => {
                  const member = draft.members.find((m) => m.collaboratorId === c.id);
                  const selected = !!member;
                  const rate = dailyRate(c.salary, workingDays);
                  const cost = selected ? member.days * rate : 0;
                  return (
                    <tr key={c.id} className={`border-b border-[var(--border-4)] last:border-0 transition-colors ${selected ? "" : "opacity-40"}`}>
                      <td className="px-5 py-3">
                        <button onClick={() => toggleMember(c.id)} className="w-4 h-4 rounded border-2 flex items-center justify-center transition-all" style={selected ? { backgroundColor: "var(--primary)", borderColor: "var(--primary)" } : { borderColor: "var(--tone-line)" }}>
                          {selected && <Check size={9} className="text-primary-foreground" strokeWidth={3} />}
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={c.name} />
                          <div><p className="text-sm font-medium leading-tight">{c.name}</p><p className="text-[11px] text-[var(--tone-subtle)] leading-tight">{c.role}</p></div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right text-xs tabular-nums text-[var(--tone-subtle)]" style={{ fontFamily: "var(--font-mono)" }}>{fmt(rate)}</td>
                      <td className="px-5 py-3 text-center">
                        {selected ? (
                          <input type="number" min={0} step={1} value={member.days} onChange={(e) => setMemberDays(c.id, Number(e.target.value))} onBlur={(e) => setMemberDays(c.id, Math.round(Number(e.target.value)))} className="w-14 h-7 text-center text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" style={{ fontFamily: "var(--font-mono)" }} />
                        ) : <span className="text-xs text-[var(--tone-line)]">—</span>}
                      </td>
                      <td className="px-5 py-3 text-right text-sm tabular-nums font-medium" style={{ fontFamily: "var(--font-mono)" }}>{selected && cost > 0 ? fmt(cost) : <span className="text-[var(--tone-line)] text-xs">—</span>}</td>
                      <td className="px-5 py-3 text-right text-xs tabular-nums text-[var(--tone-subtle)]" style={{ fontFamily: "var(--font-mono)" }}>{selected && total > 0 ? `${((cost / total) * 100).toFixed(1)}%` : <span className="text-[var(--tone-line)]">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
              {total > 0 && (
                <tfoot>
                  <tr className="bg-background border-t border-border">
                    <td colSpan={3} className="px-5 py-2.5 text-xs font-semibold text-muted-foreground">Total</td>
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
            <p className="text-xs text-muted-foreground mt-0.5">Calculadora de custos de projeto · {filterYear}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <select value={filterMonth === "all" ? "all" : filterMonth} onChange={(e) => setFilterMonth(e.target.value === "all" ? "all" : Number(e.target.value))} className="appearance-none h-8 pl-3 pr-8 text-sm bg-card border border-border rounded-lg outline-none hover:border-[var(--border-14)] transition-all cursor-pointer">
                <option value="all">Todos os meses</option>
                {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
              </select>
              <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--tone-subtle)] pointer-events-none" />
            </div>
            <button onClick={newProject} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all flex items-center gap-1.5"><Plus size={14} />Novo Projeto</button>
          </div>
        </div>

        {filtered.length > 0 && (
          <div className="flex items-center gap-6 text-xs">
            <span className="text-muted-foreground"><span className="font-medium text-foreground">{filtered.length}</span> projetos</span>
            <span className="text-muted-foreground">Custo total: <span className="font-medium text-foreground" style={{ fontFamily: "var(--font-mono)" }}>{fmt(totalCost)}</span></span>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="bg-card border border-border rounded-xl p-16 flex flex-col items-center justify-center text-center">
            <div className="w-10 h-10 bg-muted rounded-xl flex items-center justify-center mb-3"><FileSpreadsheet size={18} className="text-[var(--tone-subtle)]" /></div>
            <p className="text-sm font-medium">{projects.length === 0 ? "Nenhum projeto ainda" : "Nenhum projeto neste período"}</p>
            <p className="text-xs text-[var(--tone-subtle)] mt-1 mb-4">Crie um projeto para estimar custos por colaborador e centro de custo</p>
            <button onClick={newProject} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all">Criar projeto</button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {filtered.map((p) => {
              const cost = projectCost(p, collaborators, workingDays);
              const memberCount = p.members.filter((m) => m.days > 0).length;
              const totalDays = p.members.reduce((s, m) => s + m.days, 0);
              return (
                <button key={p.id} onClick={() => setSelectedId(p.id)} className="bg-card border border-border rounded-xl p-5 text-left hover:border-[var(--border-14)] hover:shadow-sm transition-all">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold truncate">{p.name}</p>
                        <span className="text-[10px] text-[var(--tone-subtle)] shrink-0">{MONTHS[p.month]}</span>
                      </div>
                      {p.description && <p className="text-xs text-[var(--tone-subtle)] mt-0.5 truncate">{p.description}</p>}
                      {p.requester && <p className="text-[10px] text-[var(--tone-subtle)] mt-0.5">Solicitante: {p.requester}</p>}
                    </div>
                    <div className="flex items-center gap-1 ml-2 shrink-0">
                      {p.costCenters.map((u) => <div key={u} className="w-2 h-2 rounded-full" style={{ backgroundColor: UNIT_COLORS[u] }} />)}
                    </div>
                  </div>
                  {(p.startDate || p.endDate) && (
                    <div className="flex items-center gap-1 text-[10px] text-[var(--tone-subtle)] mb-2">
                      <CalendarDays size={10} />
                      <span>{p.startDate ? fmtDate(p.startDate) : "?"} → {p.endDate ? fmtDate(p.endDate) : "?"}</span>
                    </div>
                  )}
                  <div className="flex items-end justify-between">
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-[var(--tone-subtle)]">{memberCount} colaboradores · {totalDays} dias</p>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {p.costCenters.map((u) => <span key={u} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ backgroundColor: UNIT_LIGHT[u], color: UNIT_COLORS[u] }}>{UNIT_NAMES[u]}{p.costCenters.length > 1 ? ` ${p.splits[u]}%` : ""}</span>)}
                      </div>
                    </div>
                    <p className="text-base font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                      {cost > 0 ? fmt(cost) : <span className="text-[var(--tone-line)] text-sm">—</span>}
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
  sectors: Sector[];
}

function ColaboradoresView({ collaborators, setCollaborators, workingDays, sectors }: ColaboradoresViewProps) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const totalFolha = collaborators.reduce((s, c) => s + c.salary, 0);
  const sectorName = (id?: string) => sectors.find((s) => s.id === id)?.name ?? "—";

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Colaboradores</h1>
            <p className="text-xs text-muted-foreground mt-0.5">{collaborators.length} pessoas · Folha total {fmt(totalFolha)}</p>
          </div>
          <button onClick={() => setAdding(true)} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all flex items-center gap-1.5"><Plus size={14} />Novo Colaborador</button>
        </div>
        {adding && <CollaboratorForm workingDays={workingDays} sectors={sectors} onSave={(d) => {
          const tempId = String(Date.now());
          setCollaborators((p) => [...p, { ...d, id: tempId }]);
          setAdding(false);
          apiPost("/collaborators", { ...d, id: tempId }).catch(() => {
            setCollaborators((p) => p.filter((x) => x.id !== tempId));
            alert("Não foi possível salvar o colaborador. Tente novamente.");
          });
        }} onCancel={() => setAdding(false)} />}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Nome</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Cargo</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Setor</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Aniversário</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground">Salário</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground">Valor/Dia</th>
                <th className="px-5 py-3 w-20" />
              </tr>
            </thead>
            <tbody>
              {collaborators.map((c) => (
                <>
                  <tr key={c.id} className={`border-b border-[var(--border-4)] last:border-0 group ${c.active ? "" : "opacity-50"}`}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color || "var(--tone-line)" }} title="Cor na Escala de Home Office" />
                        <Avatar name={c.name} />
                        <span className="text-sm font-medium">{c.name}</span>
                        {!c.active && <span className="text-[9px] font-medium uppercase tracking-wider text-[var(--tone-subtle)] border border-border rounded px-1 py-0.5">Inativo</span>}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{c.role}</td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{sectorName(c.sectorId)}</td>
                    <td className="px-5 py-3 text-xs text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>{c.birthDate ? fmtDate(c.birthDate) : "—"}</td>
                    <td className="px-5 py-3 text-right text-sm tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(c.salary)}</td>
                    <td className="px-5 py-3 text-right text-xs tabular-nums text-[var(--tone-subtle)]" style={{ fontFamily: "var(--font-mono)" }}>{fmt(dailyRate(c.salary, workingDays))}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                        <button onClick={() => setEditId(c.id)} className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--tone-subtle)] hover:text-foreground hover:bg-input-background transition-all"><Pencil size={12} /></button>
                        <button onClick={() => {
                          if (!confirm(`Remover ${c.name}? Isso também apaga o acesso de login vinculado, se existir.`)) return;
                          setCollaborators((p) => p.filter((x) => x.id !== c.id));
                          apiDelete(`/collaborators/${c.id}`).catch(() => { alert("Não foi possível remover. Atualize a página."); });
                        }} className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--tone-subtle)] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/15 transition-all"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                  {editId === c.id && (
                    <tr key={`edit-${c.id}`}>
                      <td colSpan={7} className="px-5 pb-3">
                        <CollaboratorForm initial={c} workingDays={workingDays} sectors={sectors} onSave={(d) => {
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

// ─── Setores View ─────────────────────────────────────────────────────────────
// Cadastro simples de setores/áreas — só o nome. O vínculo de membros é
// editado no cadastro do colaborador (campo "Setor"); aqui é só leitura,
// pra ver de relance quem está em cada setor.

interface SetoresViewProps {
  sectors: Sector[];
  setSectors: React.Dispatch<React.SetStateAction<Sector[]>>;
  collaborators: Collaborator[];
}

function SetoresView({ sectors, setSectors, collaborators }: SetoresViewProps) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const membersOf = (sector: Sector) =>
    collaborators.filter((c) => sector.memberIds.includes(c.id));

  const createSector = () => {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    setAdding(false);
    apiPost("/sectors", { name })
      .then((s) => setSectors((p) => [...p, s].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => alert(e.message));
  };

  const renameSector = (id: string) => {
    const name = editName.trim();
    if (!name) return;
    setEditId(null);
    apiPut(`/sectors/${id}`, { name })
      .then((s) => setSectors((p) => p.map((x) => (x.id === id ? s : x))))
      .catch((e) => alert(e.message));
  };

  const removeSector = (sector: Sector) => {
    if (!confirm(`Remover o setor "${sector.name}"? Os colaboradores vinculados ficam sem setor, mas não são apagados.`)) return;
    setSectors((p) => p.filter((x) => x.id !== sector.id));
    apiDelete(`/sectors/${sector.id}`).catch(() => { alert("Não foi possível remover. Atualize a página."); });
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Setores</h1>
            <p className="text-xs text-muted-foreground mt-0.5">{sectors.length} setores cadastrados</p>
          </div>
          <button onClick={() => setAdding(true)} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all flex items-center gap-1.5"><Plus size={14} />Novo Setor</button>
        </div>
        {adding && (
          <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-2">
            <input className="flex-1 h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" placeholder="Nome do setor" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createSector()} autoFocus />
            <button onClick={() => setAdding(false)} className="h-8 px-3 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-input-background transition-all">Cancelar</button>
            <button onClick={createSector} disabled={!newName.trim()} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all">Salvar</button>
          </div>
        )}
        <div className="space-y-3">
          {sectors.map((s) => {
            const members = membersOf(s);
            return (
              <div key={s.id} className="bg-card border border-border rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  {editId === s.id ? (
                    <div className="flex items-center gap-2 flex-1">
                      <input className="flex-1 h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && renameSector(s.id)} autoFocus />
                      <button onClick={() => setEditId(null)} className="h-8 px-3 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-input-background transition-all">Cancelar</button>
                      <button onClick={() => renameSector(s.id)} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all">Salvar</button>
                    </div>
                  ) : (
                    <>
                      <div>
                        <p className="text-sm font-semibold">{s.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{members.length} {members.length === 1 ? "membro" : "membros"}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditId(s.id); setEditName(s.name); }} className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--tone-subtle)] hover:text-foreground hover:bg-input-background transition-all"><Pencil size={12} /></button>
                        <button onClick={() => removeSector(s)} className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--tone-subtle)] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/15 transition-all"><Trash2 size={12} /></button>
                      </div>
                    </>
                  )}
                </div>
                {members.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {members.map((m) => (
                      <span key={m.id} className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-muted">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: m.color || "var(--tone-line)" }} />
                        {m.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {sectors.length === 0 && !adding && (
            <p className="text-sm text-muted-foreground text-center py-8">Nenhum setor cadastrado ainda.</p>
          )}
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
              <p className="text-xs text-muted-foreground">{c.role}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-card border border-border rounded-xl p-5">
              <p className="text-xs text-muted-foreground font-medium mb-1.5">Períodos Abertos</p>
              <p className="text-2xl font-semibold" style={{ fontFamily: "var(--font-mono)" }}>{openReleases.length}</p>
              <p className="text-xs text-[var(--tone-subtle)] mt-1">aguardando preenchimento</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-5">
              <p className="text-xs text-muted-foreground font-medium mb-1.5">Períodos Aprovados</p>
              <p className="text-2xl font-semibold" style={{ fontFamily: "var(--font-mono)" }}>{approvedReleases.length}</p>
              <p className="text-xs text-[var(--tone-subtle)] mt-1">este ano</p>
            </div>
          </div>
          {openReleases.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Pendente</p>
              <button onClick={() => onNav("rateio")} className="w-full bg-blue-50 dark:bg-blue-500/15 border border-blue-100 dark:border-blue-500/20 rounded-xl px-5 py-4 text-left hover:bg-blue-100/60 dark:hover:bg-blue-500/25 transition-all flex items-center justify-between">
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
          <p className="text-xs text-muted-foreground mt-1">{now.toLocaleDateString("pt-BR", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
        </div>
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Total da Folha", value: fmt(totalFolha), sub: `${collaborators.length} colaboradores` },
            { label: "Períodos Abertos", value: String(openReleases.length), sub: "aguardando preenchimento" },
            { label: "Períodos Aprovados", value: String(approvedReleases.length), sub: "este ano" },
            { label: "Projetos", value: String(projects.length), sub: "cadastrados" },
          ].map((card) => (
            <div key={card.label} className="bg-card border border-border rounded-xl p-5">
              <p className="text-xs text-muted-foreground font-medium mb-2">{card.label}</p>
              <p className="text-xl font-semibold tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{card.value}</p>
              <p className="text-xs text-[var(--tone-subtle)] mt-1">{card.sub}</p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-6">
          <div className="bg-card border border-border rounded-xl p-6">
            <h3 className="text-sm font-semibold mb-4">Distribuição Acumulada por Unidade</h3>
            {totalRateado > 0 ? (
              <div className="flex items-center gap-6">
                <div style={{ width: 160, height: 160 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius={48} outerRadius={72} dataKey="value" strokeWidth={2} stroke="var(--background)">
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
                        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} /><span className="text-xs text-muted-foreground">{d.name}</span></div>
                        <span className="text-xs font-medium tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{fmt(d.value)}</span>
                      </div>
                      <div className="w-full h-1 bg-muted rounded-full"><div className="h-full rounded-full" style={{ width: `${(d.value / totalRateado) * 100}%`, backgroundColor: d.color }} /></div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-40 text-sm text-[var(--tone-subtle)]">Nenhum rateio lançado ainda</div>
            )}
          </div>
          <div className="bg-card border border-border rounded-xl p-6">
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
                    <span className="text-xs text-[var(--tone-subtle)]">{done}/{r.entries.length} completos</span>
                  </div>
                );
              })}
              {releases.length === 0 && <p className="text-sm text-[var(--tone-subtle)]">Nenhum período liberado ainda</p>}
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
        <div><h1 className="text-xl font-semibold tracking-tight">Configurações</h1><p className="text-xs text-muted-foreground mt-0.5">Parâmetros globais do sistema</p></div>
        <div className="bg-card border border-border rounded-xl divide-y divide-[rgba(0,0,0,0.05)]">
          <div className="px-5 py-4 flex items-center justify-between">
            <div><p className="text-sm font-medium">Dias Úteis Padrão</p><p className="text-xs text-[var(--tone-subtle)] mt-0.5">Referência para cálculo do valor diário dos colaboradores</p></div>
            <input type="number" value={workingDays} onChange={(e) => setWorkingDays(Math.max(1, Number(e.target.value)))} className="w-16 h-8 text-center text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" style={{ fontFamily: "var(--font-mono)" }} min={1} max={31} />
          </div>
          <div className="px-5 py-4 flex items-center justify-between">
            <div><p className="text-sm font-medium">Centros de Custo</p><p className="text-xs text-[var(--tone-subtle)] mt-0.5">Wolf Consórcios · Fraga & Bitello · Woncred · Profit</p></div>
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
  mustChangePassword: boolean;
}

// ─── Modo noturno ───────────────────────────────────────────────────────────
// Preferência salva por usuário (chave inclui o id) — cada login "lembra" o
// próprio ajuste. Antes do login (ou sem usuário identificado ainda), usa uma
// preferência "convidado" à parte.

const NIGHT_MODE_KEY_PREFIX = "rateio_night_mode_";

function nightModeKey(userId: number | null): string {
  return `${NIGHT_MODE_KEY_PREFIX}${userId ?? "guest"}`;
}

function readStoredNightMode(userId: number | null): boolean {
  try {
    const stored = localStorage.getItem(nightModeKey(userId));
    if (stored === "dark") return true;
    if (stored === "light") return false;
  } catch {
    // localStorage indisponível (modo privado, etc.) — cai no padrão abaixo.
  }
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function writeStoredNightMode(userId: number | null, dark: boolean) {
  try {
    localStorage.setItem(nightModeKey(userId), dark ? "dark" : "light");
  } catch {
    // sem persistência disponível — a preferência só vale pra sessão atual.
  }
}

// Aplica/lê a preferência de modo noturno do usuário atual (ou "convidado",
// nas telas de login/setup) e mantém a classe "dark" no <html> sincronizada.
function useNightMode(userId: number | null): [boolean, () => void] {
  const [dark, setDark] = useState(() => readStoredNightMode(userId));

  useEffect(() => {
    setDark(readStoredNightMode(userId));
  }, [userId]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const toggle = useCallback(() => {
    setDark((prev) => {
      const next = !prev;
      writeStoredNightMode(userId, next);
      return next;
    });
  }, [userId]);

  return [dark, toggle];
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background" style={{ fontFamily: "var(--font-family)" }}>
      <div className="w-full max-w-sm bg-card border border-border rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-[#18181b] rounded-md flex items-center justify-center"><Zap size={14} className="text-white" /></div>
          <span className="text-sm font-semibold tracking-tight">Rateio TI</span>
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

// Formulário de troca de senha em si — reaproveitado tanto na tela obrigatória
// de primeiro login quanto no modal voluntário (Sidebar → "Alterar senha").
function ChangePasswordForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = () => {
    setError("");
    if (!oldPassword) { setError("Informe a senha atual"); return; }
    if (newPassword.length < 6) { setError("A nova senha deve ter ao menos 6 caracteres"); return; }
    if (newPassword !== confirm) { setError("As senhas não coincidem"); return; }
    setLoading(true);
    apiPut("/auth/password", { oldPassword, newPassword })
      .then(() => onDone())
      .catch((e: Error) => { setError(e.message || "Não foi possível trocar a senha"); setLoading(false); });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">Senha atual</label>
        <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" autoFocus />
      </div>
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">Nova senha</label>
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" />
      </div>
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">Confirmar nova senha</label>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" />
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex items-center gap-2 pt-1">
        {onCancel && (
          <button onClick={onCancel} className="flex-1 h-9 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-input-background transition-all">Cancelar</button>
        )}
        <button onClick={submit} disabled={loading} className="flex-1 h-9 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-all">
          {loading ? "Salvando…" : "Salvar nova senha"}
        </button>
      </div>
    </div>
  );
}

// Tela obrigatória de primeiro login — aparece uma única vez (enquanto
// users.must_change_password estiver ligado) sempre que o acesso foi criado ou
// redefinido pelo admin, já que nesses casos a senha é sempre o padrão wolf360.
function ForcePasswordChange({ onDone }: { onDone: () => void }) {
  return (
    <AuthShell title="Troque sua senha" subtitle="Este é seu primeiro acesso (ou sua senha foi redefinida). Informe a senha padrão como senha atual e escolha uma nova antes de continuar.">
      <ChangePasswordForm onDone={onDone} />
    </AuthShell>
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
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Usuário</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" autoFocus />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Senha</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Confirmar senha</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" />
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button onClick={submit} disabled={loading} className="w-full h-9 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-all">{loading ? "Criando…" : "Criar administrador"}</button>
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
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Usuário</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" autoFocus />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Senha</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="w-full h-9 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary focus:bg-card transition-all" />
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button onClick={submit} disabled={loading} className="w-full h-9 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-all">{loading ? "Entrando…" : "Entrar"}</button>
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
  mustChangePassword: boolean;
  collaboratorId: string | null;
  collaboratorName: string | null;
}

// A senha nunca é escolhida pelo admin: todo acesso nasce (ou é redefinido)
// com a senha padrão e a pessoa é obrigada a trocá-la no próximo login (ver
// server/src/auth.js DEFAULT_PASSWORD e ForcePasswordChange).
const DEFAULT_PASSWORD_HINT = "wolf360";

function AcessosView({ collaborators, currentUserId }: AcessosViewProps) {
  const [users, setUsers] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState<UserRole>("collaborator");
  const [newUsername, setNewUsername] = useState("");
  const [newCollaboratorId, setNewCollaboratorId] = useState("");
  const [error, setError] = useState("");
  const [resettingId, setResettingId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    apiGet("/users").then((u) => { setUsers(u); setLoading(false); }).catch(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const withoutLogin = collaborators.filter((c) => !users.some((u) => u.collaboratorId === c.id));

  const createAccess = () => {
    setError("");
    if (!newUsername.trim()) { setError("Informe o usuário"); return; }
    if (newType === "collaborator" && !newCollaboratorId) { setError("Selecione o colaborador"); return; }
    apiPost("/users", {
      username: newUsername.trim(),
      role: newType,
      collaboratorId: newType === "collaborator" ? newCollaboratorId : undefined,
    })
      .then(() => { setCreating(false); setNewUsername(""); setNewCollaboratorId(""); load(); })
      .catch((e: Error) => setError(e.message || "Não foi possível criar o acesso"));
  };

  const removeAccess = (id: number) => {
    if (!confirm("Remover este acesso?")) return;
    apiDelete(`/users/${id}`).then(load).catch((e: Error) => alert(e.message || "Não foi possível remover"));
  };

  const resetToDefault = (id: number) => {
    if (!confirm(`Redefinir a senha para o padrão (${DEFAULT_PASSWORD_HINT})? A pessoa será obrigada a trocá-la no próximo login.`)) return;
    setResettingId(id);
    apiPost(`/users/${id}/reset-password`, {})
      .then(load)
      .catch((e: Error) => alert(e.message || "Não foi possível redefinir a senha"))
      .finally(() => setResettingId(null));
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Acessos</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Contas de login para administradores e colaboradores</p>
          </div>
          <button onClick={() => setCreating(true)} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all flex items-center gap-1.5"><Plus size={14} />Novo Acesso</button>
        </div>

        {creating && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold">Novo Acesso</h3>
            <div className="flex rounded-lg bg-input-background p-0.5 w-fit">
              <button onClick={() => setNewType("collaborator")} className={`px-3 h-7 rounded-md text-xs font-medium transition-all ${newType === "collaborator" ? "bg-card shadow-sm text-foreground" : "text-[var(--tone-subtle)]"}`}>Colaborador</button>
              <button onClick={() => setNewType("admin")} className={`px-3 h-7 rounded-md text-xs font-medium transition-all ${newType === "admin" ? "bg-card shadow-sm text-foreground" : "text-[var(--tone-subtle)]"}`}>Administrador</button>
            </div>
            {newType === "collaborator" && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Colaborador</label>
                <select value={newCollaboratorId} onChange={(e) => setNewCollaboratorId(e.target.value)} className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none">
                  <option value="">Selecione…</option>
                  {withoutLogin.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {withoutLogin.length === 0 && <p className="text-[11px] text-[var(--tone-subtle)] mt-1">Todos os colaboradores já possuem acesso, ou nenhum colaborador foi cadastrado ainda.</p>}
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Usuário</label>
              <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="w-full h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none" placeholder="ex: joao.silva" />
            </div>
            <p className="text-[11px] text-[var(--tone-subtle)]">A senha inicial é sempre <strong className="text-muted-foreground">{DEFAULT_PASSWORD_HINT}</strong> — a pessoa será obrigada a trocá-la no primeiro login.</p>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => { setCreating(false); setError(""); }} className="h-8 px-4 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-input-background transition-all">Cancelar</button>
              <button onClick={createAccess} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all">Criar acesso</button>
            </div>
          </div>
        )}

        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Usuário</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Tipo</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Colaborador vinculado</th>
                <th className="px-5 py-3 w-48" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-[var(--border-4)] last:border-0">
                  <td className="px-5 py-3 text-sm font-medium">
                    {u.username}
                    {u.mustChangePassword && (
                      <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-500/15 text-amber-600 align-middle">senha padrão</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-sm text-muted-foreground">{u.role === "admin" ? "Administrador" : "Colaborador"}</td>
                  <td className="px-5 py-3 text-sm text-muted-foreground">{u.collaboratorName || "—"}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => resetToDefault(u.id)} disabled={resettingId === u.id} className="h-6 px-2 text-[11px] rounded-md text-muted-foreground hover:text-foreground hover:bg-input-background disabled:opacity-50 transition-all">
                        {resettingId === u.id ? "Redefinindo…" : "Redefinir senha"}
                      </button>
                      {u.id !== currentUserId && (
                        <button onClick={() => removeAccess(u.id)} className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--tone-subtle)] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/15 transition-all"><Trash2 size={12} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && users.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-[var(--tone-subtle)]">Nenhum acesso cadastrado</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Main App (autenticado) ───────────────────────────────────────────────────

function MainApp({ user, onLogout, nightMode, onToggleNightMode }: { user: AuthUser; onLogout: () => void; nightMode: boolean; onToggleNightMode: () => void }) {
  const now = new Date();
  // Contas sem colaborador vinculado existem só para o rateio diário pessoal —
  // já abrem direto nessa tela em vez do Dashboard, que não tem nada pra mostrar.
  const [view, setView] = useState<View>(user.role === "collaborator" && !user.collaboratorId ? "diario" : "dashboard");
  const role = user.role;
  const currentCollaboratorId = user.collaboratorId ?? "";

  const [workingDays, setWorkingDaysRaw] = useState(22);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [releases, setReleases] = useState<RateioRelease[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [showChangePassword, setShowChangePassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingData(true);
    Promise.all([
      apiGet("/collaborators"),
      apiGet("/releases"),
      apiGet("/settings"),
      apiGet("/sectors"),
      role === "admin" ? apiGet("/projects") : Promise.resolve([]),
    ])
      .then(([cs, rs, settings, secs, ps]) => {
        if (cancelled) return;
        setCollaborators(cs);
        setReleases(rs);
        setWorkingDaysRaw(settings?.workingDays ?? 22);
        setSectors(secs);
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
    return <div className="flex h-screen items-center justify-center bg-background text-sm text-[var(--tone-subtle)]">Carregando…</div>;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background" style={{ fontFamily: "var(--font-family)" }}>
      <Sidebar
        active={view}
        onNav={handleNav}
        role={role}
        displayName={role === "admin" ? user.username : (currentCollaborator?.name ?? user.username)}
        displaySubtitle={role === "admin" ? "Administrador" : (currentCollaborator?.role ?? "Colaborador")}
        onLogout={onLogout}
        onChangePassword={() => setShowChangePassword(true)}
        nightMode={nightMode}
        onToggleNightMode={onToggleNightMode}
      />

      {showChangePassword && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-8">
          <div className="w-full max-w-sm bg-card rounded-2xl shadow-2xl p-6 space-y-4">
            <div>
              <h3 className="text-sm font-semibold">Alterar senha</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Informe sua senha atual e escolha uma nova.</p>
            </div>
            <ChangePasswordForm
              onCancel={() => setShowChangePassword(false)}
              onDone={() => setShowChangePassword(false)}
            />
          </div>
        </div>
      )}

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
        <DailyRateio
          displayName={role === "admin" ? user.username : (currentCollaborator?.name ?? user.username)}
          birthDate={currentCollaborator?.birthDate}
        />
      )}

      {view === "homeoffice" && (
        <HomeOffice
          sectors={sectors}
          role={role}
          currentCollaboratorId={currentCollaboratorId}
        />
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
          sectors={sectors}
        />
      )}

      {view === "setores" && role === "admin" && (
        <SetoresView sectors={sectors} setSectors={setSectors} collaborators={collaborators} />
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
  const [nightMode, toggleNightMode] = useNightMode(user?.id ?? null);

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
    return <div className="flex h-screen items-center justify-center bg-background text-sm text-[var(--tone-subtle)]">Carregando…</div>;
  }
  if (status === "needsSetup") return <Setup onDone={loadStatus} />;
  if (status === "needsLogin" || !user) return <Login onDone={loadStatus} />;
  if (user.mustChangePassword) return <ForcePasswordChange onDone={loadStatus} />;

  return <MainApp user={user} onLogout={handleLogout} nightMode={nightMode} onToggleNightMode={toggleNightMode} />;
}
