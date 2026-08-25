import { useState, useEffect, useMemo } from "react";
import { apiGet, apiPost, apiPatch, apiDelete } from "./api";
import { Laptop2, Lock, Unlock, ChevronDown, ChevronUp, Plus, Trash2, AlertCircle, Users as UsersIcon } from "lucide-react";
import { Collaborator, Sector, Avatar, fmtDate, MONTHS } from "./App";
import { weeklyQuotaForDate, isoWeekKey, sectorMaxHO } from "./homeOfficeRules";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface HOEntry {
  collaboratorId: string;
  dates: string[];
}

interface HOSpecialDay {
  id: number;
  collaboratorId: string;
  date: string;
  type: "ferias" | "dayoff";
}

interface HOMeeting {
  id: number;
  date: string;
  title: string;
}

interface HOPeriod {
  id: string;
  month: number; // 0-indexado, igual releases.month
  year: number;
  status: "open" | "approved";
  deadline: string;
  approvedAt?: string;
  businessDays: string[];
  generalMeetings: HOMeeting[];
  entries: HOEntry[];
  specialDays: HOSpecialDay[];
}

interface HomeOfficeProps {
  collaborators: Collaborator[];
  sectors: Sector[];
  role: "admin" | "collaborator";
  currentCollaboratorId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekdayAbbrev(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][dt.getDay()];
}

function dayNum(iso: string): string {
  return iso.split("-")[2];
}

// "AAAA-Www" -> { year, week } pra comparar semanas consecutivas.
function parseWeekKey(key: string): { year: number; week: number } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), week: Number(m[2]) };
}

function hasThreeConsecutiveWeeks(weekKeys: string[]): boolean {
  const parsed = [...new Set(weekKeys)]
    .map(parseWeekKey)
    .filter((w): w is { year: number; week: number } => !!w)
    .sort((a, b) => a.year - b.year || a.week - b.week);
  let streak = 1;
  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1];
    const cur = parsed[i];
    const consecutive = cur.year === prev.year ? cur.week === prev.week + 1 : cur.week === 1;
    streak = consecutive ? streak + 1 : 1;
    if (streak >= 3) return true;
  }
  return false;
}

// Avisos leves (nunca bloqueiam) sobre os dias de HO já marcados por alguém.
function computeWarnings(businessDays: string[], dates: string[]): string[] {
  if (dates.length < 2) return [];
  const warnings: string[] = [];
  const sorted = [...dates].sort();

  const dayIndex = new Map(businessDays.map((d, i) => [d, i]));
  for (let i = 0; i < sorted.length - 1; i++) {
    const idx = dayIndex.get(sorted[i]);
    const nextIdx = dayIndex.get(sorted[i + 1]);
    if (idx != null && nextIdx != null && nextIdx === idx + 1) {
      warnings.push("Dias consecutivos de home office nesta semana");
      break;
    }
  }

  const byWeekday = new Map<number, string[]>();
  for (const d of sorted) {
    const [y, m, day] = d.split("-").map(Number);
    const weekday = new Date(y, m - 1, day).getDay();
    if (!byWeekday.has(weekday)) byWeekday.set(weekday, []);
    byWeekday.get(weekday)!.push(isoWeekKey(d));
  }
  for (const weekKeys of byWeekday.values()) {
    if (hasThreeConsecutiveWeeks(weekKeys)) {
      warnings.push("Sempre no mesmo dia da semana, várias semanas seguidas");
      break;
    }
  }
  return warnings;
}

// ─── Célula do grid ───────────────────────────────────────────────────────────

interface HOCellProps {
  collaborator: Collaborator;
  date: string;
  on: boolean;
  special?: "ferias" | "dayoff";
  isMeeting: boolean;
  canToggle: boolean;
  pending: boolean;
  onToggle: () => void;
}

function HOCell({ collaborator, date, on, special, isMeeting, canToggle, pending, onToggle }: HOCellProps) {
  if (special) {
    return (
      <td className="p-1">
        <div
          className={`h-8 rounded-md flex items-center justify-center text-[9px] font-semibold uppercase tracking-wide ${
            special === "ferias" ? "bg-[var(--accent-amber-bg)] text-amber-600" : "bg-[var(--accent-pink-bg)] text-pink-600"
          }`}
          title={special === "ferias" ? "Férias" : "Day off"}
        >
          {special === "ferias" ? "Férias" : "Off"}
        </div>
      </td>
    );
  }
  if (isMeeting) {
    return (
      <td className="p-1">
        <div className="h-8 rounded-md flex items-center justify-center bg-muted text-[var(--tone-subtle)] cursor-not-allowed" title="Reunião Geral — sem home office">
          <UsersIcon size={12} />
        </div>
      </td>
    );
  }
  return (
    <td className="p-1">
      <button
        onClick={canToggle ? onToggle : undefined}
        disabled={!canToggle || pending}
        title={on ? `${collaborator.name} — Home Office` : canToggle ? "Marcar Home Office" : undefined}
        className={`w-full h-8 rounded-md border transition-all flex items-center justify-center ${
          canToggle ? "cursor-pointer" : "cursor-default"
        } ${on ? "border-transparent" : "border-dashed border-border hover:border-primary/40"} ${pending ? "opacity-50" : ""}`}
        style={on ? { backgroundColor: collaborator.color || "var(--tone-subtle)" } : undefined}
      >
        {on && <Laptop2 size={12} className="text-white" />}
      </button>
    </td>
  );
}

// ─── Painel da Supervisão ─────────────────────────────────────────────────────

interface HOSupervisorPanelProps {
  period: HOPeriod | null;
  collaborators: Collaborator[];
  sectors: Sector[];
  onOpenPeriod: (month: number, year: number, deadline: string) => void;
  onPatchPeriod: (patch: { deadline?: string; status?: "open" | "approved" }) => void;
  onAddMeeting: (date: string, title: string) => void;
  onRemoveMeeting: (id: number) => void;
  onAddSpecialDay: (collaboratorId: string, date: string, type: "ferias" | "dayoff") => void;
  onRemoveSpecialDay: (id: number) => void;
}

function HOSupervisorPanel({
  period,
  collaborators,
  sectors,
  onOpenPeriod,
  onPatchPeriod,
  onAddMeeting,
  onRemoveMeeting,
  onAddSpecialDay,
  onRemoveSpecialDay,
}: HOSupervisorPanelProps) {
  const [open, setOpen] = useState(!period);
  const now = new Date();
  const [newMonth, setNewMonth] = useState(now.getMonth());
  const [newYear, setNewYear] = useState(now.getFullYear());
  const [newDeadline, setNewDeadline] = useState("");
  const [deadlineDraft, setDeadlineDraft] = useState(period?.deadline ?? "");
  const [meetingDate, setMeetingDate] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [specialCollaboratorId, setSpecialCollaboratorId] = useState("");
  const [specialDate, setSpecialDate] = useState("");
  const [specialType, setSpecialType] = useState<"ferias" | "dayoff">("ferias");

  useEffect(() => setDeadlineDraft(period?.deadline ?? ""), [period?.id, period?.deadline]);

  const collaboratorName = (id: string) => collaborators.find((c) => c.id === id)?.name ?? "—";

  const activeBySector = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of collaborators) {
      if (!c.active || !c.sectorId) continue;
      map.set(c.sectorId, (map.get(c.sectorId) ?? 0) + 1);
    }
    return map;
  }, [collaborators]);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-5 py-3 text-left">
        <span className="text-sm font-semibold flex items-center gap-2">
          Painel da Supervisão
          {period && (
            <span className={`text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full ${period.status === "open" ? "bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
              {period.status === "open" ? "Aberta" : "Aprovada"}
            </span>
          )}
        </span>
        {open ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-5 border-t border-border pt-4">
          {!period ? (
            <div>
              <p className="text-xs text-muted-foreground mb-3">Nenhuma escala aberta. Libere um mês pra começar.</p>
              <div className="flex items-end gap-2">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Mês</label>
                  <select className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={newMonth} onChange={(e) => setNewMonth(Number(e.target.value))}>
                    {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Ano</label>
                  <input type="number" className="h-8 w-24 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={newYear} onChange={(e) => setNewYear(Number(e.target.value))} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Preencher até</label>
                  <input type="date" className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={newDeadline} onChange={(e) => setNewDeadline(e.target.value)} />
                </div>
                <button onClick={() => onOpenPeriod(newMonth, newYear, newDeadline)} className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all flex items-center gap-1.5">
                  <Unlock size={13} />Liberar escala
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-end gap-2">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Preencher até</label>
                  <input type="date" className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={deadlineDraft} onChange={(e) => setDeadlineDraft(e.target.value)} disabled={period.status !== "open"} />
                </div>
                {period.status === "open" && deadlineDraft !== period.deadline && (
                  <button onClick={() => onPatchPeriod({ deadline: deadlineDraft })} className="h-8 px-3 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-input-background transition-all">Salvar prazo</button>
                )}
                <div className="flex-1" />
                {period.status === "open" ? (
                  <button
                    onClick={() => confirm("Aprovar e fechar a escala? Ninguém mais poderá marcar ou desmarcar dias depois disso.") && onPatchPeriod({ status: "approved" })}
                    className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all flex items-center gap-1.5"
                  >
                    <Lock size={13} />Aprovar escala
                  </button>
                ) : (
                  <button onClick={() => onPatchPeriod({ status: "open" })} className="h-8 px-4 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-input-background transition-all flex items-center gap-1.5">
                    <Unlock size={13} />Reabrir
                  </button>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Reunião Geral (bloqueia HO pra empresa inteira no dia)</p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {period.generalMeetings.map((m) => (
                    <span key={m.id} className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-muted">
                      {fmtDate(m.date)}{m.title ? ` — ${m.title}` : ""}
                      {period.status === "open" && (
                        <button onClick={() => onRemoveMeeting(m.id)} className="text-[var(--tone-subtle)] hover:text-red-500"><Trash2 size={10} /></button>
                      )}
                    </span>
                  ))}
                  {period.generalMeetings.length === 0 && <span className="text-xs text-[var(--tone-subtle)]">Nenhuma marcada</span>}
                </div>
                {period.status === "open" && (
                  <div className="flex items-center gap-2">
                    <input type="date" className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} />
                    <input className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary flex-1" placeholder="Título (opcional)" value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} />
                    <button
                      onClick={() => { if (meetingDate) { onAddMeeting(meetingDate, meetingTitle); setMeetingDate(""); setMeetingTitle(""); } }}
                      disabled={!meetingDate}
                      className="h-8 px-3 text-sm font-medium bg-muted rounded-lg hover:bg-input-background disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
                    >
                      <Plus size={13} />Adicionar
                    </button>
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Férias / Day off</p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {period.specialDays.map((s) => (
                    <span key={s.id} className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-muted">
                      {collaboratorName(s.collaboratorId)} — {fmtDate(s.date)} ({s.type === "ferias" ? "Férias" : "Day off"})
                      {period.status === "open" && (
                        <button onClick={() => onRemoveSpecialDay(s.id)} className="text-[var(--tone-subtle)] hover:text-red-500"><Trash2 size={10} /></button>
                      )}
                    </span>
                  ))}
                  {period.specialDays.length === 0 && <span className="text-xs text-[var(--tone-subtle)]">Nenhum registrado</span>}
                </div>
                {period.status === "open" && (
                  <div className="flex items-center gap-2">
                    <select className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={specialCollaboratorId} onChange={(e) => setSpecialCollaboratorId(e.target.value)}>
                      <option value="">Colaborador…</option>
                      {collaborators.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <input type="date" className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={specialDate} onChange={(e) => setSpecialDate(e.target.value)} />
                    <select className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={specialType} onChange={(e) => setSpecialType(e.target.value as "ferias" | "dayoff")}>
                      <option value="ferias">Férias</option>
                      <option value="dayoff">Day off</option>
                    </select>
                    <button
                      onClick={() => { if (specialCollaboratorId && specialDate) { onAddSpecialDay(specialCollaboratorId, specialDate, specialType); setSpecialDate(""); } }}
                      disabled={!specialCollaboratorId || !specialDate}
                      className="h-8 px-3 text-sm font-medium bg-muted rounded-lg hover:bg-input-background disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
                    >
                      <Plus size={13} />Adicionar
                    </button>
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Uso por setor</p>
                <div className="grid grid-cols-3 gap-2">
                  {sectors.map((s) => (
                    <div key={s.id} className="bg-background border border-border rounded-lg p-3">
                      <p className="text-xs font-medium">{s.name}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {activeBySector.get(s.id) ?? 0} ativos · vagas/dia: {sectorMaxHO(activeBySector.get(s.id) ?? 0)}
                      </p>
                    </div>
                  ))}
                  {sectors.length === 0 && <span className="text-xs text-[var(--tone-subtle)]">Nenhum setor cadastrado</span>}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function HomeOffice({ collaborators, sectors, role, currentCollaboratorId }: HomeOfficeProps) {
  const [period, setPeriod] = useState<HOPeriod | null>(null);
  const [loading, setLoading] = useState(true);
  const [weekView, setWeekView] = useState(false);
  const [sectorFilter, setSectorFilter] = useState("all");
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet("/home-office/current")
      .then((p) => { if (!cancelled) setPeriod(p); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const today = todayISO();
  const thisWeekKey = isoWeekKey(today);

  const visibleDays = useMemo(() => {
    if (!period) return [];
    return weekView ? period.businessDays.filter((d) => isoWeekKey(d) === thisWeekKey) : period.businessDays;
  }, [period, weekView, thisWeekKey]);

  const entriesByCollaborator = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of period?.entries ?? []) map.set(e.collaboratorId, new Set(e.dates));
    return map;
  }, [period]);

  const specialByKey = useMemo(() => {
    const map = new Map<string, "ferias" | "dayoff">();
    for (const s of period?.specialDays ?? []) map.set(`${s.collaboratorId}|${s.date}`, s.type);
    return map;
  }, [period]);

  const meetingDates = useMemo(() => new Set((period?.generalMeetings ?? []).map((m) => m.date)), [period]);

  const activeMembersBySector = useMemo(() => {
    const map = new Map<string, Collaborator[]>();
    for (const c of collaborators) {
      if (!c.active || !c.sectorId) continue;
      if (!map.has(c.sectorId)) map.set(c.sectorId, []);
      map.get(c.sectorId)!.push(c);
    }
    return map;
  }, [collaborators]);

  // Quantas pessoas (ativas) de cada setor já estão de HO em cada data — usado
  // só pro preview de vagas antes do clique (a checagem de verdade é no servidor).
  const sectorUsageByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of collaborators) {
      if (!c.active || !c.sectorId) continue;
      const dates = entriesByCollaborator.get(c.id);
      if (!dates) continue;
      for (const d of dates) {
        const key = `${c.sectorId}|${d}`;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
    }
    return map;
  }, [collaborators, entriesByCollaborator]);

  const visibleCollaborators = useMemo(() => {
    return collaborators
      .filter((c) => c.active)
      .filter((c) => sectorFilter === "all" || c.sectorId === sectorFilter)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [collaborators, sectorFilter]);

  const sectorName = (id?: string) => sectors.find((s) => s.id === id)?.name ?? "Sem setor";

  function refreshPeriod(next: HOPeriod) {
    setPeriod(next);
  }

  async function toggleCell(collaborator: Collaborator, date: string, currentlyOn: boolean) {
    if (!period) return;
    const key = `${collaborator.id}|${date}`;
    if (pendingCells.has(key)) return;
    setPendingCells((p) => new Set(p).add(key));

    const prevPeriod = period;
    setPeriod((p) => {
      if (!p) return p;
      const entries = p.entries.map((e) => ({ ...e, dates: [...e.dates] }));
      let entry = entries.find((e) => e.collaboratorId === collaborator.id);
      if (!entry) {
        entry = { collaboratorId: collaborator.id, dates: [] };
        entries.push(entry);
      }
      entry.dates = currentlyOn ? entry.dates.filter((d) => d !== date) : [...entry.dates, date];
      return { ...p, entries };
    });

    try {
      if (currentlyOn) {
        await apiDelete(`/home-office/periods/${period.id}/entries/${collaborator.id}/${date}`);
      } else {
        await apiPost(`/home-office/periods/${period.id}/entries`, { collaboratorId: collaborator.id, date });
      }
    } catch (e) {
      setPeriod(prevPeriod);
      alert((e as Error).message);
    } finally {
      setPendingCells((p) => { const n = new Set(p); n.delete(key); return n; });
    }
  }

  function openPeriod(month: number, year: number, deadline: string) {
    apiPost("/home-office/periods", { month, year, deadline }).then(refreshPeriod).catch((e) => alert(e.message));
  }

  function patchPeriod(patch: { deadline?: string; status?: "open" | "approved" }) {
    if (!period) return;
    apiPatch(`/home-office/periods/${period.id}`, patch).then(refreshPeriod).catch((e) => alert(e.message));
  }

  function addMeeting(date: string, title: string) {
    if (!period) return;
    apiPost(`/home-office/periods/${period.id}/meetings`, { date, title })
      .then((res: { affectedCollaboratorIds: string[] }) => {
        if (res.affectedCollaboratorIds?.length) {
          const names = res.affectedCollaboratorIds
            .map((id) => collaborators.find((c) => c.id === id)?.name ?? id)
            .join(", ");
          alert(`Home office removido nesse dia para: ${names}`);
        }
        return apiGet(`/home-office/periods/${period.id}`).then(refreshPeriod);
      })
      .catch((e) => alert(e.message));
  }

  function removeMeeting(id: number) {
    if (!period) return;
    apiDelete(`/home-office/meetings/${id}`)
      .then(() => apiGet(`/home-office/periods/${period.id}`).then(refreshPeriod))
      .catch((e) => alert(e.message));
  }

  function addSpecialDay(collaboratorId: string, date: string, type: "ferias" | "dayoff") {
    if (!period) return;
    apiPost(`/home-office/periods/${period.id}/special-days`, { collaboratorId, date, type })
      .then(() => apiGet(`/home-office/periods/${period.id}`).then(refreshPeriod))
      .catch((e) => alert(e.message));
  }

  function removeSpecialDay(id: number) {
    if (!period) return;
    apiDelete(`/home-office/special-days/${id}`)
      .then(() => apiGet(`/home-office/periods/${period.id}`).then(refreshPeriod))
      .catch((e) => alert(e.message));
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-sm text-[var(--tone-subtle)]">Carregando…</div>;
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Home Office</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {period ? `${MONTHS[period.month]} ${period.year}${period.deadline ? ` · preencher até ${fmtDate(period.deadline)}` : ""}` : "Nenhuma escala aberta"}
            </p>
          </div>
          {period && (
            <div className="flex items-center gap-2">
              <select className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}>
                <option value="all">Todos os setores</option>
                {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <div className="flex items-center bg-muted rounded-lg p-0.5">
                <button onClick={() => setWeekView(false)} className={`h-7 px-3 text-xs font-medium rounded-md transition-all ${!weekView ? "bg-card shadow-sm" : "text-muted-foreground"}`}>Mês</button>
                <button onClick={() => setWeekView(true)} className={`h-7 px-3 text-xs font-medium rounded-md transition-all ${weekView ? "bg-card shadow-sm" : "text-muted-foreground"}`}>Semana atual</button>
              </div>
            </div>
          )}
        </div>

        {role === "admin" && (
          <HOSupervisorPanel
            period={period}
            collaborators={collaborators}
            sectors={sectors}
            onOpenPeriod={openPeriod}
            onPatchPeriod={patchPeriod}
            onAddMeeting={addMeeting}
            onRemoveMeeting={removeMeeting}
            onAddSpecialDay={addSpecialDay}
            onRemoveSpecialDay={removeSpecialDay}
          />
        )}

        {!period && role !== "admin" && (
          <p className="text-sm text-muted-foreground">Nenhuma escala de Home Office está aberta no momento.</p>
        )}

        {period && (
          <div className="flex gap-6 items-start">
            <div className="flex-1 min-w-0 bg-card border border-border rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="border-collapse">
                  <thead>
                    <tr>
                      <th className="sticky left-0 bg-card text-left px-3 py-2 text-xs font-medium text-muted-foreground z-10 min-w-[180px]">Colaborador</th>
                      {visibleDays.map((d) => (
                        <th key={d} className={`px-1 py-2 text-center text-[10px] font-medium min-w-[44px] ${d === today ? "text-primary" : "text-muted-foreground"} ${meetingDates.has(d) ? "bg-muted" : ""}`}>
                          <div>{weekdayAbbrev(d)}</div>
                          <div style={{ fontFamily: "var(--font-mono)" }}>{dayNum(d)}</div>
                        </th>
                      ))}
                    </tr>
                    {sectorFilter !== "all" && (
                      <tr>
                        <th className="sticky left-0 bg-card text-left px-3 pb-2 text-[10px] font-normal text-[var(--tone-subtle)] z-10">Vagas de HO no setor</th>
                        {visibleDays.map((d) => {
                          const activeCount = activeMembersBySector.get(sectorFilter)?.length ?? 0;
                          const max = sectorMaxHO(activeCount);
                          const used = sectorUsageByDate.get(`${sectorFilter}|${d}`) ?? 0;
                          const full = used >= max;
                          return (
                            <th key={d} className={`px-1 pb-2 text-center text-[10px] font-normal tabular-nums ${full ? "text-red-500" : "text-[var(--tone-subtle)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                              {used}/{max}
                            </th>
                          );
                        })}
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {visibleCollaborators.map((c) => {
                      const dates = entriesByCollaborator.get(c.id) ?? new Set<string>();
                      const canToggle = period.status === "open" && (role === "admin" || c.id === currentCollaboratorId);
                      const quota = weeklyQuotaForDate(c.hireDate, today);
                      const usedThisWeek = [...dates].filter((d) => isoWeekKey(d) === thisWeekKey).length;
                      const warnings = computeWarnings(period.businessDays, [...dates]);
                      return (
                        <tr key={c.id} className="border-t border-[var(--border-4)]">
                          <td className="sticky left-0 bg-card px-3 py-2 z-10">
                            <div className="flex items-center gap-2">
                              <Avatar name={c.name} size={6} />
                              <div className="min-w-0">
                                <p className="text-xs font-medium truncate flex items-center gap-1">
                                  {c.name}
                                  {warnings.length > 0 && <AlertCircle size={11} className="text-amber-500 shrink-0" title={warnings.join(" · ")} />}
                                </p>
                                <p className="text-[10px] text-[var(--tone-subtle)] truncate">{sectorName(c.sectorId)} · {usedThisWeek}/{quota} esta semana</p>
                              </div>
                            </div>
                          </td>
                          {visibleDays.map((d) => (
                            <HOCell
                              key={d}
                              collaborator={c}
                              date={d}
                              on={dates.has(d)}
                              special={specialByKey.get(`${c.id}|${d}`)}
                              isMeeting={meetingDates.has(d)}
                              canToggle={canToggle}
                              pending={pendingCells.has(`${c.id}|${d}`)}
                              onToggle={() => toggleCell(c, d, dates.has(d))}
                            />
                          ))}
                        </tr>
                      );
                    })}
                    {visibleCollaborators.length === 0 && (
                      <tr>
                        <td colSpan={visibleDays.length + 1} className="px-3 py-8 text-center text-sm text-muted-foreground">Nenhum colaborador ativo neste setor</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="w-64 shrink-0 bg-card border border-border rounded-xl p-4 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Resumo do mês</p>
              {visibleCollaborators.map((c) => {
                const count = entriesByCollaborator.get(c.id)?.size ?? 0;
                return (
                  <div key={c.id} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color || "var(--tone-line)" }} />
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="text-muted-foreground tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{count}d</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
