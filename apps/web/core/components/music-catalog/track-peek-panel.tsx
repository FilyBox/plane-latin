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
  FileSpreadsheet,
  ExternalLink,
  ImagePlus,
  Link as LinkIcon,
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
import type { TPreviewFile } from "../file-library/file-preview-modal";
import { FilePreviewModal } from "../file-library/file-preview-modal";
// local imports
import { AudioPreviewRange } from "./audio-preview-range";
import { EditableField } from "./editable-field";
import { MusicResourcePickerModal } from "./resource-picker-modal";
import { SearchableSelect } from "./searchable-select";

type Props = {
  workspaceSlug: string;
  /** Undefined = create mode: edits accumulate locally until "Crear canción" */
  track?: TMusicTrack;
  options?: TMusicCatalogOptions;
  parties: TMusicParty[];
  genres: TMusicGenre[];
  companies: TMusicCompany[];
  releases: TMusicRelease[];
  /** While the full editor (or another sheet) is open, Esc must not close us */
  suspendClose?: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Create mode: the record was persisted — switch the panel to it */
  onCreated: (track: TMusicTrack) => void;
  onResourcesChanged: () => void;
};

/** Blank draft for create mode (relations arrive after the first save) */
const EMPTY_TRACK: TMusicTrack = {
  id: "",
  title: "",
  subtitle: "",
  version: "",
  kind: "AUDIO",
  status: "DRAFT",
  isrc: "",
  isrc_video: "",
  upc: "",
  catalog: "",
  duration_ms: null,
  country_of_recording: "",
  language: "",
  recording_date: null,
  original_release_date: null,
  release_date: null,
  explicit: false,
  instrumental: false,
  ownership: "",
  us_publishing_obligations: "",
  recoupment: "",
  p_line: "",
  digital_format: "",
  lyrics: "",
  audio_url: "",
  cover_url: "",
  aggregator_percentage: null,
  distributor_percentage: null,
  record_label_percentage: null,
  artist_percentage: null,
  writer_percentage: null,
  tiktok_preview_start_ms: null,
  tiktok_preview_end_ms: null,
  metadata: {},
  credits: [],
  genre_details: [],
  release_details: [],
  links: [],
  distributions: [],
  video_details: [],
};

/** Scalar keys copied into the create payload (relations are post-create) */
const CREATE_FIELDS: (keyof TMusicTrack)[] = [
  "title",
  "subtitle",
  "version",
  "kind",
  "status",
  "isrc",
  "isrc_video",
  "upc",
  "catalog",
  "duration_ms",
  "country_of_recording",
  "language",
  "recording_date",
  "original_release_date",
  "release_date",
  "explicit",
  "instrumental",
  "ownership",
  "us_publishing_obligations",
  "recoupment",
  "p_line",
  "digital_format",
  "lyrics",
  "audio_url",
  "cover_url",
  "aggregator_percentage",
  "distributor_percentage",
  "record_label_percentage",
  "artist_percentage",
  "writer_percentage",
  "tiktok_preview_start_ms",
  "tiktok_preview_end_ms",
];

const BOOL_OPTIONS = [
  { value: "true", label: "Sí" },
  { value: "false", label: "No" },
];

const LINK_KINDS = [
  { value: "STREAMING", label: "Streaming" },
  { value: "SOCIAL", label: "Redes" },
  { value: "STORE", label: "Tienda" },
  { value: "OTHER", label: "Otro" },
];

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

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
          return undefined;
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
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-11 text-accent-primary hover:underline"
    >
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
    onSaved,
    onCreated,
    onResourcesChanged,
  } = props;
  // The panel owns the freshest copy: PATCH responses replace it in place
  const [track, setTrack] = useState<TMusicTrack>(initialTrack ?? EMPTY_TRACK);
  const isCreate = !track.id;
  const [isCreating, setIsCreating] = useState(false);
  const [isAddingCredit, setIsAddingCredit] = useState(false);
  const [newCreditRole, setNewCreditRole] = useState("PRIMARY_ARTIST");
  const [newCreditPercentage, setNewCreditPercentage] = useState("");
  const [creditPicker, setCreditPicker] = useState<{ creditId: string }>();
  const [editingGenreId, setEditingGenreId] = useState<string | null>(null);
  const [genreDraft, setGenreDraft] = useState("");
  const [editingReleaseId, setEditingReleaseId] = useState<string | null>(null);
  const [releaseDraft, setReleaseDraft] = useState({
    title: "",
    release_type: "SINGLE",
    status: "DRAFT",
    release_date: "",
  });
  const [isAddingGenre, setIsAddingGenre] = useState(false);
  const [isAddingRelease, setIsAddingRelease] = useState(false);
  const [isAddingDistribution, setIsAddingDistribution] = useState(false);
  const [newDistribution, setNewDistribution] = useState({ company_id: "", percentage: "" });
  const [isAddingVideo, setIsAddingVideo] = useState(false);
  const [newVideo, setNewVideo] = useState({
    title: "",
    video_url: "",
    release_date: "",
    isrc: "",
    upc: "",
    catalog: "",
  });
  const [isAddingLink, setIsAddingLink] = useState(false);
  const [newLink, setNewLink] = useState({ kind: "STREAMING", platform: "", url: "", isrc: "" });
  const [editingVideoId, setEditingVideoId] = useState<string | null>(null);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [previewImportFile, setPreviewImportFile] = useState<TPreviewFile | null>(null);
  const [uploading, setUploading] = useState<"audio" | "cover" | null>(null);
  const [preview, setPreview] = useState({ start: 0, end: 0, duration: 0, dirty: false });
  const [isSavingPreview, setIsSavingPreview] = useState(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setTrack(initialTrack ?? EMPTY_TRACK), [initialTrack]);
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
    // Create mode: nothing persisted yet — accumulate into the local draft
    if (isCreate) {
      setTrack((current) => ({ ...current, ...payload }) as TMusicTrack);
      return;
    }
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

  const createRecord = async () => {
    if (!track.title.trim()) return;
    setIsCreating(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const field of CREATE_FIELDS) {
        const value = track[field];
        if (value !== null && value !== "" && value !== undefined) payload[field] = value;
      }
      const created = await musicService.saveTrack(workspaceSlug, payload);
      setTrack(created);
      onCreated(created);
      onSaved();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "Canción creada",
        message: "Ahora puedes agregar créditos, géneros y releases.",
      });
    } catch (error: unknown) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "No se pudo crear la canción",
        message: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsCreating(false);
    }
  };

  const saveField = (field: string) => async (value: string) => patch({ [field]: value || null });
  const saveBool = (field: string) => async (value: string) => patch({ [field]: value === "true" });

  /** Accepts "3:16", "1:02:45" or plain seconds; empty clears the duration */
  const saveDuration = async (value: string) => {
    const raw = value.trim();
    if (!raw) return patch({ duration_ms: null });
    let ms: number | null = null;
    const parts = raw.split(":");
    if (parts.length === 2 || parts.length === 3) {
      const nums = parts.map((part) => Number(part.trim()));
      if (nums.every((num) => Number.isFinite(num) && num >= 0)) {
        ms =
          parts.length === 2
            ? (nums[0] * 60 + nums[1]) * 1000
            : (nums[0] * 3600 + nums[1] * 60 + nums[2]) * 1000;
      }
    } else if (/^\d+$/.test(raw)) {
      ms = Number(raw) * 1000;
    }
    if (ms === null) {
      setToast({ type: TOAST_TYPE.ERROR, title: "Duración inválida", message: "Usa m:ss (ej. 3:16) o segundos" });
      return;
    }
    return patch({ duration_ms: Math.round(ms) });
  };

  const uploadMedia = async (file: File | undefined, kind: "audio" | "cover") => {
    if (!file) return;
    setUploading(kind);
    try {
      const uploaded = await fileLibraryService.uploadFile(workspaceSlug, file, undefined, undefined, "music");
      const url = fileLibraryService.getFileViewUrl(workspaceSlug, uploaded.asset_id, "music");
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
    await patch({
      credit_entries: [
        ...creditEntries(),
        { party_id: partyId, role: newCreditRole, percentage: newCreditPercentage || null },
      ],
    });
    setIsAddingCredit(false);
    setNewCreditPercentage("");
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
    await patch({
      releases: [...releaseEntries(), { id: releaseId, disc_number: 1, track_number: releaseEntries().length + 1 }],
    });
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

  // Editing one credit re-sends the full mapped set (_sync_relations replaces)
  const updateCredit = async (
    creditId: string,
    changes: Partial<{ party_id: string; role: string; percentage: string; publishing_share: string }>
  ) =>
    patch({
      credit_entries: track.credits.map((credit) =>
        credit.id === creditId
          ? {
              party_id: changes.party_id ?? credit.party.id,
              role: changes.role ?? credit.role,
              percentage: (changes.percentage ?? credit.percentage) || null,
              publishing_share: (changes.publishing_share ?? credit.publishing_share) || null,
              territory: credit.territory,
              notes: credit.notes,
            }
          : {
              party_id: credit.party.id,
              role: credit.role,
              percentage: credit.percentage,
              publishing_share: credit.publishing_share,
              territory: credit.territory,
              notes: credit.notes,
            }
      ),
    });

  // ── Videos (child tracks): enlace + fecha + ISRC/UPC/catálogo ──────
  const videoEntries = () =>
    track.video_details.map((video) => ({
      id: video.id,
      title: video.title,
      status: video.status,
      isrc: video.isrc,
      upc: video.upc,
      catalog: video.catalog,
      release_date: video.release_date,
      duration_ms: video.duration_ms,
      video_url: video.video_url,
    }));

  const addVideo = async () => {
    if (newVideo.video_url && !isHttpUrl(newVideo.video_url)) {
      setToast({ type: TOAST_TYPE.ERROR, title: "El enlace del video debe ser una URL válida" });
      return;
    }
    await patch({
      video_entries: [
        ...videoEntries(),
        {
          title: newVideo.title || track.title || "Video",
          status: "DRAFT",
          isrc: newVideo.isrc,
          upc: newVideo.upc,
          catalog: newVideo.catalog,
          release_date: newVideo.release_date || null,
          video_url: newVideo.video_url,
        },
      ],
    });
    setIsAddingVideo(false);
    setNewVideo({ title: "", video_url: "", release_date: "", isrc: "", upc: "", catalog: "" });
  };

  const updateVideo = async (
    videoId: string,
    changes: Partial<{
      title: string;
      isrc: string;
      upc: string;
      catalog: string;
      release_date: string;
      video_url: string;
    }>
  ) =>
    patch({
      video_entries: videoEntries().map((entry) =>
        entry.id === videoId
          ? {
              id: entry.id,
              title: changes.title ?? entry.title,
              status: entry.status,
              isrc: changes.isrc ?? entry.isrc,
              upc: changes.upc ?? entry.upc,
              catalog: changes.catalog ?? entry.catalog,
              release_date: changes.release_date ?? entry.release_date,
              duration_ms: entry.duration_ms,
              video_url: changes.video_url ?? entry.video_url,
            }
          : entry
      ),
    });

  const removeVideo = async (videoId: string) =>
    patch({ video_entries: videoEntries().filter((entry) => entry.id !== videoId) });

  // ── Links (streaming / social / store): plataforma + URL ──────────
  const linkEntries = () =>
    track.links.map((link) => ({
      kind: link.kind,
      platform: link.platform,
      name: link.name,
      url: link.url,
      isrc: link.isrc,
    }));

  const addLink = async () => {
    if (!newLink.url.trim()) return;
    if (!isHttpUrl(newLink.url)) {
      setToast({ type: TOAST_TYPE.ERROR, title: "El enlace debe ser una URL válida (http o https)" });
      return;
    }
    await patch({ link_entries: [...linkEntries(), { ...newLink, name: newLink.platform || newLink.kind }] });
    setNewLink({ kind: "STREAMING", platform: "", url: "", isrc: "" });
    setIsAddingLink(false);
  };

  const removeLink = async (linkId: string) =>
    patch({
      link_entries: track.links
        .filter((link) => link.id !== linkId)
        .map((link) => ({ kind: link.kind, platform: link.platform, name: link.name, url: link.url, isrc: link.isrc })),
    });

  const updateLink = async (
    linkId: string,
    changes: Partial<{ kind: string; platform: string; name: string; url: string; isrc: string }>
  ) =>
    patch({
      link_entries: track.links.map((link) =>
        link.id === linkId
          ? {
              kind: changes.kind ?? link.kind,
              platform: changes.platform ?? link.platform,
              name: changes.name ?? link.name,
              url: changes.url ?? link.url,
              isrc: changes.isrc ?? link.isrc,
            }
          : { kind: link.kind, platform: link.platform, name: link.name, url: link.url, isrc: link.isrc }
      ),
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
      `Artistas: ${
        track.credits
          .filter((c) => c.role === "PRIMARY_ARTIST")
          .map((c) => c.party.display_name)
          .join(", ") || "—"
      }`,
      `Géneros: ${track.genre_details.map((genre) => genre.name).join(", ") || "—"}`,
      ...track.video_details.map(
        (video) => `Video: ${video.video_url || video.title} (${video.release_date || "sin fecha"})`
      ),
      ...track.links.map((link) => `${link.platform || link.kind}: ${link.url}`),
    ];
    void copyTextToClipboard(lines.join("\n")).then(() => {
      setToast({ type: TOAST_TYPE.SUCCESS, title: "Resumen copiado" });
      return undefined;
    });
  };

  const statusOptions = (options?.track_statuses ?? []).map(([value, label]) => ({ value, label }));
  const kindOptions = (options?.track_kinds ?? []).map(([value, label]) => ({ value, label }));
  const roleOptions = (options?.credit_roles ?? []).map(([value, label]) => ({ value, label }));
  const iconButton =
    "flex size-7 items-center justify-center rounded-sm border border-subtle text-secondary hover:bg-layer-1-hover";

  const availableReleases = releases.filter(
    (release) => !track.release_details.some((linked) => linked.id === release.id)
  );

  const saveGenreInline = async (genreId: string) => {
    if (!genreDraft.trim()) return;
    await musicService.saveGenre(workspaceSlug, { id: genreId, name: genreDraft.trim() });
    setTrack((current) => ({
      ...current,
      genre_details: current.genre_details.map((genre) =>
        genre.id === genreId ? { ...genre, name: genreDraft.trim() } : genre
      ),
    }));
    setEditingGenreId(null);
    onResourcesChanged();
  };

  const saveReleaseInline = async (releaseId: string) => {
    if (!releaseDraft.title.trim()) return;
    await musicService.saveRelease(workspaceSlug, { id: releaseId, ...releaseDraft });
    setTrack((current) => ({
      ...current,
      release_details: current.release_details.map((release) =>
        release.id === releaseId
          ? {
              ...release,
              title: releaseDraft.title.trim(),
              release_type: releaseDraft.release_type,
              release_date: releaseDraft.release_date || null,
            }
          : release
      ),
    }));
    setEditingReleaseId(null);
    onResourcesChanged();
  };

  return (
    <>
      {/* click-outside catcher (below the panel, above the page) — transparent
          so the underlying catalog stays fully visible, not dimmed */}
      <div className="absolute inset-0 z-20 bg-transparent" onClick={onClose} aria-hidden />
      <div className="absolute top-0 right-0 bottom-0 z-21 flex w-full flex-col overflow-hidden border-l border-subtle bg-surface-1 shadow-raised-200 md:w-xl">
        {/* header — the cover IS the icon spot: click to add/replace it */}
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => void uploadMedia(e.target.files?.[0], "cover")}
            />
            <button
              type="button"
              onClick={() => coverInputRef.current?.click()}
              className="group/cover relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-subtle bg-accent-primary/10 text-accent-primary"
              title={track.cover_url ? "Cambiar portada" : "Agregar portada"}
            >
              {uploading === "cover" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : track.cover_url ? (
                <img src={track.cover_url} alt="Portada" className="size-full object-cover" />
              ) : (
                <Music2 className="size-5" />
              )}
              <span
                className={cn(
                  "absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover/cover:opacity-100",
                  uploading === "cover" && "hidden"
                )}
              >
                <ImagePlus className="size-4 text-white" />
              </span>
            </button>
            <div className="min-w-0">
              <EditableField
                value={track.title}
                onSave={saveField("title")}
                displayClassName="text-15 font-semibold"
                placeholder={isCreate ? "Título de la canción *" : "Sin título"}
              />
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
            {!isCreate && (
              <>
                <button type="button" onClick={copySummary} className={iconButton} title="Copiar resumen">
                  <Copy className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void exportOne()}
                  className={iconButton}
                  title="Exportar este registro (Excel)"
                >
                  {isExporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                </button>
              </>
            )}
            <button type="button" onClick={onClose} className={iconButton} title="Cerrar (Esc)">
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {(track.import_sources?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-11 text-tertiary">Importado de</span>
              {track.import_sources?.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  disabled={!source.asset_id}
                  title={`${source.action === "CREATED" ? "Creado" : source.action === "UPDATED" ? "Actualizado" : "Conservado"}${source.row_number ? ` · fila ${source.row_number}` : ""} · ${new Date(source.imported_at).toLocaleDateString()}`}
                  onClick={() =>
                    source.asset_id &&
                    setPreviewImportFile({ assetId: source.asset_id, name: source.name, contentType: "" })
                  }
                  className="flex items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-11 text-secondary hover:border-accent-strong hover:text-accent-primary disabled:cursor-default disabled:hover:border-subtle disabled:hover:text-secondary"
                >
                  <FileSpreadsheet className="size-3" />
                  <span className="max-w-40 truncate">{source.name}</span>
                </button>
              ))}
            </div>
          )}
          {/* media: audio + TikTok preview (the cover lives in the header icon) */}
          <section className="space-y-2">
            <SectionTitle
              action={
                track.cover_url ? (
                  <a
                    href={track.cover_url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-11 text-tertiary hover:text-primary"
                  >
                    <ExternalLink className="size-3" /> Ver portada
                  </a>
                ) : undefined
              }
            >
              Audio
            </SectionTitle>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*"
              hidden
              onChange={(e) => void uploadMedia(e.target.files?.[0], "audio")}
            />
            {track.audio_url ? (
              <div className="space-y-2 rounded-md border border-subtle p-2.5">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption -- music master, no captions exist */}
                <audio controls src={track.audio_url} className="h-9 w-full" />
                <div className="flex items-center justify-center gap-4 text-11">
                  <a
                    href={track.audio_url}
                    download
                    className="flex items-center gap-1 text-accent-primary hover:underline"
                  >
                    <Download className="size-3" /> Descargar audio
                  </a>
                  <button
                    type="button"
                    onClick={() => audioInputRef.current?.click()}
                    className="flex items-center gap-1 text-tertiary hover:text-primary"
                  >
                    {uploading === "audio" ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Upload className="size-3" />
                    )}{" "}
                    Reemplazar
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => audioInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-strong px-3 py-5 text-12 text-tertiary hover:bg-layer-1-hover"
              >
                {uploading === "audio" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                Agregar audio
              </button>
            )}
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
                      {isSavingPreview ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}{" "}
                      Guardar preview
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
            <FieldRow
              label="Lanzamiento"
              value={track.release_date}
              onSave={saveField("release_date")}
              variant="date"
            />
            <FieldRow
              label="Lanzamiento original"
              value={track.original_release_date}
              onSave={saveField("original_release_date")}
              variant="date"
            />
            <FieldRow
              label="Fecha de grabación"
              value={track.recording_date}
              onSave={saveField("recording_date")}
              variant="date"
            />
            <FieldRow label="Idioma" value={track.language} onSave={saveField("language")} />
            <FieldRow
              label="País de grabación"
              value={track.country_of_recording}
              onSave={saveField("country_of_recording")}
            />
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
              value={
                track.duration_ms
                  ? `${Math.floor(track.duration_ms / 60000)}:${String(Math.floor((track.duration_ms % 60000) / 1000)).padStart(2, "0")}`
                  : null
              }
              onSave={saveDuration}
            />
          </section>

          {isCreate && (
            <p className="rounded-md border border-subtle bg-layer-2 px-3 py-2 text-12 text-tertiary">
              Los créditos, géneros, releases y distribuciones se agregan después de crear la canción.
            </p>
          )}

          {!isCreate && (
            <>
              <section className="space-y-1.5">
                <SectionTitle
                  action={<AddAction isOpen={isAddingCredit} onClick={() => setIsAddingCredit((open) => !open)} />}
                >
                  Artistas y créditos
                </SectionTitle>
                <div className="space-y-1">
                  {track.credits.map((credit) => (
                    <div
                      key={credit.id}
                      className="group/row flex items-center gap-1.5 rounded-sm px-1.5 py-1 hover:bg-layer-1-hover"
                    >
                      <button
                        type="button"
                        onClick={() => setCreditPicker({ creditId: credit.id })}
                        className="min-w-0 flex-1 truncate text-left text-12 font-medium hover:text-accent-primary hover:underline"
                        title="Edit or replace this person"
                      >
                        {credit.party.display_name}
                      </button>
                      {/* role editable inline */}
                      <select
                        value={credit.role}
                        onChange={(event) => void updateCredit(credit.id, { role: event.target.value })}
                        className="w-32 shrink-0 rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-11 text-tertiary hover:border-subtle"
                      >
                        {roleOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      {/* rights % editable inline */}
                      <input
                        type="number"
                        min="0"
                        max="100"
                        defaultValue={credit.percentage ?? ""}
                        onBlur={(event) => {
                          if ((event.target.value || "") !== (credit.percentage ?? ""))
                            void updateCredit(credit.id, { percentage: event.target.value });
                        }}
                        placeholder="%"
                        className="w-14 shrink-0 rounded-sm border border-subtle bg-transparent px-1 py-0.5 text-right text-11"
                        title="Derechos %"
                      />
                      <CopyButton value={credit.party.display_name} />
                      <button
                        type="button"
                        onClick={() => void removeCredit(credit.id)}
                        className="shrink-0 rounded-sm p-0.5 text-tertiary hover:text-danger-primary"
                        title="Quitar crédito"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
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
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.0001"
                      value={newCreditPercentage}
                      onChange={(event) => setNewCreditPercentage(event.target.value)}
                      placeholder="Derechos %"
                      className="w-28 rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                    />
                    <p className="w-full text-10 text-tertiary">
                      El porcentaje es opcional y queda registrado al agregar el crédito.
                    </p>
                  </div>
                )}
              </section>

              <section className="space-y-1.5">
                <SectionTitle
                  action={
                    <div className="flex items-center gap-2">
                      <AddAction isOpen={isAddingGenre} onClick={() => setIsAddingGenre((open) => !open)} />
                    </div>
                  }
                >
                  Géneros
                </SectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {track.genre_details.map((genre) => (
                    <span
                      key={genre.id}
                      className="flex items-center gap-1 rounded-full border border-subtle py-0.5 pr-1 pl-2.5 text-12"
                    >
                      {editingGenreId === genre.id ? (
                        <form
                          className="flex items-center gap-1"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveGenreInline(genre.id);
                          }}
                        >
                          <input
                            value={genreDraft}
                            onChange={(event) => setGenreDraft(event.target.value)}
                            className="w-28 bg-transparent text-12 outline-none"
                          />
                          <button type="submit" className="text-accent-primary" title="Guardar género">
                            <Check className="size-3" />
                          </button>
                          <button type="button" onClick={() => setEditingGenreId(null)} title="Cancelar">
                            <X className="size-3" />
                          </button>
                        </form>
                      ) : (
                        <>
                          <span>{genre.name}</span>
                          <CopyButton value={genre.name} label="género" />
                          <button
                            type="button"
                            onClick={() => {
                              setGenreDraft(genre.name);
                              setEditingGenreId(genre.id);
                            }}
                            className="rounded-full p-0.5 text-tertiary hover:text-primary"
                            title="Editar género"
                          >
                            <Pencil className="size-3" />
                          </button>
                        </>
                      )}
                      {editingGenreId !== genre.id && (
                        <button
                          type="button"
                          onClick={() => void removeGenre(genre.id)}
                          className="rounded-full p-0.5 text-tertiary hover:text-danger-primary"
                        >
                          <X className="size-3" />
                        </button>
                      )}
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
                <SectionTitle
                  action={
                    <div className="flex items-center gap-2">
                      <AddAction isOpen={isAddingRelease} onClick={() => setIsAddingRelease((open) => !open)} />
                    </div>
                  }
                >
                  Releases
                </SectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {track.release_details.map((release) => (
                    <span
                      key={release.id}
                      className="group/row flex items-center gap-1 rounded-full border border-subtle py-0.5 pr-1 pl-2.5 text-12"
                    >
                      {editingReleaseId === release.id ? (
                        <form
                          className="flex flex-wrap items-center gap-1"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveReleaseInline(release.id);
                          }}
                        >
                          <input
                            value={releaseDraft.title}
                            onChange={(event) =>
                              setReleaseDraft((current) => ({ ...current, title: event.target.value }))
                            }
                            className="w-28 bg-transparent text-12 outline-none"
                          />
                          <select
                            value={releaseDraft.release_type}
                            onChange={(event) =>
                              setReleaseDraft((current) => ({ ...current, release_type: event.target.value }))
                            }
                            className="max-w-20 bg-transparent text-10 text-tertiary outline-none"
                          >
                            {options?.release_types.map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                          <input
                            type="date"
                            value={releaseDraft.release_date}
                            onChange={(event) =>
                              setReleaseDraft((current) => ({ ...current, release_date: event.target.value }))
                            }
                            className="w-28 bg-transparent text-10 text-tertiary outline-none"
                          />
                          <button type="submit" className="text-accent-primary" title="Guardar release">
                            <Check className="size-3" />
                          </button>
                          <button type="button" onClick={() => setEditingReleaseId(null)} title="Cancelar">
                            <X className="size-3" />
                          </button>
                        </form>
                      ) : (
                        <>
                          <span>{release.title}</span>
                          <button
                            type="button"
                            onClick={() => {
                              setReleaseDraft({
                                title: release.title,
                                release_type: release.release_type,
                                status: "DRAFT",
                                release_date: release.release_date ?? "",
                              });
                              setEditingReleaseId(release.id);
                            }}
                            className="rounded-full p-0.5 text-tertiary hover:text-primary"
                            title="Editar release"
                          >
                            <Pencil className="size-3" />
                          </button>
                        </>
                      )}
                      {editingReleaseId !== release.id && (
                        <>
                          {release.release_date && (
                            <span className="text-11 text-tertiary">· {release.release_date}</span>
                          )}
                          <CopyButton value={release.title} />
                          <button
                            type="button"
                            onClick={() => void removeRelease(release.id)}
                            className="rounded-full p-0.5 text-tertiary hover:text-danger-primary"
                            title="Quitar del release"
                          >
                            <X className="size-3" />
                          </button>
                        </>
                      )}
                    </span>
                  ))}
                  {track.release_details.length === 0 && (
                    <p className="px-1.5 text-12 text-placeholder">Sin releases</p>
                  )}
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
                <SectionTitle
                  action={
                    <AddAction isOpen={isAddingDistribution} onClick={() => setIsAddingDistribution((open) => !open)} />
                  }
                >
                  Distribución y compañías
                </SectionTitle>
                {track.distributions.map((distribution) => (
                  <div
                    key={distribution.id}
                    className="group/row flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-12 hover:bg-layer-1-hover"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {distribution.company.name}
                      <span className="ml-1 text-11 text-tertiary">
                        ({distribution.company.kind.toLowerCase().replace("_", " ")})
                      </span>
                    </span>
                    <span className="shrink-0 text-tertiary">
                      {distribution.percentage ? `${distribution.percentage}%` : "—"}
                    </span>
                    <CopyButton value={distribution.company.name} />
                    <button
                      type="button"
                      onClick={() => void removeDistribution(distribution.id)}
                      className="rounded-sm p-0.5 text-tertiary hover:text-danger-primary"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
                {track.distributions.length === 0 && (
                  <p className="px-1.5 text-12 text-placeholder">Sin distribuciones</p>
                )}
                {isAddingDistribution && (
                  <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-subtle p-2">
                    <SearchableSelect
                      className="min-w-44 flex-1"
                      options={companies.map((company) => ({
                        value: company.id,
                        label: company.name,
                        hint: company.kind,
                      }))}
                      value={newDistribution.company_id}
                      onSelect={(companyId) => setNewDistribution((current) => ({ ...current, company_id: companyId }))}
                      placeholder="Buscar compañía…"
                    />
                    <input
                      value={newDistribution.percentage}
                      onChange={(event) =>
                        setNewDistribution((current) => ({ ...current, percentage: event.target.value }))
                      }
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
            </>
          )}

          <section className="space-y-1">
            <SectionTitle>Porcentajes</SectionTitle>
            <FieldRow
              label="Agregadora %"
              value={track.aggregator_percentage}
              onSave={saveField("aggregator_percentage")}
            />
            <FieldRow
              label="Distribuidora %"
              value={track.distributor_percentage}
              onSave={saveField("distributor_percentage")}
            />
            <FieldRow
              label="Sello %"
              value={track.record_label_percentage}
              onSave={saveField("record_label_percentage")}
            />
            <FieldRow label="Artista %" value={track.artist_percentage} onSave={saveField("artist_percentage")} />
            <FieldRow label="Escritor %" value={track.writer_percentage} onSave={saveField("writer_percentage")} />
          </section>

          {!isCreate && (
            <>
              {/* Videos: child recordings with their own enlace/fecha/ISRC/UPC/catálogo */}
              <section className="space-y-1.5">
                <SectionTitle
                  action={<AddAction isOpen={isAddingVideo} onClick={() => setIsAddingVideo((open) => !open)} />}
                >
                  Videos musicales
                </SectionTitle>
                {isAddingVideo && (
                  <div className="grid grid-cols-2 gap-1.5 rounded-md border border-subtle p-2">
                    <input
                      value={newVideo.title}
                      onChange={(event) => setNewVideo((current) => ({ ...current, title: event.target.value }))}
                      placeholder="Titulo del video"
                      className="col-span-2 rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                    />
                    <input
                      value={newVideo.video_url}
                      onChange={(event) => setNewVideo((current) => ({ ...current, video_url: event.target.value }))}
                      placeholder="URL del video"
                      className="col-span-2 rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                    />
                    <input
                      type="date"
                      value={newVideo.release_date}
                      onChange={(event) => setNewVideo((current) => ({ ...current, release_date: event.target.value }))}
                      className="rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                      title="Fecha de publicacion"
                    />
                    <input
                      value={newVideo.isrc}
                      onChange={(event) =>
                        setNewVideo((current) => ({ ...current, isrc: event.target.value.toUpperCase() }))
                      }
                      placeholder="ISRC"
                      className="font-mono rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-11"
                    />
                    <input
                      value={newVideo.upc}
                      onChange={(event) => setNewVideo((current) => ({ ...current, upc: event.target.value }))}
                      placeholder="UPC"
                      className="font-mono rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-11"
                    />
                    <input
                      value={newVideo.catalog}
                      onChange={(event) => setNewVideo((current) => ({ ...current, catalog: event.target.value }))}
                      placeholder="Catalogo"
                      className="font-mono rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-11"
                    />
                    <button
                      type="button"
                      onClick={() => void addVideo()}
                      className="col-span-2 rounded-sm bg-accent-primary px-2 py-1 text-12 font-medium text-on-color hover:opacity-90"
                    >
                      Agregar video musical
                    </button>
                  </div>
                )}
                {track.video_details.map((video) => {
                  const isEditing = editingVideoId === video.id;
                  return (
                    <div key={video.id} className="rounded-md border border-subtle">
                      <div className="group/row flex items-center gap-1.5 px-2 py-1.5">
                        <Video className="size-3.5 shrink-0 text-accent-primary" />
                        <span className="min-w-0 flex-1 truncate text-12">
                          {video.title || "Video"}
                          {video.release_date && (
                            <span className="ml-1 text-11 text-tertiary">· {video.release_date}</span>
                          )}
                          {video.isrc && <span className="font-mono ml-1 text-11 text-tertiary">{video.isrc}</span>}
                        </span>
                        {video.video_url && (
                          <a
                            href={video.video_url}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 p-1 text-tertiary hover:text-accent-primary"
                            title="Abrir video"
                          >
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                        <CopyButton value={video.video_url || video.isrc} label="video" />
                        <button
                          type="button"
                          onClick={() => setEditingVideoId(isEditing ? null : video.id)}
                          className="shrink-0 rounded-sm p-1 text-tertiary hover:text-primary"
                          title="Editar video"
                        >
                          <Pencil className="size-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeVideo(video.id)}
                          className="shrink-0 rounded-sm p-1 text-tertiary hover:text-danger-primary"
                          title="Quitar video"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                      {isEditing && (
                        <form
                          className="grid grid-cols-2 gap-1.5 border-t border-subtle p-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const values = new FormData(event.currentTarget);
                            const videoUrl = String(values.get("video_url") ?? "").trim();
                            if (videoUrl && !isHttpUrl(videoUrl)) {
                              setToast({
                                type: TOAST_TYPE.ERROR,
                                title: "El enlace del video debe ser una URL válida",
                              });
                              return;
                            }
                            void updateVideo(video.id, {
                              title: String(values.get("title") ?? ""),
                              video_url: videoUrl,
                              release_date: String(values.get("release_date") ?? ""),
                              isrc: String(values.get("isrc") ?? "").toUpperCase(),
                              upc: String(values.get("upc") ?? ""),
                              catalog: String(values.get("catalog") ?? ""),
                            }).then(() => setEditingVideoId(null));
                          }}
                        >
                          <input
                            name="title"
                            defaultValue={video.title}
                            placeholder="Título"
                            className="col-span-2 rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                          />
                          <input
                            name="video_url"
                            defaultValue={video.video_url}
                            placeholder="Enlace del video"
                            className="col-span-2 rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                          />
                          <input
                            name="release_date"
                            type="date"
                            defaultValue={video.release_date ?? ""}
                            className="rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                            title="Fecha de publicación"
                          />
                          <input
                            name="isrc"
                            defaultValue={video.isrc}
                            placeholder="ISRC"
                            className="font-mono rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-11"
                          />
                          <input
                            name="upc"
                            defaultValue={video.upc}
                            placeholder="UPC"
                            className="font-mono rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-11"
                          />
                          <input
                            name="catalog"
                            defaultValue={video.catalog}
                            placeholder="Catálogo"
                            className="font-mono rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-11"
                          />
                          <div className="col-span-2 flex justify-end gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => setEditingVideoId(null)}
                              className="text-12 text-secondary hover:underline"
                            >
                              Cancelar
                            </button>
                            <button
                              type="submit"
                              className="rounded-sm bg-accent-primary px-2 py-1 text-12 font-medium text-on-color"
                            >
                              Guardar video
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  );
                })}
                {track.video_details.length === 0 && <p className="px-1.5 text-12 text-placeholder">Sin videos</p>}
              </section>

              {/* Links: streaming/social/store — distinct from videos */}
              <section className="space-y-1.5">
                <SectionTitle
                  action={<AddAction isOpen={isAddingLink} onClick={() => setIsAddingLink((open) => !open)} />}
                >
                  Enlaces (streaming / redes)
                </SectionTitle>
                {track.links.map((link) => {
                  const isEditing = editingLinkId === link.id;
                  return (
                    <div key={link.id} className="rounded-sm hover:bg-layer-1-hover">
                      <div className="group/row flex items-center gap-1.5 px-1.5 py-1 text-12">
                        <LinkIcon className="size-3.5 shrink-0 text-tertiary" />
                        <span className="w-24 shrink-0 truncate text-11 text-tertiary">
                          {link.platform || link.kind}
                        </span>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 truncate text-accent-primary hover:underline"
                        >
                          {link.url}
                        </a>
                        <CopyButton value={link.url} label="enlace" />
                        <button
                          type="button"
                          onClick={() => setEditingLinkId(isEditing ? null : link.id)}
                          className="shrink-0 rounded-sm p-0.5 text-tertiary hover:text-primary"
                          title="Editar enlace"
                        >
                          <Pencil className="size-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeLink(link.id)}
                          className="shrink-0 rounded-sm p-0.5 text-tertiary hover:text-danger-primary"
                          title="Quitar enlace"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                      {isEditing && (
                        <form
                          className="grid grid-cols-2 gap-1.5 border-t border-subtle p-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const values = new FormData(event.currentTarget);
                            const url = String(values.get("url") ?? "").trim();
                            if (!isHttpUrl(url)) {
                              setToast({
                                type: TOAST_TYPE.ERROR,
                                title: "El enlace debe ser una URL válida (http o https)",
                              });
                              return;
                            }
                            void updateLink(link.id, {
                              kind: String(values.get("kind") ?? link.kind),
                              platform: String(values.get("platform") ?? ""),
                              url,
                            }).then(() => setEditingLinkId(null));
                          }}
                        >
                          <SearchableSelect
                            options={LINK_KINDS}
                            value={link.kind}
                            onSelect={(kind) => {
                              const input = document.getElementById(
                                `music-link-kind-${link.id}`
                              ) as HTMLInputElement | null;
                              if (input) input.value = kind;
                            }}
                            placeholder="Tipo"
                          />
                          <input id={`music-link-kind-${link.id}`} name="kind" type="hidden" defaultValue={link.kind} />
                          <input
                            name="platform"
                            defaultValue={link.platform}
                            placeholder="Plataforma"
                            className="rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                          />
                          <input
                            name="url"
                            defaultValue={link.url}
                            placeholder="URL"
                            className="col-span-2 rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                          />
                          <div className="col-span-2 flex justify-end gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => setEditingLinkId(null)}
                              className="text-12 text-secondary hover:underline"
                            >
                              Cancelar
                            </button>
                            <button
                              type="submit"
                              className="rounded-sm bg-accent-primary px-2 py-1 text-12 font-medium text-on-color"
                            >
                              Guardar enlace
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  );
                })}
                {track.links.length === 0 && <p className="px-1.5 text-12 text-placeholder">Sin enlaces</p>}
                {isAddingLink && (
                  <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-subtle p-2">
                    <SearchableSelect
                      className="w-36"
                      options={LINK_KINDS}
                      value={newLink.kind}
                      onSelect={(kind) => setNewLink((current) => ({ ...current, kind }))}
                      placeholder="Tipo…"
                    />
                    <input
                      value={newLink.platform}
                      onChange={(event) => setNewLink((current) => ({ ...current, platform: event.target.value }))}
                      placeholder="Plataforma"
                      className="w-28 rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                    />
                    <input
                      value={newLink.url}
                      onChange={(event) => setNewLink((current) => ({ ...current, url: event.target.value }))}
                      onKeyDown={(event) => event.key === "Enter" && void addLink()}
                      placeholder="URL"
                      className="min-w-40 flex-1 rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-12"
                    />
                    <button
                      type="button"
                      onClick={() => void addLink()}
                      disabled={!newLink.url.trim()}
                      className="rounded-sm bg-accent-primary px-2 py-1 text-12 font-medium text-on-color hover:opacity-90 disabled:opacity-50"
                    >
                      Agregar
                    </button>
                  </div>
                )}
              </section>
            </>
          )}

          <section className="space-y-1">
            <SectionTitle>Derechos y textos</SectionTitle>
            <FieldRow label="Ownership" value={track.ownership} onSave={saveField("ownership")} variant="textarea" />
            <FieldRow
              label="Obligaciones US"
              value={track.us_publishing_obligations}
              onSave={saveField("us_publishing_obligations")}
              variant="textarea"
            />
            <FieldRow label="Recoupment" value={track.recoupment} onSave={saveField("recoupment")} variant="textarea" />
            <FieldRow label="P line" value={track.p_line} onSave={saveField("p_line")} />
            <FieldRow label="Letra" value={track.lyrics} onSave={saveField("lyrics")} variant="textarea" />
          </section>
        </div>

        {/* create mode: nothing persists until the user confirms */}
        {isCreate && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-subtle bg-layer-1 px-4 py-3">
            <p className="text-11 text-tertiary">Nada se guarda hasta confirmar.</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-sm border border-subtle px-3 py-1.5 text-13 hover:bg-layer-1-hover"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void createRecord()}
                disabled={isCreating || !track.title.trim()}
                className="flex items-center gap-1.5 rounded-sm bg-accent-primary px-3 py-1.5 text-13 font-medium text-on-color hover:opacity-90 disabled:opacity-50"
                title={!track.title.trim() ? "El título es obligatorio" : undefined}
              >
                {isCreating ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                Crear canción
              </button>
            </div>
          </div>
        )}
      </div>
      <MusicResourcePickerModal
        workspaceSlug={workspaceSlug}
        isOpen={Boolean(creditPicker)}
        resourceType="party"
        title="Artists and contributors"
        items={parties}
        selectedIds={(() => {
          const partyId = creditPicker
            ? track.credits.find((credit) => credit.id === creditPicker.creditId)?.party.id
            : undefined;
          return partyId ? [partyId] : [];
        })()}
        options={options}
        multiple={false}
        defaultKind="ARTIST"
        onClose={() => setCreditPicker(undefined)}
        onSelect={(ids) => {
          const partyId = ids[0];
          if (creditPicker && partyId) void updateCredit(creditPicker.creditId, { party_id: partyId });
        }}
        onChanged={onResourcesChanged}
      />
      <FilePreviewModal
        workspaceSlug={workspaceSlug}
        file={previewImportFile}
        onClose={() => setPreviewImportFile(null)}
        scope="music"
      />
    </>
  );
}
