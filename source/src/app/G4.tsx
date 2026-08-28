import { useState, useMemo, useEffect, useCallback } from "react";
import { apiGet, apiPost, apiPatch, apiDelete } from "./api";
import { Trash2, Pencil, X, Check, Upload, Video, Eye, EyeOff, GraduationCap } from "lucide-react";
import { Sector, Collaborator, fmtDate } from "./App";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface G4Session {
  id: number;
  sectorId: string;
  sectorName: string;
  date: string; // "YYYY-MM-DD"
  presenterCollaboratorId: string;
  presenterName: string;
  topic: string;
  hasRecording: boolean;
  recordingFilename?: string;
  recordingMime?: string;
  recordingSize?: number;
  recordingUploadedAt?: string;
  viewerCount: number;
  viewedByMe: boolean;
}

interface G4Props {
  role: "admin" | "collaborator";
  currentCollaboratorId: string;
  sectors: Sector[];
  collaborators: Collaborator[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtBytes(bytes?: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

// Upload com barra de progresso — precisa de XMLHttpRequest porque `fetch`
// não expõe evento de progresso de envio (usado pelos helpers de ./api).
function uploadRecording(sessionId: number, file: File, onProgress: (pct: number) => void): Promise<G4Session> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/g4/sessions/${sessionId}/recording`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // resposta sem corpo JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || `Erro (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Falha de rede ao enviar o arquivo"));
    const formData = new FormData();
    formData.append("recording", file);
    xhr.send(formData);
  });
}

// ─── Card de uma sessão ─────────────────────────────────────────────────────────

interface G4SessionCardProps {
  session: G4Session;
  isPast: boolean;
  canManage: boolean; // admin ou o próprio apresentador
  isAdmin: boolean;
  sectorColor?: string;
  hasCollaborator: boolean;
  onSaveTopic: (topic: string) => void;
  onUpload: (file: File) => void;
  onRemoveRecording: () => void;
  uploadProgress: number | null;
  onToggleViewed: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function G4SessionCard({
  session,
  isPast,
  canManage,
  isAdmin,
  sectorColor,
  hasCollaborator,
  onSaveTopic,
  onUpload,
  onRemoveRecording,
  uploadProgress,
  onToggleViewed,
  onEdit,
  onDelete,
}: G4SessionCardProps) {
  const [topicDraft, setTopicDraft] = useState(session.topic);
  useEffect(() => setTopicDraft(session.topic), [session.topic]);
  const topicChanged = topicDraft.trim() !== session.topic;

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-[11px] font-medium px-2 py-0.5 rounded-full"
            style={{ backgroundColor: `${sectorColor || "var(--tone-subtle)"}22`, color: sectorColor || undefined }}
          >
            {session.sectorName}
          </span>
          <span className="text-sm font-semibold">{fmtDate(session.date)}</span>
          <span className="text-xs text-muted-foreground">· {session.presenterName}</span>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onEdit} title="Editar agendamento" className="text-[var(--tone-subtle)] hover:text-primary">
              <Pencil size={13} />
            </button>
            <button onClick={onDelete} title="Excluir" className="text-[var(--tone-subtle)] hover:text-red-500">
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>

      {canManage ? (
        <div className="flex items-center gap-2">
          <input
            className="flex-1 h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary"
            placeholder="Qual vai ser o tema desse G4?"
            value={topicDraft}
            onChange={(e) => setTopicDraft(e.target.value)}
          />
          {topicChanged && (
            <button
              onClick={() => onSaveTopic(topicDraft)}
              className="h-8 px-3 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all flex items-center gap-1"
            >
              <Check size={13} />
              Salvar
            </button>
          )}
        </div>
      ) : (
        <p className="text-sm">{session.topic || <span className="text-[var(--tone-subtle)]">Tema ainda não definido</span>}</p>
      )}

      {session.hasRecording && (
        <video controls preload="metadata" className="w-full rounded-lg bg-black" src={`/api/g4/sessions/${session.id}/recording`} />
      )}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          {session.hasRecording ? (
            <>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Video size={12} />
                {session.recordingFilename} {session.recordingSize ? `(${fmtBytes(session.recordingSize)})` : ""}
              </span>
              <button onClick={onRemoveRecording} className="text-xs text-muted-foreground hover:text-red-500 underline decoration-dotted">
                Remover gravação
              </button>
            </>
          ) : uploadProgress != null ? (
            <div className="flex items-center gap-2 flex-1 min-w-[160px]">
              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${uploadProgress}%` }} />
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">{uploadProgress}%</span>
            </div>
          ) : (
            <label className="h-8 px-3 text-sm font-medium bg-muted rounded-lg hover:bg-input-background transition-all flex items-center gap-1.5 cursor-pointer">
              <Upload size={13} />
              Anexar gravação
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUpload(file);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
      )}

      {isPast && hasCollaborator && (
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={onToggleViewed}
            className={`h-7 px-3 text-xs font-medium rounded-full transition-all flex items-center gap-1.5 ${
              session.viewedByMe ? "bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {session.viewedByMe ? <Eye size={12} /> : <EyeOff size={12} />}
            {session.viewedByMe ? "Já vi" : "Marcar como visto"}
          </button>
          <span className="text-xs text-[var(--tone-subtle)]">
            {session.viewerCount} {session.viewerCount === 1 ? "pessoa já viu" : "pessoas já viram"}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Formulário de agendamento / edição (admin) ────────────────────────────────

interface G4ScheduleFormProps {
  sectors: Sector[];
  collaborators: Collaborator[];
  initial?: { sectorId: string; date: string; presenterCollaboratorId: string };
  onSubmit: (data: { sectorId: string; date: string; presenterCollaboratorId: string }) => void;
  onCancel?: () => void;
  submitLabel: string;
}

function G4ScheduleForm({ sectors, collaborators, initial, onSubmit, onCancel, submitLabel }: G4ScheduleFormProps) {
  const [sectorId, setSectorId] = useState(initial?.sectorId ?? "");
  const [date, setDate] = useState(initial?.date ?? todayISO());
  const [presenterId, setPresenterId] = useState(initial?.presenterCollaboratorId ?? "");

  const sectorMembers = useMemo(
    () => collaborators.filter((c) => c.active && c.sectorId === sectorId).sort((a, b) => a.name.localeCompare(b.name)),
    [collaborators, sectorId]
  );

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">Área</label>
        <select
          className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary"
          value={sectorId}
          onChange={(e) => {
            setSectorId(e.target.value);
            setPresenterId("");
          }}
        >
          <option value="">Selecione…</option>
          {sectors.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">Data</label>
        <input
          type="date"
          className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">Responsável</label>
        <select
          className="h-8 px-3 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary disabled:opacity-50"
          value={presenterId}
          onChange={(e) => setPresenterId(e.target.value)}
          disabled={!sectorId}
        >
          <option value="">Selecione…</option>
          {sectorMembers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <button
        onClick={() => sectorId && date && presenterId && onSubmit({ sectorId, date, presenterCollaboratorId: presenterId })}
        disabled={!sectorId || !date || !presenterId}
        className="h-8 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
      >
        <Check size={13} />
        {submitLabel}
      </button>
      {onCancel && (
        <button onClick={onCancel} className="h-8 px-3 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-input-background transition-all flex items-center gap-1">
          <X size={13} />
          Cancelar
        </button>
      )}
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function G4({ role, currentCollaboratorId, sectors, collaborators }: G4Props) {
  const [sessions, setSessions] = useState<G4Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState<Record<number, number | null>>({});
  const [onlyUnwatched, setOnlyUnwatched] = useState(false);

  const hasCollaborator = !!currentCollaboratorId;
  const sectorColorById = useMemo(() => new Map(sectors.map((s) => [s.id, s.color])), [sectors]);

  const load = useCallback(() => {
    setLoading(true);
    apiGet("/g4/sessions")
      .then((rows) => setSessions(rows))
      .catch((e) => alert(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function updateSessionInState(updated: G4Session) {
    setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  }

  function scheduleSession(data: { sectorId: string; date: string; presenterCollaboratorId: string }) {
    apiPost("/g4/sessions", data)
      .then(load)
      .catch((e) => alert(e.message));
  }

  function editSession(id: number, data: { sectorId: string; date: string; presenterCollaboratorId: string }) {
    apiPatch(`/g4/sessions/${id}`, data)
      .then((updated) => {
        updateSessionInState(updated);
        setEditingId(null);
      })
      .catch((e) => alert(e.message));
  }

  function deleteSession(id: number) {
    if (!window.confirm("Excluir este G4 agendado? A gravação (se tiver) também será apagada.")) return;
    apiDelete(`/g4/sessions/${id}`)
      .then(() => setSessions((prev) => prev.filter((s) => s.id !== id)))
      .catch((e) => alert(e.message));
  }

  function saveTopic(id: number, topic: string) {
    apiPatch(`/g4/sessions/${id}/topic`, { topic })
      .then(updateSessionInState)
      .catch((e) => alert(e.message));
  }

  function handleUpload(id: number, file: File) {
    setUploadProgress((p) => ({ ...p, [id]: 0 }));
    uploadRecording(id, file, (pct) => setUploadProgress((p) => ({ ...p, [id]: pct })))
      .then((updated) => updateSessionInState(updated))
      .catch((e) => alert(e.message))
      .finally(() => setUploadProgress((p) => ({ ...p, [id]: null })));
  }

  function removeRecording(id: number) {
    if (!window.confirm("Remover a gravação deste G4?")) return;
    apiDelete(`/g4/sessions/${id}/recording`)
      .then(updateSessionInState)
      .catch((e) => alert(e.message));
  }

  function toggleViewed(session: G4Session) {
    const call = session.viewedByMe ? apiDelete(`/g4/sessions/${session.id}/views`) : apiPost(`/g4/sessions/${session.id}/views`, {});
    call.then(updateSessionInState).catch((e) => alert(e.message));
  }

  const today = todayISO();
  const upcoming = sessions.filter((s) => s.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = sessions
    .filter((s) => s.date < today)
    .filter((s) => !onlyUnwatched || !s.viewedByMe)
    .sort((a, b) => b.date.localeCompare(a.date));

  function canManage(session: G4Session): boolean {
    return role === "admin" || (hasCollaborator && currentCollaboratorId === session.presenterCollaboratorId);
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-sm text-[var(--tone-subtle)]">Carregando…</div>;
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-4 md:px-8 py-6 md:py-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <GraduationCap size={20} />
            G4
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">Treinamento interno quinzenal — agenda, temas e gravações por área.</p>
        </div>

        {role === "admin" && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Agendar G4</p>
            <G4ScheduleForm sectors={sectors} collaborators={collaborators} onSubmit={scheduleSession} submitLabel="Agendar" />
          </div>
        )}

        <div className="space-y-3">
          <p className="text-sm font-semibold">Próximos G4s</p>
          {upcoming.length === 0 && <p className="text-sm text-[var(--tone-subtle)]">Nenhum G4 agendado.</p>}
          {upcoming.map((s) =>
            editingId === s.id ? (
              <div key={s.id} className="bg-card border border-border rounded-xl p-4">
                <G4ScheduleForm
                  sectors={sectors}
                  collaborators={collaborators}
                  initial={{ sectorId: s.sectorId, date: s.date, presenterCollaboratorId: s.presenterCollaboratorId }}
                  onSubmit={(data) => editSession(s.id, data)}
                  onCancel={() => setEditingId(null)}
                  submitLabel="Salvar"
                />
              </div>
            ) : (
              <G4SessionCard
                key={s.id}
                session={s}
                isPast={false}
                canManage={canManage(s)}
                isAdmin={role === "admin"}
                sectorColor={sectorColorById.get(s.sectorId)}
                hasCollaborator={hasCollaborator}
                onSaveTopic={(topic) => saveTopic(s.id, topic)}
                onUpload={(file) => handleUpload(s.id, file)}
                onRemoveRecording={() => removeRecording(s.id)}
                uploadProgress={uploadProgress[s.id] ?? null}
                onToggleViewed={() => toggleViewed(s)}
                onEdit={() => setEditingId(s.id)}
                onDelete={() => deleteSession(s.id)}
              />
            )
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold">Já realizados</p>
            {hasCollaborator && (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={onlyUnwatched} onChange={(e) => setOnlyUnwatched(e.target.checked)} />
                Mostrar só o que eu ainda não vi
              </label>
            )}
          </div>
          {past.length === 0 && <p className="text-sm text-[var(--tone-subtle)]">Nenhum G4 realizado ainda.</p>}
          {past.map((s) =>
            editingId === s.id ? (
              <div key={s.id} className="bg-card border border-border rounded-xl p-4">
                <G4ScheduleForm
                  sectors={sectors}
                  collaborators={collaborators}
                  initial={{ sectorId: s.sectorId, date: s.date, presenterCollaboratorId: s.presenterCollaboratorId }}
                  onSubmit={(data) => editSession(s.id, data)}
                  onCancel={() => setEditingId(null)}
                  submitLabel="Salvar"
                />
              </div>
            ) : (
              <G4SessionCard
                key={s.id}
                session={s}
                isPast
                canManage={canManage(s)}
                isAdmin={role === "admin"}
                sectorColor={sectorColorById.get(s.sectorId)}
                hasCollaborator={hasCollaborator}
                onSaveTopic={(topic) => saveTopic(s.id, topic)}
                onUpload={(file) => handleUpload(s.id, file)}
                onRemoveRecording={() => removeRecording(s.id)}
                uploadProgress={uploadProgress[s.id] ?? null}
                onToggleViewed={() => toggleViewed(s)}
                onEdit={() => setEditingId(s.id)}
                onDelete={() => deleteSession(s.id)}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}
