import { useState, useEffect, useMemo } from "react";
import { apiGet, apiPost, apiPatch, apiDelete } from "./api";
import { Lock, Unlock, ChevronDown, ChevronUp, Plus, Trash2, AlertCircle, Info, Users as UsersIcon, X, Wrench } from "lucide-react";
import { Sector, fmtDate, MONTHS } from "./App";
import { weeklyQuotaForDate, isoWeekKey, sectorMaxHO } from "./homeOfficeRules";

// ─── Tipos ────────────────────────────────────────────────────────────────────

// Versão "segura" do colaborador, vinda de GET /api/home-office/roster — só
// os campos necessários pra montar a escala (nunca salário/aniversário/cargo).
// A escala é visível pra equipe inteira (diferente do Rateio Mensal, que
// restringe GET /api/collaborators ao próprio registro por privacidade
// salarial), por isso não reaproveitamos o tipo Collaborator de App.tsx aqui.
interface HOMember {
  id: string;
  name: string;
  sectorId?: string;
  hireDate?: string;
  active: boolean;
}

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
  sectors: Sector[];
  role: "admin" | "collaborator";
  currentCollaboratorId: string;
}

// ─── Helpers de data ────────────────────────────────────────────────────────────

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const WEEKDAY_FULL = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function weekdayFullName(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAY_FULL[new Date(y, m - 1, d).getDay()];
}

function fmtDayMonth(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

// Agrupa os dias úteis do período em blocos de semana (cada bloco = uma
// semana ISO), na ordem cronológica em que aparecem no mês — "Semana 1" é
// sempre a primeira semana do período, não necessariamente a semana ISO nº1
// do ano. Feriados já saem de period.businessDays, então uma semana com
// feriado no meio simplesmente tem menos de 5 dias.
function computeWeeks(businessDays: string[]): string[][] {
  const weeks: string[][] = [];
  let currentKey = "";
  for (const d of businessDays) {
    const key = isoWeekKey(d);
    if (key !== currentKey) {
      weeks.push([]);
      currentKey = key;
    }
    weeks[weeks.length - 1].push(d);
  }
  return weeks;
}

// Encaixa os dias úteis de uma semana nas 5 posições fixas (Segunda..Sexta),
// deixando null onde não há dia útil (feriado no meio, ou semana parcial no
// início/fim do mês) — assim toda coluna de dia fica sempre do mesmo
// tamanho (1/5 da linha), em vez de esticar quando a semana tem menos dias.
function weekSlots(week: string[]): (string | null)[] {
  const slots: (string | null)[] = [null, null, null, null, null];
  for (const d of week) {
    const [y, m, day] = d.split("-").map(Number);
    const weekday = new Date(y, m - 1, day).getDay(); // 1=segunda..5=sexta
    if (weekday >= 1 && weekday <= 5) slots[weekday - 1] = d;
  }
  return slots;
}

// "AAAA-Www" -> { year, week } pra comparar semanas consecutivas.
function parseWeekKey(key: string): { year: number; week: number } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), week: Number(m[2]) };
}

// Avisos leves (nunca bloqueiam) sobre os dias de HO já marcados por alguém —
// cada string vira o texto do tooltip do ícone de aviso. Retorna só as datas
// realmente envolvidas no padrão (o par de dias consecutivos, ou as semanas
// da sequência repetida) — não o mês inteiro do colaborador, senão o ícone
// aparece em todo dia marcado mesmo quando só um par específico é o problema.
function computeWarningsByDate(businessDays: string[], dates: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (dates.length < 2) return result;
  const addWarning = (date: string, msg: string) => {
    const list = result.get(date) ?? [];
    if (!list.includes(msg)) list.push(msg);
    result.set(date, list);
  };
  const sorted = [...dates].sort();

  const consecutiveMsg = "Dias consecutivos de home office marcados na mesma semana";
  const dayIndex = new Map(businessDays.map((d, i) => [d, i]));
  for (let i = 0; i < sorted.length - 1; i++) {
    const idx = dayIndex.get(sorted[i]);
    const nextIdx = dayIndex.get(sorted[i + 1]);
    if (idx != null && nextIdx != null && nextIdx === idx + 1) {
      addWarning(sorted[i], consecutiveMsg);
      addWarning(sorted[i + 1], consecutiveMsg);
    }
  }

  const repeatMsg = "Sempre escolhe o mesmo dia da semana, em 3 ou mais semanas seguidas";
  const byWeekday = new Map<number, string[]>();
  for (const d of sorted) {
    const [y, m, day] = d.split("-").map(Number);
    const weekday = new Date(y, m - 1, day).getDay();
    if (!byWeekday.has(weekday)) byWeekday.set(weekday, []);
    byWeekday.get(weekday)!.push(d);
  }
  for (const datesForWeekday of byWeekday.values()) {
    const parsed = datesForWeekday.map((d) => ({ date: d, week: parseWeekKey(isoWeekKey(d)) }));
    let runStart = 0;
    for (let i = 1; i <= parsed.length; i++) {
      const prev = parsed[i - 1].week;
      const cur = i < parsed.length ? parsed[i].week : null;
      const consecutive = !!(cur && prev && (cur.year === prev.year ? cur.week === prev.week + 1 : cur.week === 1));
      if (!consecutive) {
        if (i - runStart >= 3) {
          for (let j = runStart; j < i; j++) addWarning(parsed[j].date, repeatMsg);
        }
        runStart = i;
      }
    }
  }

  return result;
}

// ─── Pílula de um colaborador dentro do dia ────────────────────────────────────

interface HOPillProps {
  collaborator: HOMember;
  kind: "ho" | "ferias" | "dayoff";
  color?: string; // cor do setor do colaborador (só usada quando kind === "ho")
  isSelf: boolean;
  canRemove: boolean;
  pending: boolean;
  warnings: string[];
  onRemove: () => void;
}

function HOPill({ collaborator, kind, color, isSelf, canRemove, pending, warnings, onRemove }: HOPillProps) {
  const style =
    kind === "ferias"
      ? { className: "bg-[var(--accent-amber-bg)] text-amber-600", label: `🌴 ${collaborator.name}` }
      : kind === "dayoff"
      ? { className: "bg-[var(--accent-pink-bg)] text-pink-600", label: `Day off ${collaborator.name}` }
      : { className: "", label: collaborator.name };

  return (
    <div
      className={`flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-lg ${style.className} ${isSelf ? "ring-2 ring-primary/40" : ""} ${pending ? "opacity-50" : ""}`}
      style={kind === "ho" ? { backgroundColor: `${color || "var(--tone-subtle)"}22`, color: color || undefined } : undefined}
    >
      {kind === "ho" && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color || "var(--tone-subtle)" }} />}
      <span className="flex-1 truncate font-medium">{style.label}</span>
      {warnings.length > 0 && (
        <span title={warnings.join(" · ")} className="shrink-0 inline-flex">
          <AlertCircle size={11} className="text-amber-500" />
        </span>
      )}
      {isSelf && canRemove && (
        <button onClick={onRemove} disabled={pending} title="Desmarcar meu home office" className="shrink-0 opacity-70 hover:opacity-100 hover:text-red-500 transition-opacity">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// ─── Coluna de um dia (dentro do bloco da semana) ──────────────────────────────

interface HODayColumnProps {
  date: string;
  isToday: boolean;
  meeting?: HOMeeting;
  hoEntries: HOMember[]; // quem está de HO nesse dia, já filtrado pelo setor
  specialEntries: { collaborator: HOMember; type: "ferias" | "dayoff" }[];
  sectorColorById: Map<string, string | undefined>;
  warningsByCollaboratorId: Map<string, string[]>;
  currentCollaboratorId: string;
  selfOn: boolean;
  selfBlockedReason?: string; // férias/dayoff/reunião — não pode marcar
  canSelfToggle: boolean;
  pendingSelf: boolean;
  onToggleSelf: () => void;
  // Só preenchido quando o setor relevante (o filtrado, ou o do próprio
  // usuário) está de fato sem vagas nesse dia — é a única situação em que o
  // ícone de aviso aparece (adversidade real, não ocupação qualquer).
  sectorFullWarning?: string;
}

function HODayColumn({
  date,
  isToday,
  meeting,
  hoEntries,
  specialEntries,
  sectorColorById,
  warningsByCollaboratorId,
  currentCollaboratorId,
  selfOn,
  selfBlockedReason,
  canSelfToggle,
  pendingSelf,
  onToggleSelf,
  sectorFullWarning,
}: HODayColumnProps) {
  const showAddSelf = canSelfToggle && !selfOn && !selfBlockedReason;

  return (
    <div className="flex flex-col border-b md:border-b-0 md:border-r border-border last:border-b-0 md:last:border-r-0 min-w-0">
      <div className={`px-3 py-2 border-b border-border ${isToday ? "bg-muted" : ""}`}>
        <p className={`text-xs font-semibold truncate ${isToday ? "text-primary" : ""}`}>{weekdayFullName(date)}</p>
        <p className="text-[10px] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>{fmtDayMonth(date)}</p>
      </div>
      <div className="p-2 space-y-1.5 flex-1">
        {meeting ? (
          <div className="rounded-lg bg-[var(--tone-subtle)]/15 border border-dashed border-[var(--tone-subtle)] p-3 text-center" title={meeting.title || "Reunião Geral — sem home office pra ninguém neste dia"}>
            <UsersIcon size={16} className="mx-auto mb-1 text-muted-foreground" />
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Reunião Geral</p>
            {meeting.title && <p className="text-[10px] text-[var(--tone-subtle)] mt-0.5">{meeting.title}</p>}
          </div>
        ) : (
          <>
            {sectorFullWarning && (
              <div className="flex items-center gap-1 text-[10px] text-red-500 font-medium mb-1" title={sectorFullWarning}>
                <Info size={11} className="shrink-0" />
                <span className="truncate">Sem vagas</span>
              </div>
            )}
            {hoEntries.map((c) => (
              <HOPill
                key={c.id}
                collaborator={c}
                kind="ho"
                color={c.sectorId ? sectorColorById.get(c.sectorId) : undefined}
                isSelf={c.id === currentCollaboratorId}
                canRemove={canSelfToggle}
                pending={pendingSelf && c.id === currentCollaboratorId}
                warnings={warningsByCollaboratorId.get(`${c.id}|${date}`) ?? []}
                onRemove={onToggleSelf}
              />
            ))}
            {specialEntries.map(({ collaborator, type }) => (
              <HOPill key={`${collaborator.id}-${type}`} collaborator={collaborator} kind={type} isSelf={false} canRemove={false} pending={false} warnings={[]} onRemove={() => {}} />
            ))}
            {showAddSelf && (
              <button
                onClick={onToggleSelf}
                disabled={pendingSelf}
                className="w-full h-8 rounded-lg border border-dashed border-border hover:border-primary/50 text-[11px] text-muted-foreground hover:text-foreground transition-all flex items-center justify-center gap-1"
              >
                <Plus size={12} />Marcar meu HO
              </button>
            )}
            {hoEntries.length === 0 && specialEntries.length === 0 && !showAddSelf && (
              <p className="text-[10px] text-[var(--tone-subtle)] text-center py-2">—</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Painel da Supervisão ─────────────────────────────────────────────────────

interface HOSupervisorPanelProps {
  period: HOPeriod | null;
  roster: HOMember[];
  sectors: Sector[];
  onOpenPeriod: (month: number, year: number, deadline: string) => void;
  onPatchPeriod: (patch: { deadline?: string; status?: "open" | "approved" }) => void;
  onAddMeeting: (date: string, title: string) => void;
  onRemoveMeeting: (id: number) => void;
  onAddSpecialDay: (collaboratorId: string, date: string, type: "ferias" | "dayoff") => void;
  onRemoveSpecialDay: (id: number) => void;
  onCorrectEntry: (collaboratorId: string, date: string, currentlyOn: boolean) => void;
}

function HOSupervisorPanel({
  period,
  roster,
  sectors,
  onOpenPeriod,
  onPatchPeriod,
  onAddMeeting,
  onRemoveMeeting,
  onAddSpecialDay,
  onRemoveSpecialDay,
  onCorrectEntry,
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
  const [correctionCollaboratorId, setCorrectionCollaboratorId] = useState("");
  const [correctionDate, setCorrectionDate] = useState("");

  useEffect(() => setDeadlineDraft(period?.deadline ?? ""), [period?.id, period?.deadline]);

  const collaboratorName = (id: string) => roster.find((c) => c.id === id)?.name ?? "—";

  const activeBySector = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of roster) {
      if (!c.active || !c.sectorId) continue;
      map.set(c.sectorId, (map.get(c.sectorId) ?? 0) + 1);
    }
    return map;
  }, [roster]);

  const correctionCurrentlyOn = useMemo(() => {
    if (!period || !correctionCollaboratorId || !correctionDate) return false;
    const entry = period.entries.find((e) => e.collaboratorId === correctionCollaboratorId);
    return !!entry?.dates.includes(correctionDate);
  }, [period, correctionCollaboratorId, correctionDate]);

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
                  <div className="flex flex-wrap items-center gap-2">
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
                  <div className="flex flex-wrap items-center gap-2">
                    <select className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={specialCollaboratorId} onChange={(e) => setSpecialCollaboratorId(e.target.value)}>
                      <option value="">Colaborador…</option>
                      {roster.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <input type="date" className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={specialDate} onChange={(e) => setSpecialDate(e.target.value)} />
                    <select className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={specialType} onChange={(e) => setSpecialType(e.target.value as "ferias" | "dayoff")}>
                      <option value="ferias">Férias</option>
                      <option value="dayoff">Day off</option>
                    </select>
                    <button
                      onClick={() => {
                        if (!specialCollaboratorId || !specialDate) return;
                        onAddSpecialDay(specialCollaboratorId, specialDate, specialType);
                        // Limpa tudo (não só a data) — senão o formulário fica com o
                        // colaborador/tipo antigos selecionados, o botão desabilita
                        // silenciosamente (falta só a data) e parece que travou depois
                        // do primeiro registro.
                        setSpecialCollaboratorId("");
                        setSpecialDate("");
                        setSpecialType("ferias");
                      }}
                      disabled={!specialCollaboratorId || !specialDate}
                      className="h-8 px-3 text-sm font-medium bg-muted rounded-lg hover:bg-input-background disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
                    >
                      <Plus size={13} />Adicionar
                    </button>
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <Wrench size={12} />Corrigir home office de um colaborador
                </p>
                <p className="text-[10px] text-[var(--tone-subtle)] mb-2">
                  Uso excepcional — cada colaborador marca os próprios dias sozinho. Use isso só depois da escala já definida, pra corrigir uma troca pontual
                  (ex: alguém que não pode mais ir presencial num dia e precisa trocar).
                </p>
                {period.status === "open" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <select className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={correctionCollaboratorId} onChange={(e) => setCorrectionCollaboratorId(e.target.value)}>
                      <option value="">Colaborador…</option>
                      {roster.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <input type="date" className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={correctionDate} onChange={(e) => setCorrectionDate(e.target.value)} />
                    <button
                      onClick={() => {
                        onCorrectEntry(correctionCollaboratorId, correctionDate, correctionCurrentlyOn);
                        setCorrectionCollaboratorId("");
                        setCorrectionDate("");
                      }}
                      disabled={!correctionCollaboratorId || !correctionDate}
                      className="h-8 px-3 text-sm font-medium bg-muted rounded-lg hover:bg-input-background disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                    >
                      {correctionCollaboratorId && correctionDate ? (correctionCurrentlyOn ? "Desmarcar HO" : "Marcar HO") : "Marcar/Desmarcar HO"}
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--tone-subtle)]">Escala aprovada — reabra pra corrigir.</p>
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

export default function HomeOffice({ sectors, role, currentCollaboratorId }: HomeOfficeProps) {
  const [period, setPeriod] = useState<HOPeriod | null>(null);
  const [roster, setRoster] = useState<HOMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [sectorFilter, setSectorFilter] = useState("all");
  // "month" mostra todas as semanas empilhadas; um número mostra só aquela semana.
  const [weekFilter, setWeekFilter] = useState<"month" | number>("month");
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([apiGet("/home-office/current"), apiGet("/home-office/roster")])
      .then(([p, r]) => { if (!cancelled) { setPeriod(p); setRoster(r); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const today = todayISO();

  const weeks = useMemo(() => (period ? computeWeeks(period.businessDays) : []), [period]);

  // Ao trocar de período, volta pro filtro "Mês" (vê o mês inteiro de novo).
  useEffect(() => {
    setWeekFilter("month");
  }, [period?.id]);

  // "Mês" mostra todas as semanas; "Semana N" mostra só aquele bloco.
  const weeksToRender = useMemo(
    () => (weekFilter === "month" ? weeks.map((week, i) => ({ week, i })) : weeks[weekFilter] ? [{ week: weeks[weekFilter], i: weekFilter }] : []),
    [weeks, weekFilter]
  );

  const entriesByCollaborator = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of period?.entries ?? []) map.set(e.collaboratorId, new Set(e.dates));
    return map;
  }, [period]);

  const specialByDate = useMemo(() => {
    const map = new Map<string, HOSpecialDay[]>();
    for (const s of period?.specialDays ?? []) {
      if (!map.has(s.date)) map.set(s.date, []);
      map.get(s.date)!.push(s);
    }
    return map;
  }, [period]);

  const meetingByDate = useMemo(() => {
    const map = new Map<string, HOMeeting>();
    for (const m of period?.generalMeetings ?? []) map.set(m.date, m);
    return map;
  }, [period]);

  // Cor da tag na Escala de Home Office é do setor — todo mundo do mesmo
  // setor usa a mesma cor, não é mais escolhida por colaborador.
  const sectorColorById = useMemo(() => new Map(sectors.map((s) => [s.id, s.color])), [sectors]);

  const activeMembersBySector = useMemo(() => {
    const map = new Map<string, HOMember[]>();
    for (const c of roster) {
      if (!c.active || !c.sectorId) continue;
      if (!map.has(c.sectorId)) map.set(c.sectorId, []);
      map.get(c.sectorId)!.push(c);
    }
    return map;
  }, [roster]);

  // Quantas pessoas (ativas) de cada setor já estão de HO em cada data — usado
  // só pro preview de vagas/avisos; a checagem de verdade é sempre no servidor.
  const sectorUsageByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of roster) {
      if (!c.active || !c.sectorId) continue;
      const dates = entriesByCollaborator.get(c.id);
      if (!dates) continue;
      for (const d of dates) {
        const key = `${c.sectorId}|${d}`;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
    }
    return map;
  }, [roster, entriesByCollaborator]);

  // Chave "collaboratorId|data" -> avisos daquele dia específico (não do mês
  // inteiro do colaborador — só a data que de fato tem o padrão problemático).
  const warningsByCollaboratorId = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!period) return map;
    for (const c of roster) {
      const dates = [...(entriesByCollaborator.get(c.id) ?? [])];
      const byDate = computeWarningsByDate(period.businessDays, dates);
      for (const [date, warnings] of byDate) {
        map.set(`${c.id}|${date}`, warnings);
      }
    }
    return map;
  }, [roster, entriesByCollaborator, period]);

  const collaboratorsById = useMemo(() => new Map(roster.map((c) => [c.id, c])), [roster]);
  const viewerSectorId = collaboratorsById.get(currentCollaboratorId)?.sectorId;

  const summaryCollaborators = useMemo(() => {
    return roster
      .filter((c) => c.active)
      .filter((c) => sectorFilter === "all" || c.sectorId === sectorFilter)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [roster, sectorFilter]);

  function refreshPeriod(next: HOPeriod) {
    setPeriod(next);
  }

  // Só chamada pra própria pessoa a partir do grid (ver canSelfToggle abaixo);
  // o painel da supervisão chama a mesma função pra corrigir qualquer um.
  async function toggleEntry(collaborator: HOMember, date: string, currentlyOn: boolean) {
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
            .map((id) => roster.find((c) => c.id === id)?.name ?? id)
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

  function correctEntry(collaboratorId: string, date: string, currentlyOn: boolean) {
    const collaborator = collaboratorsById.get(collaboratorId);
    if (!collaborator) return;
    toggleEntry(collaborator, date, currentlyOn);
  }

  // Monta a coluna de um dia — usada pra todas as semanas do mês, já que
  // agora todos os blocos ficam visíveis ao mesmo tempo (um embaixo do outro).
  function renderDayColumn(date: string) {
    const meeting = meetingByDate.get(date);
    const specialsToday = specialByDate.get(date) ?? [];
    const specialByCollaborator = new Map(specialsToday.map((s) => [s.collaboratorId, s.type]));

    const hoEntries = roster
      .filter((c) => c.active)
      .filter((c) => sectorFilter === "all" || c.sectorId === sectorFilter || c.id === currentCollaboratorId)
      .filter((c) => entriesByCollaborator.get(c.id)?.has(date))
      .filter((c) => !specialByCollaborator.has(c.id))
      .sort((a, b) => (a.id === currentCollaboratorId ? -1 : b.id === currentCollaboratorId ? 1 : a.name.localeCompare(b.name)));

    const specialEntries = specialsToday
      .map((s) => ({ collaborator: collaboratorsById.get(s.collaboratorId), type: s.type }))
      .filter((s): s is { collaborator: HOMember; type: "ferias" | "dayoff" } => !!s.collaborator)
      .filter((s) => sectorFilter === "all" || s.collaborator.sectorId === sectorFilter);

    const ownSpecial = specialByCollaborator.get(currentCollaboratorId);
    const selfOn = !!entriesByCollaborator.get(currentCollaboratorId)?.has(date);
    const selfBlockedReason = ownSpecial ? (ownSpecial === "ferias" ? "Férias" : "Day off") : meeting ? "Reunião Geral" : undefined;
    const canSelfToggle = !!period && period.status === "open" && !!currentCollaboratorId && !selfBlockedReason;

    // Só mostra o aviso quando o setor relevante (o filtrado, ou — sem
    // filtro — o do próprio usuário) está de fato sem vagas nesse dia. Nada
    // de aviso em dia com vaga sobrando, mesmo que já tenha gente de HO.
    const relevantSectorId = sectorFilter !== "all" ? sectorFilter : viewerSectorId;
    let sectorFullWarning: string | undefined;
    if (relevantSectorId && !meeting) {
      const activeCount = activeMembersBySector.get(relevantSectorId)?.length ?? 0;
      const max = sectorMaxHO(activeCount);
      const used = sectorUsageByDate.get(`${relevantSectorId}|${date}`) ?? 0;
      if (activeCount > 0 && used >= max) {
        const sectorName = sectors.find((s) => s.id === relevantSectorId)?.name;
        sectorFullWarning = `Setor${sectorName ? ` ${sectorName}` : ""} sem vagas de home office neste dia (${used}/${max})`;
      }
    }

    return (
      <HODayColumn
        key={date}
        date={date}
        isToday={date === today}
        meeting={meeting}
        hoEntries={hoEntries}
        specialEntries={specialEntries}
        sectorColorById={sectorColorById}
        warningsByCollaboratorId={warningsByCollaboratorId}
        currentCollaboratorId={currentCollaboratorId}
        selfOn={selfOn}
        selfBlockedReason={selfBlockedReason}
        canSelfToggle={canSelfToggle}
        pendingSelf={pendingCells.has(`${currentCollaboratorId}|${date}`)}
        onToggleSelf={() => {
          const self = collaboratorsById.get(currentCollaboratorId);
          if (self) toggleEntry(self, date, selfOn);
        }}
        sectorFullWarning={sectorFullWarning}
      />
    );
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-sm text-[var(--tone-subtle)]">Carregando…</div>;
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-4 md:px-8 py-6 md:py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Home Office</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {period ? `${MONTHS[period.month]} ${period.year}${period.deadline ? ` · preencher até ${fmtDate(period.deadline)}` : ""}` : "Nenhuma escala aberta"}
            </p>
          </div>
          {period && (
            <select className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}>
              <option value="all">Todos os setores</option>
              {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </div>

        {role === "admin" && (
          <HOSupervisorPanel
            period={period}
            roster={roster}
            sectors={sectors}
            onOpenPeriod={openPeriod}
            onPatchPeriod={patchPeriod}
            onAddMeeting={addMeeting}
            onRemoveMeeting={removeMeeting}
            onAddSpecialDay={addSpecialDay}
            onRemoveSpecialDay={removeSpecialDay}
            onCorrectEntry={correctEntry}
          />
        )}

        {!period && role !== "admin" && (
          <p className="text-sm text-muted-foreground">Nenhuma escala de Home Office está aberta no momento.</p>
        )}

        {period && (
          <>
            {/* Filtro rápido: "Mês" mostra todas as semanas empilhadas;
                escolher uma semana mostra só aquele bloco. flex-wrap em vez
                de scroll horizontal — nunca deve aparecer barra lateral. */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setWeekFilter("month")}
                className={`shrink-0 px-3 h-9 rounded-lg text-xs font-medium transition-all ${
                  weekFilter === "month" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                Mês
              </button>
              {weeks.map((week, i) => (
                <button
                  key={i}
                  onClick={() => setWeekFilter(i)}
                  className={`shrink-0 px-3 h-9 rounded-lg text-xs font-medium transition-all ${
                    weekFilter === i ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Semana {i + 1}
                  <span className="opacity-70 ml-1.5" style={{ fontFamily: "var(--font-mono)" }}>
                    {fmtDayMonth(week[0])}–{fmtDayMonth(week[week.length - 1])}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex flex-col md:flex-row gap-6 items-start min-w-0">
              <div className="flex-1 min-w-0 w-full space-y-4">
                {weeksToRender.map(({ week, i }) => (
                  <div key={i} className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="px-4 py-2 border-b border-border bg-muted/40">
                      <p className="text-xs font-semibold">
                        Semana {i + 1}
                        <span className="text-muted-foreground font-normal ml-1.5" style={{ fontFamily: "var(--font-mono)" }}>
                          · {fmtDayMonth(week[0])}–{fmtDayMonth(week[week.length - 1])}
                        </span>
                      </p>
                    </div>
                    {/* Empilhado (1 coluna) no celular — cada dia é uma faixa cheia,
                        legível; a grade lado a lado (5 colunas) só a partir de md. */}
                    <div className="grid grid-cols-1 md:grid-cols-5">
                      {weekSlots(week).map((date, slot) =>
                        date ? renderDayColumn(date) : <div key={slot} className="hidden md:block border-r border-border last:border-r-0" />
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="w-full md:w-56 md:shrink-0 bg-card border border-border rounded-xl p-4 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Resumo do mês</p>
                {summaryCollaborators.map((c) => {
                  const count = entriesByCollaborator.get(c.id)?.size ?? 0;
                  return (
                    <div key={c.id} className="flex items-center gap-2 text-xs">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: (c.sectorId && sectorColorById.get(c.sectorId)) || "var(--tone-line)" }} />
                      <span className="flex-1 truncate">{c.name}</span>
                      <span className="text-muted-foreground tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{count}d</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
