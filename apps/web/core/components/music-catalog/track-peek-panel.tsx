/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Track peek panel (side sheet): every value of the record visible, copyable
 * and editable in place — media (cover, audio, TikTok preview) uploadable and
 * playable, credits/genres/releases/distributions add-remove with searchable
 * pickers, single-record export, and access to the full editor. Sits BELOW
 * the edit sheet's z-stack (z-21 < BudgetPeekPanel's z-24) and closes on
 * Escape / outside click.
 */

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  ImagePlus,
  Loader2,
  Music2,
  Pencil,
  Plus,
  Upload,
  Video,
  X,
} from "lucide-react";
// plane imports
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TMusicCatalogOptions,
  TMusicCompany,
  TMusicGenre,
  TMusicParty,
  TMusicRelease,
  TMusicTrack,
} from "@plane/types";
import { cn, copyTextToClipboard } from "@plane/utils";
// services
import { fileLibraryService } from "@/services/file-library.service";
import { musicService } from "@/services/music.service";
// local imports
import { AudioPreviewRange } from "./audio-preview-range";
import { EditableField } from "./editable-field";
import { SearchableSelect } from "./searchable-select";

type Props = {
  workspaceSlug: string;
  track: TMusicTrack;
  options?: TMusicCatalogOptions;
  parties: TMusicParty[];
  genres: TMusicGenre[];
  companies: TMusicCompany[];
  releases: TMusicRelease[];
  /** While the full editor (or another sheet) is open, Esc must not close us */
  suspendClose?: boolean;
  onClose: () => void;
  onEditFull: (track: TMusicTrack) => void;
  onSaved: () => void;
  onResourcesChanged: () => void;
};

const BOOL_OPTIONS = [
  { value: "true", label: "Sí" },
  { value: "false", label: "No" },
];

function CopyButton({ value, label }: { value: string | null | undefined; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      title={`Copiar${label ? ` ${label}` : ""}`}
      onClick={() => {
        void copyTextToClipboard(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="shrink-0 rounded-sm p-1 text-tertiary opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-layer-1-hover hover:text-primary"
    >
      {copied ? <Check className="size-3 text-success-primary" /> : <Copy className="size-3" />}
    </button>
  );
}

/** Label + editable value + copy, the panel's repeating row */
function FieldRow(props: {
  label: string;
  value: string | null;
  copyValue?: string | null;
  onSave?: (value: string) => Promise<void>;
  variant?: "input" | "textarea" | "date" | "select";
  options?: { value: string; label: string }[];
  format?: (value: string) => string;
  mono?: boolean;
}) {
  const { label, value, copyValue, onSave, variant, options, format, mono } = props;
  return (
    <div className="group/row flex items-start gap-1">
      <p className="w-32 shrink-0 pt-1.5 text-11 text-tertiary">{label}</p>
      <div className="min-w-0 flex-1">
        {onSave ? (
          <EditableField
            value={value}
            onSave={onSave}
            variant={variant}
            options={options}
            format={format}
            className={mono ? "font-mono text-12" : undefined}
          />
        ) : (
          <p className={cn("px-1.5 py-1 text-13", mono && "font-mono text-12", !value && "text-placeholder")}>
            {value || "—"}
          </p>
        )}
      </div>
      <div className="pt-1">
        <CopyButton value={copyValue ?? value} label={label} />
      </div>
    </div>
  );
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-subtle pb-1">
      <h3 className="text-11 font-semibold tracking-wide text-tertiary uppercase">{children}</h3>
      {action}
    </div>
  );
}

function AddAction({ onClick, isOpen }: { onClick: () => void; isOpen: boolean }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 text-11 text-accent-primary hover:underline">
      {isOpen ? <X className="size-3" /> : <Plus className="size-3" />} {isOpen ? "Cancelar" : "Agregar"}
    </button>
  );
}

export function MusicTrackPeekPanel(props: Props) {
  const {
    workspaceSlug,
    track: initialTrack,
    options,
    parties,
    genres,
    companies,
    releases,
    suspendClose,
    onClose,
    onEditFull,
    onSaved,
    onResourcesChanged,
  } = props;
  // The panel owns the freshest copy: PATCH responses replace it in place
  const [track, setTrack] = useState(initialTrack);
  const [isAddingCredit, setIsAddingCredit] = useState(false);
  const [newCreditRole, setNewCreditRole] = useState("PRIMARY_ARTIST");
  const [isAddingGenre, setIsAddingGenre] = useState(false);
  const [isAddingRelease, setIsAddingRelease] = useState(false);
  const [isAddingDistribution, setIsAddingDistribution] = useState(false);
  const [newDistribution, setNewDistribution] = useState({ company_id: "", percentage: "" });
  const [isExporting, setIsExporting] = useState(false);
  const [uploading, setUploading] = useState<"audio" | "cover" | null>(null);
  const [preview, setPreview] = useState({ start: 0, end: 0, duration: 0, dirty: false });
  const [isSavingPreview, setIsSavingPreview] = useState(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setTrack(initialTrack), [initialTrack]);
  useEffect(
    () =>
      setPreview({
        start: track.tiktok_preview_start_ms ?? 0,
        end: track.tiktok_preview_end_ms ?? 0,
        duration: track.duration_ms ?? 0,
        dirty: false,
      }),
    [track.id, track.tiktok_preview_start_ms, track.tiktok_preview_end_ms, track.duration_ms]
  );

  // Escape closes the panel unless a sheet is stacked on top
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !suspendClose) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [suspendClose, onClose]);

  const patch = async (payload: Record<string, unknown>) => {
    try {
      const updated = await musicService.saveTrack(workspaceSlug, { id: track.id, ...payload });
      setTrack(updated);
      onSaved();
    } catch (error: unknown) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "No se pudo guardar",
        message: error instanceof Error ? error.message : undefined,
      });
      throw error;
    }
  };

  const saveField = (field: string) => async (value: string) => patch({ [field]: value || null });
  const saveBool = (field: string) => async (value: string) => patch({ [field]: value === "true" });

  const uploadMedia = async (file: File | undefined, kind: "audio" | "cover") => {
    if (!file) return;
    setUploading(kind);
    try {
      const uploaded = await fileLibraryService.uploadFile(workspaceSlug, file);
      const url = fileLibraryService.getFileViewUrl(workspaceSlug, uploaded.asset_id);
      await patch(kind === "audio" ? { audio_url: url } : { cover_url: url });
      setToast({ type: TOAST_TYPE.SUCCESS, title: kind === "audio" ? "Audio adjuntado" : "Portada adjuntada" });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudo subir el archivo" });
    } finally {
      setUploading(null);
    }
  };

  const savePreviewRange = async () => {
    setIsSavingPreview(true);
    try {
      await patch({
        tiktok_preview_start_ms: Math.round(preview.start),
        tiktok_preview_end_ms: Math.round(preview.end),
        ...(preview.duration ? { duration_ms: Math.round(preview.duration) } : {}),
      });
    } finally {
      setIsSavingPreview(false);
    }
  };

  // _sync_relations replaces the full list when the key is present, so every
  // relation edit sends the complete mapped set
  const creditEntries = () =>
    track.credits.map((credit) => ({
      party_id: credit.party.id,
      role: credit.role,
      percentage: credit.percentage,
      publishing_share: credit.publishing_share,
      territory: credit.territory,
      notes: credit.notes,
    }));

  const addCredit = async (partyId: string) => {
    await patch({ credit_entries: [...creditEntries(), { party_id: partyId, role: newCreditRole }] });
    setIsAddingCredit(false);
  };

  const createParty = async (name: string) => {
    const created = await musicService.saveParty(workspaceSlug, { display_name: name, kind: "ARTIST" });
    onResourcesChanged();
    await addCredit(created.id);
  };

  const removeCredit = async (creditId: string) =>
    patch({
      credit_entries: track.credits
        .filter((credit) => credit.id !== creditId)
        .map((credit) => ({
          party_id: credit.party.id,
          role: credit.role,
          percentage: credit.percentage,
          publishing_share: credit.publishing_share,
          territory: credit.territory,
          notes: credit.notes,
        })),
    });

  const addGenre = async (genreId: string) => {
    await patch({ genre_ids: [...track.genre_details.map((genre) => genre.id), genreId] });
    setIsAddingGenre(false);
  };

  const createGenre = async (name: string) => {
    const created = await musicService.saveGenre(workspaceSlug, { name });
    onResourcesChanged();
    await addGenre(created.id);
  };

  const removeGenre = async (genreId: string) =>
    patch({ genre_ids: track.genre_details.filter((genre) => genre.id !== genreId).map((genre) => genre.id) });

  const releaseEntries = () =>
    track.release_details.map((release) => ({
      id: release.id,
      disc_number: release.disc_number,
      track_number: release.track_number,
    }));

  const addRelease = async (releaseId: string) => {
    await patch({ releases: [...releaseEntries(), { id: releaseId, disc_number: 1, track_number: releaseEntries().length + 1 }] });
    setIsAddingRelease(false);
  };

  const removeRelease = async (releaseId: string) =>
    patch({ releases: releaseEntries().filter((entry) => entry.id !== releaseId) });

  const distributionEntries = () =>
    track.distributions.map((distribution) => ({
      company_id: distribution.company.id,
      percentage: distribution.percentage,
      territory: distribution.territory,
      valid_from: distribution.valid_from,
      valid_to: distribution.valid_to,
    }));

  const addDistribution = async () => {
    if (!newDistribution.company_id) return;
    await patch({
      distribution_entries: [
        ...distributionEntries(),
        { company_id: newDistribution.company_id, percentage: newDistribution.percentage || null },
      ],
    });
    setNewDistribution({ company_id: "", percentage: "" });
    setIsAddingDistribution(false);
  };

  const removeDistribution = async (distributionId: string) =>
    patch({
      distribution_entries: track.distributions
        .filter((distribution) => distribution.id !== distributionId)
        .map((distribution) => ({
          company_id: distribution.company.id,
          percentage: distribution.percentage,
          territory: distribution.territory,
          valid_from: distribution.valid_from,
          valid_to: distribution.valid_to,
        })),
    });

  const exportOne = async () => {
    setIsExporting(true);
    try {
      await musicService.downloadReport(workspaceSlug, "filtered", "xlsx", { ids: track.id });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudo exportar" });
    } finally {
      setIsExporting(false);
    }
  };

  const copySummary = () => {
    const lines = [
      `Canción: ${track.title}${track.version ? ` (${track.version})` : ""}`,
      `ISRC: ${track.isrc || "—"}`,
      `Estado: ${track.status}`,
      `Lanzamiento: ${track.release_date || "—"}`,
      `Artistas: ${track.credits.filter((c) => c.role === "PRIMARY_ARTIST").map((c) => c.party.display_name).join(", ") || "—"}`,
      `Géneros: ${track.genre_details.map((genre) => genre.name).join(", ") || "—"}`,
      ...track.video_details.map((video) => `Video: ${video.video_url || video.title} (${video.release_date || "sin fecha"})`),
      ...track.links.map((link) => `${link.platform || link.kind}: ${link.url}`),
    ];
    void copyTextToClipboard(lines.join("\n")).then(() =>
      setToast({ type: TOAST_TYPE.SUCCESS, title: "Resumen copiado" })
    );
  };

  const statusOptions = (options?.track_statuses ?? []).map(([value, label]) => ({ value, label }));
  const kindOptions = (options?.track_kinds ?? []).map(([value, label]) => ({ value, label }));
  const roleOptions = (options?.credit_roles ?? []).map(([value, label]) => ({ value, label }));
  const roleLabel = (role: string) => roleOptions.find((option) => option.value === role)?.label ?? role;
  const iconButton = "flex size-7 items-center justify-center rounded-sm border border-subtle text-secondary hover:bg-layer-1-hover";

  const availableReleases = releases.filter(
    (release) => !track.release_details.some((linked) => linked.id === release.id)
  );

  return (
    <>
      {/* click-outside catcher (below the panel, above the page) */}
      <div className="absolute inset-0 z-20 bg-black/5" onClick={onClose} aria-hidden />
      <div className="absolute top-0 right-0 bottom-0 z-21 flex w-full flex-col overflow-hidden border-l border-subtle bg-surface-1 shadow-raised-200 md:w-xl">
        {/* header */}
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-accent-primary/10 text-accent-primary">
              {track.cover_url ? <img src={track.cover_url} alt="" className="size-full object-cover" /> : <Music2 className="size-4.5" />}
            </span>
            <div className="min-w-0">
              <EditableField value={track.title} onSave={saveField("title")} displayClassName="text-15 font-semibold" placeholder="Sin título" />
              <div className="px-1.5">
                <EditableField
                  value={track.status}
                  onSave={saveField("status")}
                  variant="select"
                  options={statusOptions}
                  format={(value) => statusOptions.find((option) => option.value === value)?.label ?? value}
                  displayClassName="min-h-5 w-fit rounded-full border border-subtle px-2 py-0 text-11 text-secondary"
                />
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={copySummary} className={iconButton} title="Copiar resumen">
              <Copy className="size-3.5" />
            </button>
            <button type="button" onClick={() => void exportOne()} className={iconButton} title="Exportar este registro (Excel)">
              {isExporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            </button>
            <button type="button" onClick={() => onEditFull(track)} className={iconButton} title="Edición completa">
              <Pencil className="size-3.5" />
            </button>
            <button type="button" onClick={onClose} className={iconButton} title="Cerrar (Esc)">
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {/* media */}
          <section className="space-y-2">
            <SectionTitle>Media</SectionTitle>
            <div className="flex gap-3">
              <input ref={coverInputRef} type="file" accept="image/*" hidden onChange={(e) => void uploadMedia(e.target.files?.[0], "cover")} />
              <input ref={audioInputRef} type="file" accept="audio/*" hidden onChange={(e) => void uploadMedia(e.target.files?.[0], "audio")} />
              <button
                type="button"
                onClick={() => coverInputRef.current?.click()}
                className="group/cover relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-subtle bg-layer-2"
                title={track.cover_url ? "Cambiar portada" : "Agregar portada"}
              >
                {uploading === "cover" ? (
                  <Loader2 className="size-4 animate-spin text-tertiary" />
                ) : track.cover_url ? (
                  <>
                    <img src={track.cover_url} alt="Portada" className="size-full object-cover" />
                    <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover/cover:opacity-100">
                      <ImagePlus className="size-4 text-white" />
                    </span>
                  </>
                ) : (
                  <span className="flex flex-col items-center gap-1 text-11 text-tertiary">
                    <ImagePlus className="size-4" /> Portada
                  </span>
                )}
              </button>
              <div className="min-w-0 flex-1 space-y-1.5">
                {track.audio_url ? (
                  <>
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption -- music master, no captions exist */}
                    <audio controls src={track.audio_url} className="h-9 w-full" />
                    <div className="flex items-center gap-2 text-11">
                      <a href={track.audio_url} download className="flex items-center gap-1 text-accent-primary hover:underline">
                        <Download className="size-3" /> Descargar audio
                      </a>
                      <button type="button" onClick={() => audioInputRef.current?.click()} className="flex items-center gap-1 text-tertiary hover:text-primary">
                        <Upload className="size-3" /> Reemplazar
                      </button>
                      {track.cover_url && (
                        <a href={track.cover_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-tertiary hover:text-primary">
                          <ExternalLink className="size-3" /> Ver portada
                        </a>
                      )}
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => audioInputRef.current?.click()}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-strong px-3 py-4 text-12 text-tertiary hover:bg-layer-1-hover"
                  >
                    {uploading === "audio" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                    Agregar audio
                  </button>
                )}
              </div>
            </div>
            {track.audio_url && (
              <div className="space-y-1.5 rounded-md border border-subtle p-2">
                <div className="flex items-center justify-between">
                  <p className="text-11 font-medium text-tertiary">TikTok preview</p>
                  {preview.dirty && (
                    <button
                      type="button"
                      onClick={() => void savePreviewRange()}
                      disabled={isSavingPreview}
                      className="flex items-center gap-1 rounded-sm bg-accent-primary px-2 py-0.5 text-11 font-medium text-on-color hover:opacity-90 disabled:opacity-60"
                    >
                      {isSavingPreview ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Guardar preview
                    </button>
                  )}
                </div>
                <AudioPreviewRange
                  src={track.audio_url}
                  durationMs={preview.duration || 30000}
                  startMs={preview.start}
                  endMs={preview.end}
                  onChange={(start, end) => setPreview((current) => ({ ...current, start, end, dirty: true }))}
                  onDurationChange={(duration) => setPreview((current) => ({ ...current, duration }))}
                />
              </div>
            )}
          </section>

          <section className="space-y-1">
            <SectionTitle>Identificadores</SectionTitle>
            <FieldRow label="ISRC" value={track.isrc} onSave={saveField("isrc")} mono />
            <FieldRow label="ISRC video" value={track.isrc_video} onSave={saveField("isrc_video")} mono />
            <FieldRow label="UPC" value={track.upc} onSave={saveField("upc")} mono />
            <FieldRow label="Catálogo" value={track.catalog} onSave={saveField("catalog")} mono />
          </section>

          <section className="space-y-1">
            <SectionTitle>Detalles</SectionTitle>
            <FieldRow label="Subtítulo" value={track.subtitle} onSave={saveField("subtitle")} />
            <FieldRow label="Versión" value={track.version} onSave={saveField("version")} />
            <FieldRow
              label="Tipo"
              value={track.kind}
              onSave={saveField("kind")}
              variant="select"
              options={kindOptions}
              format={(value) => kindOptions.find((option) => option.value === value)?.label ?? value}
            />
            <FieldRow label="Lanzamiento" value={track.release_date} onSave={saveField("release_date")} variant="date" />
            <FieldRow label="Lanzamiento original" value={track.original_release_date} onSave={saveField("original_release_date")} variant="date" />
            <FieldRow label="Fecha de grabación" value={track.recording_date} onSave={saveField("recording_date")} variant="date" />
            <FieldRow label="Idioma" value={track.language} onSave={saveField("language")} />
            <FieldRow label="País de grabación" value={track.country_of_recording} onSave={saveField("country_of_recording")} />
            <FieldRow
              label="Explícito"
              value={String(track.explicit)}
              onSave={saveBool("explicit")}
              variant="select"
              options={BOOL_OPTIONS}
              format={(value) => (value === "true" ? "Sí" : "No")}
            />
            <FieldRow
              label="Instrumental"
              value={String(track.instrumental)}
              onSave={saveBool("instrumental")}
              variant="select"
              options={BOOL_OPTIONS}
              format={(value) => (value === "true" ? "Sí" : "No")}
            />
            <FieldRow label="Formato digital" value={track.digital_format} onSave={saveField("digital_format")} />
            <FieldRow
              label="Duración"
              value={track.duration_ms ? `${Math.floor(track.duration_ms / 60000)}:${String(Math.floor((track.duration_ms % 60000) / 1000)).padStart(2, "0")}` : null}
            />
          </section>

          <section className="space-y-1.5">
            <SectionTitle action={<AddAction isOpen={isAddingCredit} onClick={() => setIsAddingCredit((open) => !open)} />}>
              Artistas y créditos
            </SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {track.credits.map((credit) => (
                <span key={credit.id} className="group/row flex items-center gap-1 rounded-full border border-subtle py-0.5 pr-1 pl-2.5 text-12">
                  <span className="font-medium">{credit.party.display_name}</span>
                  <span className="text-11 text-tertiary">· {roleLabel(credit.role)}</span>
                  <CopyButton value={credit.party.display_name} />
                  <button type="button" onClick={() => void removeCredit(credit.id)} className="rounded-full p-0.5 text-tertiary hover:text-danger-primary" title="Quitar crédito">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {track.credits.length === 0 && <p className="px-1.5 text-12 text-placeholder">Sin créditos</p>}
            </div>
            {isAddingCredit && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-subtle p-2">
                <SearchableSelect
                  className="min-w-44 flex-1"
                  options={parties.map((party) => ({ value: party.id, label: party.display_name }))}
                  onSelect={(partyId) => void addCredit(partyId)}
                  onCreate={(name) => void createParty(name)}
                  placeholder="Buscar o crear artista…"
                />
                <SearchableSelect
                  className="w-44"
                  options={roleOptions}
                  value={newCreditRole}
                  onSelect={setNewCreditRole}
                  placeholder="Rol…"
                />
              </div>
            )}
          </section>

          <section className="space-y-1.5">
            <SectionTitle action={<AddAction isOpen={isAddingGenre} onClick={() => setIsAddingGenre((open) => !open)} />}>Géneros</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {track.genre_details.map((genre) => (
                <span key={genre.id} className="flex items-center gap-1 rounded-full border border-subtle py-0.5 pr-1 pl-2.5 text-12">
                  {genre.name}
                  <button type="button" onClick={() => void removeGenre(genre.id)} className="rounded-full p-0.5 text-tertiary hover:text-danger-primary">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {track.genre_details.length === 0 && <p className="px-1.5 text-12 text-placeholder">Sin géneros</p>}
            </div>
            {isAddingGenre && (
              <SearchableSelect
                options={genres
                  .filter((genre) => !track.genre_details.some((linked) => linked.id === genre.id))
                  .map((genre) => ({ value: genre.id, label: genre.name }))}
                onSelect={(genreId) => void addGenre(genreId)}
                onCreate={(name) => void createGenre(name)}
                placeholder="Buscar o crear género…"
              />
            )}
          </section>

          <section className="space-y-1.5">
            <SectionTitle action={<AddAction isOpen={isAddingRelease} onClick={() => setIsAddingRelease((open) => !open)} />}>Releases</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {track.release_details.map((release) => (
                <span key={release.id} className="group/row flex items-center gap-1 rounded-full border border-subtle py-0.5 pr-1 pl-2.5 text-12">
                  {release.title}
                  {release.release_date && <span className="text-11 text-tertiary">· {release.release_date}</span>}
                  <CopyButton value={release.title} />
                  <button type="button" onClick={() => void removeRelease(release.id)} className="rounded-full p-0.5 text-tertiary hover:text-danger-primary" title="Quitar del release">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {track.release_details.length === 0 && <p className="px-1.5 text-12 text-placeholder">Sin releases</p>}
            </div>
            {isAddingRelease && (
              <SearchableSelect
                options={availableReleases.map((release) => ({
                  value: release.id,
                  label: release.title,
                  hint: release.release_date ?? undefined,
                }))}
                onSelect={(releaseId) => void addRelease(releaseId)}
                placeholder="Buscar release…"
              />
            )}
          </section>

          <section className="space-y-1.5">
            <SectionTitle action={<AddAction isOpen={isAddingDistribution} onClick={() => setIsAddingDistribution((open) => !open)} />}>
              Distribución y compañías
            </SectionTitle>
            {track.distributions.map((distribution) => (
              <div key={distribution.id} className="group/row flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-12 hover:bg-layer-1-hover">
                <span className="min-w-0 flex-1 truncate">
                  {distribution.company.name}
                  <span className="ml-1 text-11 text-tertiary">({distribution.company.kind.toLowerCase().replace("_", " ")})</span>
                </span>
                <span className="shrink-0 text-tertiary">{distribution.percentage ? `${distribution.percentage}%` : "—"}</span>
                <CopyButton value={distribution.company.name} />
                <button type="button" onClick={() => void removeDistribution(distribution.id)} className="rounded-sm p-0.5 text-tertiary hover:text-danger-primary">
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {track.distributions.length === 0 && <p className="px-1.5 text-12 text-placeholder">Sin distribuciones</p>}
            {isAddingDistribution && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-subtle p-2">
                <SearchableSelect
                  className="min-w-44 flex-1"
                  options={companies.map((company) => ({ value: company.id, label: company.name, hint: company.kind }))}
                  value={newDistribution.company_id}
                  onSelect={(companyId) => setNewDistribution((current) => ({ ...current, company_id: companyId }))}
                  placeholder="Buscar compañía…"
                />
                <input
                  value={newDistribution.percentage}
                  onChange={(event) => setNewDistribution((current) => ({ ...current, percentage: event.target.value }))}
                  placeholder="%"
                  className="w-16 rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                />
                <button
                  type="button"
                  onClick={() => void addDistribution()}
                  disabled={!newDistribution.company_id}
                  className="rounded-sm bg-accent-primary px-2 py-1 text-12 font-medium text-on-color hover:opacity-90 disabled:opacity-50"
                >
                  Agregar
                </button>
              </div>
            )}
          </section>

          <section className="space-y-1">
            <SectionTitle>Porcentajes</SectionTitle>
            <FieldRow label="Agregadora %" value={track.aggregator_percentage} onSave={saveField("aggregator_percentage")} />
            <FieldRow label="Distribuidora %" value={track.distributor_percentage} onSave={saveField("distributor_percentage")} />
            <FieldRow label="Sello %" value={track.record_label_percentage} onSave={saveField("record_label_percentage")} />
            <FieldRow label="Artista %" value={track.artist_percentage} onSave={saveField("artist_percentage")} />
            <FieldRow label="Escritor %" value={track.writer_percentage} onSave={saveField("writer_percentage")} />
          </section>

          {(track.video_details.length > 0 || track.links.length > 0) && (
            <section className="space-y-1">
              <SectionTitle>Videos y links</SectionTitle>
              {track.video_details.map((video) => (
                <div key={video.id} className="group/row flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-12 hover:bg-layer-1-hover">
                  <Video className="size-3.5 shrink-0 text-tertiary" />
                  <span className="min-w-0 flex-1 truncate">
                    {video.title} {video.release_date ? <span className="text-tertiary">· {video.release_date}</span> : null}
                    {video.isrc ? <span className="ml-1 font-mono text-11 text-tertiary">{video.isrc}</span> : null}
                  </span>
                  {video.video_url && (
                    <a href={video.video_url} target="_blank" rel="noreferrer" className="shrink-0 p-1 text-tertiary hover:text-accent-primary">
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                  <CopyButton value={video.video_url || video.isrc} label="video" />
                </div>
              ))}
              {track.links.map((link) => (
                <div key={link.id} className="group/row flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-12 hover:bg-layer-1-hover">
                  <ExternalLink className="size-3.5 shrink-0 text-tertiary" />
                  <span className="w-20 shrink-0 text-11 text-tertiary">{link.platform || link.kind}</span>
                  <a href={link.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-accent-primary hover:underline">
                    {link.url}
                  </a>
                  <CopyButton value={link.url} label="link" />
                </div>
              ))}
            </section>
          )}

          <section className="space-y-1">
            <SectionTitle>Derechos y textos</SectionTitle>
            <FieldRow label="Ownership" value={track.ownership} onSave={saveField("ownership")} variant="textarea" />
            <FieldRow label="Obligaciones US" value={track.us_publishing_obligations} onSave={saveField("us_publishing_obligations")} variant="textarea" />
            <FieldRow label="Recoupment" value={track.recoupment} onSave={saveField("recoupment")} variant="textarea" />
            <FieldRow label="P line" value={track.p_line} onSave={saveField("p_line")} />
            <FieldRow label="Letra" value={track.lyrics} onSave={saveField("lyrics")} variant="textarea" />
          </section>
        </div>
      </div>
    </>
  );
}
