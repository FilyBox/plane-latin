import { useEffect, useState } from "react";
import { Building2, Disc3, ImagePlus, Music2, Pencil, Plus, Trash2, Upload, Video } from "lucide-react";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TMusicCatalogOptions,
  TMusicCompany,
  TMusicGenre,
  TMusicParty,
  TMusicRelease,
  TMusicTrack,
} from "@plane/types";
import { fileLibraryService } from "@/services/file-library.service";
import { musicService } from "@/services/music.service";
import { BudgetPeekPanel } from "../payments/budget-peek-panel";
import { AudioPreviewRange } from "./audio-preview-range";
import { MusicResourcePickerModal, type MusicResourceType } from "./resource-picker-modal";
import { getApiError, MUSIC_FIELD, MUSIC_LABEL } from "./shared";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  track?: TMusicTrack;
  releases: TMusicRelease[];
  parties: TMusicParty[];
  genres: TMusicGenre[];
  companies: TMusicCompany[];
  options?: TMusicCatalogOptions;
  onClose: () => void;
  onSaved: () => void;
  onResourcesChanged: () => void;
};

type CreditEntry = { party_id: string; role: string; percentage: string; publishing_share: string; territory: string };
type DistributionEntry = {
  company_id: string;
  percentage: string;
  territory: string;
  valid_from: string;
  valid_to: string;
};
type VideoEntry = {
  id?: string;
  title: string;
  status: string;
  isrc: string;
  release_date: string;
  duration_ms: string;
  video_url: string;
};
type PickerTarget = "credits" | "credit" | "releases" | "genres" | "distributions" | "distribution";
type PickerState = { resourceType: MusicResourceType; target: PickerTarget; index?: number; defaultKind?: string };

const EMPTY = {
  title: "",
  version: "",
  status: "DRAFT",
  isrc: "",
  release_date: "",
  original_release_date: "",
  duration_ms: "",
  country_of_recording: "",
  language: "",
  ownership: "",
  us_publishing_obligations: "",
  recoupment: "",
  p_line: "",
  digital_format: "",
  lyrics: "",
  audio_url: "",
  cover_url: "",
  tiktok_preview_start_ms: "",
  tiktok_preview_end_ms: "",
  aggregator_percentage: "",
  distributor_percentage: "",
  record_label_percentage: "",
  artist_percentage: "",
  writer_percentage: "",
  explicit: false,
  instrumental: false,
  release_ids: [] as string[],
  genre_ids: [] as string[],
  credits: [] as CreditEntry[],
  distributions: [] as DistributionEntry[],
  videos: [] as VideoEntry[],
};

const Section = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) => (
  <section className="border-b border-subtle px-5 py-5">
    <h3 className="text-14 font-semibold">{title}</h3>
    {description && <p className="mt-1 text-11 text-secondary">{description}</p>}
    <div className="mt-4">{children}</div>
  </section>
);

export function MusicTrackModal({
  workspaceSlug,
  isOpen,
  track,
  releases,
  parties,
  genres,
  companies,
  options,
  onClose,
  onSaved,
  onResourcesChanged,
}: Props) {
  const [form, setForm] = useState(EMPTY);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [audioPreview, setAudioPreview] = useState("");
  const [picker, setPicker] = useState<PickerState>();

  useEffect(() => {
    if (!isOpen) return;
    setPicker(undefined);
    setAudioPreview(track?.audio_url ?? "");
    setForm(
      track
        ? {
            ...EMPTY,
            title: track.title,
            version: track.version,
            status: track.status,
            isrc: track.isrc,
            release_date: track.release_date ?? "",
            original_release_date: track.original_release_date ?? "",
            duration_ms: track.duration_ms?.toString() ?? "",
            country_of_recording: track.country_of_recording,
            language: track.language,
            ownership: track.ownership,
            us_publishing_obligations: track.us_publishing_obligations,
            recoupment: track.recoupment,
            p_line: track.p_line,
            digital_format: track.digital_format,
            lyrics: track.lyrics,
            audio_url: track.audio_url,
            cover_url: track.cover_url,
            tiktok_preview_start_ms: track.tiktok_preview_start_ms?.toString() ?? "",
            tiktok_preview_end_ms: track.tiktok_preview_end_ms?.toString() ?? "",
            aggregator_percentage: track.aggregator_percentage ?? "",
            distributor_percentage: track.distributor_percentage ?? "",
            record_label_percentage: track.record_label_percentage ?? "",
            artist_percentage: track.artist_percentage ?? "",
            writer_percentage: track.writer_percentage ?? "",
            explicit: track.explicit,
            instrumental: track.instrumental,
            release_ids: track.release_details.map((item) => item.id),
            genre_ids: track.genre_details.map((item) => item.id),
            credits: track.credits.map((credit) => ({
              party_id: credit.party.id,
              role: credit.role,
              percentage: credit.percentage ?? "",
              publishing_share: credit.publishing_share ?? "",
              territory: credit.territory,
            })),
            distributions: track.distributions.map((item) => ({
              company_id: item.company.id,
              percentage: item.percentage ?? "",
              territory: item.territory,
              valid_from: item.valid_from ?? "",
              valid_to: item.valid_to ?? "",
            })),
            videos: track.video_details.map((video) => ({
              id: video.id,
              title: video.title,
              status: video.status,
              isrc: video.isrc,
              release_date: video.release_date ?? "",
              duration_ms: video.duration_ms?.toString() ?? "",
              video_url: video.video_url,
            })),
          }
        : EMPTY
    );
  }, [isOpen, track]);

  const set = <K extends keyof typeof EMPTY>(field: K, value: (typeof EMPTY)[K]) =>
    setForm((current) => ({ ...current, [field]: value }));

  const upload = async (file: File | undefined, kind: "audio" | "cover") => {
    if (!file) return;
    setIsUploading(true);
    try {
      const uploaded = await fileLibraryService.uploadFile(workspaceSlug, file);
      const url = fileLibraryService.getFileViewUrl(workspaceSlug, uploaded.asset_id);
      if (kind === "audio") {
        set("audio_url", url);
        setAudioPreview(URL.createObjectURL(file));
      } else set("cover_url", url);
      setToast({ type: TOAST_TYPE.SUCCESS, title: kind === "audio" ? "Audio attached" : "Cover attached" });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "Could not upload file", message: getApiError(error) });
    } finally {
      setIsUploading(false);
    }
  };

  const applyPicker = (ids: string[]) => {
    if (!picker) return;
    if (picker.target === "releases") set("release_ids", ids);
    if (picker.target === "genres") set("genre_ids", ids);
    if (picker.target === "credits" && ids[0])
      set("credits", [
        ...form.credits,
        { party_id: ids[0], role: "PRIMARY_ARTIST", percentage: "", publishing_share: "", territory: "" },
      ]);
    if (picker.target === "credit" && ids[0] && picker.index !== undefined)
      set(
        "credits",
        form.credits.map((item, index) => (index === picker.index ? { ...item, party_id: ids[0] } : item))
      );
    if (picker.target === "distributions" && ids[0])
      set("distributions", [
        ...form.distributions,
        { company_id: ids[0], percentage: "", territory: "", valid_from: "", valid_to: "" },
      ]);
    if (picker.target === "distribution" && ids[0] && picker.index !== undefined)
      set(
        "distributions",
        form.distributions.map((item, index) => (index === picker.index ? { ...item, company_id: ids[0] } : item))
      );
  };

  const save = async () => {
    if (!form.title.trim()) return;
    setIsSaving(true);
    try {
      const { credits, distributions, videos, release_ids, genre_ids, ...values } = form;
      await musicService.saveTrack(workspaceSlug, {
        ...values,
        id: track?.id,
        kind: "AUDIO",
        release_date: form.release_date || null,
        original_release_date: form.original_release_date || null,
        duration_ms: form.duration_ms ? Number(form.duration_ms) : null,
        tiktok_preview_start_ms: form.tiktok_preview_start_ms ? Number(form.tiktok_preview_start_ms) : null,
        tiktok_preview_end_ms: form.tiktok_preview_end_ms ? Number(form.tiktok_preview_end_ms) : null,
        aggregator_percentage: form.aggregator_percentage || null,
        distributor_percentage: form.distributor_percentage || null,
        record_label_percentage: form.record_label_percentage || null,
        artist_percentage: form.artist_percentage || null,
        writer_percentage: form.writer_percentage || null,
        genre_ids,
        releases: release_ids.map((id, index) => ({ id, disc_number: 1, track_number: index + 1 })),
        credit_entries: credits.map((entry) => ({
          ...entry,
          percentage: entry.percentage || null,
          publishing_share: entry.publishing_share || null,
        })),
        distribution_entries: distributions.map((entry) => ({ ...entry, percentage: entry.percentage || null })),
        video_entries: videos.map((video) => ({
          ...video,
          duration_ms: video.duration_ms ? Number(video.duration_ms) : null,
        })),
      });
      setToast({ type: TOAST_TYPE.SUCCESS, title: track ? "Song updated" : "Song created" });
      onSaved();
      onClose();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "Could not save song", message: getApiError(error) });
    } finally {
      setIsSaving(false);
    }
  };

  const duration = Math.max(Number(form.duration_ms || 0), 1000);
  if (!isOpen) return null;
  return (
    <BudgetPeekPanel
      title={track ? form.title || "Edit song" : "New song"}
      description="Song record, credits, releases, videos, rights and media."
      onClose={onClose}
    >
      <div className="vertical-scrollbar h-full overflow-y-auto bg-surface-1">
        <div className="bg-gradient-to-br from-[#173a31] via-[#102c26] to-[#111827] px-5 py-6 text-white">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
            <label className="group shadow-xl relative flex size-36 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xl bg-white/10">
              {form.cover_url ? (
                <img src={form.cover_url} alt="Cover" className="size-full object-cover" />
              ) : (
                <Disc3 className="size-12 text-white/40" />
              )}
              <span className="absolute inset-0 hidden items-center justify-center bg-black/55 text-11 group-hover:flex">
                <ImagePlus className="mr-1.5 size-4" /> Cover
              </span>
              <input
                className="hidden"
                type="file"
                accept="image/*"
                onChange={(event) => void upload(event.target.files?.[0], "cover")}
              />
            </label>
            <div className="min-w-0 flex-1">
              <label htmlFor="music-song-title" className="text-10 font-semibold text-white/60 uppercase">
                Title
              </label>
              <input
                id="music-song-title"
                className="mt-1 w-full border-0 bg-transparent text-24 font-semibold text-white outline-none placeholder:text-white/35"
                placeholder="Untitled song"
                value={form.title}
                onChange={(event) => set("title", event.target.value)}
              />
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <label className="cursor-pointer rounded-full bg-white px-3 py-1.5 text-11 font-semibold text-[#173a31]">
                  <Upload className="mr-1 inline size-3.5" /> {isUploading ? "Uploading..." : "Attach audio"}
                  <input
                    className="hidden"
                    type="file"
                    accept="audio/*,.mp3,.mpeg,.mpga"
                    disabled={isUploading}
                    onChange={(event) => void upload(event.target.files?.[0], "audio")}
                  />
                </label>
                <span className="text-11 text-white/60">{form.isrc || "No ISRC yet"}</span>
              </div>
              {audioPreview && (
                <div className="mt-3 rounded-lg bg-white/10 p-2">
                  {/* Music previews do not have a meaningful caption track. */}
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio className="h-10 w-full" controls preload="metadata" src={audioPreview} />
                </div>
              )}
            </div>
          </div>
        </div>

        <Section
          title="Core information"
          description="Identifiers and dates used by aggregators, searches and reports."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className={MUSIC_LABEL}>Audio ISRC (optional)</span>
              <input
                className={MUSIC_FIELD}
                value={form.isrc}
                onChange={(event) => set("isrc", event.target.value.toUpperCase())}
              />
            </label>
            <label>
              <span className={MUSIC_LABEL}>Version (optional)</span>
              <input
                className={MUSIC_FIELD}
                value={form.version}
                onChange={(event) => set("version", event.target.value)}
              />
            </label>
            <label>
              <span className={MUSIC_LABEL}>Release date (optional)</span>
              <input
                type="date"
                className={MUSIC_FIELD}
                value={form.release_date}
                onChange={(event) => set("release_date", event.target.value)}
              />
            </label>
            <label>
              <span className={MUSIC_LABEL}>Original release (optional)</span>
              <input
                type="date"
                className={MUSIC_FIELD}
                value={form.original_release_date}
                onChange={(event) => set("original_release_date", event.target.value)}
              />
            </label>
            <label>
              <span className={MUSIC_LABEL}>Status</span>
              <select
                className={MUSIC_FIELD}
                value={form.status}
                onChange={(event) => set("status", event.target.value)}
              >
                {options?.track_statuses.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={MUSIC_LABEL}>Duration (milliseconds, optional)</span>
              <input
                type="number"
                className={MUSIC_FIELD}
                value={form.duration_ms}
                onChange={(event) => set("duration_ms", event.target.value)}
              />
            </label>
          </div>
        </Section>

        <Section
          title="Artists, contributors and rights"
          description="Add several people with independent roles and percentages."
        >
          <div className="space-y-2">
            {form.credits.map((credit, index) => (
              <div
                key={`${credit.party_id}-${index}`}
                className="grid gap-2 rounded-lg border border-subtle p-3 sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_.7fr_.7fr_auto]"
              >
                <button
                  type="button"
                  className={`${MUSIC_FIELD} flex items-center justify-between text-left`}
                  onClick={() => setPicker({ resourceType: "party", target: "credit", index })}
                >
                  <span className="truncate">
                    {parties.find((party) => party.id === credit.party_id)?.display_name ?? "Choose contributor"}
                  </span>
                  <Pencil className="size-3.5 shrink-0 text-tertiary" />
                </button>
                <select
                  className={MUSIC_FIELD}
                  value={credit.role}
                  onChange={(event) =>
                    set(
                      "credits",
                      form.credits.map((item, i) => (i === index ? { ...item, role: event.target.value } : item))
                    )
                  }
                >
                  {options?.credit_roles.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0"
                  max="100"
                  className={MUSIC_FIELD}
                  placeholder="Rights %"
                  value={credit.percentage}
                  onChange={(event) =>
                    set(
                      "credits",
                      form.credits.map((item, i) => (i === index ? { ...item, percentage: event.target.value } : item))
                    )
                  }
                />
                <input
                  type="number"
                  min="0"
                  max="100"
                  className={MUSIC_FIELD}
                  placeholder="Publishing %"
                  value={credit.publishing_share}
                  onChange={(event) =>
                    set(
                      "credits",
                      form.credits.map((item, i) =>
                        i === index ? { ...item, publishing_share: event.target.value } : item
                      )
                    )
                  }
                />
                <button
                  type="button"
                  className="hover:bg-red-50 hover:text-red-600 rounded p-2 text-secondary"
                  onClick={() =>
                    set(
                      "credits",
                      form.credits.filter((_, i) => i !== index)
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => setPicker({ resourceType: "party", target: "credits", defaultKind: "ARTIST" })}
          >
            <Plus className="mr-1 size-4" /> Add credit
          </Button>
        </Section>

        <Section title="Releases and genres" description="A song can appear on multiple singles, EPs or albums.">
          <div className="flex items-center justify-between gap-3">
            <p className={MUSIC_LABEL}>Releases (optional)</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPicker({ resourceType: "release", target: "releases", defaultKind: "SINGLE" })}
            >
              <Plus className="mr-1 size-3.5" /> Select releases
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {form.release_ids.map((id) => (
              <span key={id} className="rounded-full border border-subtle bg-layer-2 px-3 py-1.5 text-11">
                {releases.find((item) => item.id === id)?.title ?? "Unknown release"}
              </span>
            ))}
            {!form.release_ids.length && <span className="text-11 text-tertiary">No releases selected.</span>}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className={MUSIC_LABEL}>Genres (optional)</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPicker({ resourceType: "genre", target: "genres" })}
            >
              <Plus className="mr-1 size-3.5" /> Select genres
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {form.genre_ids.map((id) => (
              <span key={id} className="rounded-full border border-subtle bg-layer-2 px-3 py-1.5 text-11">
                {genres.find((item) => item.id === id)?.name ?? "Unknown genre"}
              </span>
            ))}
            {!form.genre_ids.length && <span className="text-11 text-tertiary">No genres selected.</span>}
          </div>
        </Section>

        <Section
          title="Music videos"
          description="Videos remain attached to this song and keep their own ISRC, date and URL."
        >
          <div className="space-y-3">
            {form.videos.map((video, index) => (
              <div key={video.id ?? index} className="rounded-xl border border-subtle bg-layer-2 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-12 font-semibold">
                    <Video className="size-4 text-accent-primary" /> Video {index + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      set(
                        "videos",
                        form.videos.filter((_, i) => i !== index)
                      )
                    }
                  >
                    <Trash2 className="size-4 text-tertiary" />
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    className={MUSIC_FIELD}
                    placeholder="Video title"
                    value={video.title}
                    onChange={(event) =>
                      set(
                        "videos",
                        form.videos.map((item, i) => (i === index ? { ...item, title: event.target.value } : item))
                      )
                    }
                  />
                  <input
                    className={MUSIC_FIELD}
                    placeholder="Video ISRC"
                    value={video.isrc}
                    onChange={(event) =>
                      set(
                        "videos",
                        form.videos.map((item, i) =>
                          i === index ? { ...item, isrc: event.target.value.toUpperCase() } : item
                        )
                      )
                    }
                  />
                  <input
                    type="date"
                    className={MUSIC_FIELD}
                    value={video.release_date}
                    onChange={(event) =>
                      set(
                        "videos",
                        form.videos.map((item, i) =>
                          i === index ? { ...item, release_date: event.target.value } : item
                        )
                      )
                    }
                  />
                  <input
                    type="url"
                    className={MUSIC_FIELD}
                    placeholder="YouTube / distribution URL"
                    value={video.video_url}
                    onChange={(event) =>
                      set(
                        "videos",
                        form.videos.map((item, i) => (i === index ? { ...item, video_url: event.target.value } : item))
                      )
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() =>
              set("videos", [
                ...form.videos,
                {
                  title: form.title,
                  status: "DRAFT",
                  isrc: "",
                  release_date: form.release_date,
                  duration_ms: "",
                  video_url: "",
                },
              ])
            }
          >
            <Plus className="mr-1 size-4" /> Add music video
          </Button>
        </Section>

        <Section
          title="Distribution and commercial splits"
          description="Link reusable companies and keep their validity and participation in one place."
        >
          <div className="space-y-2">
            {form.distributions.map((entry, index) => (
              <div
                key={`${entry.company_id}-${index}`}
                className="grid gap-3 rounded-lg border border-subtle p-3 sm:grid-cols-2 2xl:grid-cols-3"
              >
                <div className="sm:col-span-2 2xl:col-span-1">
                  <span className={MUSIC_LABEL}>Company</span>
                  <button
                    type="button"
                    className={`${MUSIC_FIELD} flex items-center justify-between text-left`}
                    onClick={() => setPicker({ resourceType: "company", target: "distribution", index })}
                  >
                    <span className="truncate">
                      {companies.find((company) => company.id === entry.company_id)?.name ?? "Choose company"}
                    </span>
                    <Pencil className="size-3.5 shrink-0 text-tertiary" />
                  </button>
                </div>
                <label>
                  <span className={MUSIC_LABEL}>Share % (optional)</span>
                  <input
                    type="number"
                    className={MUSIC_FIELD}
                    value={entry.percentage}
                    onChange={(event) =>
                      set(
                        "distributions",
                        form.distributions.map((item, i) =>
                          i === index ? { ...item, percentage: event.target.value } : item
                        )
                      )
                    }
                  />
                </label>
                <label>
                  <span className={MUSIC_LABEL}>Territory (optional)</span>
                  <input
                    className={MUSIC_FIELD}
                    value={entry.territory}
                    onChange={(event) =>
                      set(
                        "distributions",
                        form.distributions.map((item, i) =>
                          i === index ? { ...item, territory: event.target.value } : item
                        )
                      )
                    }
                  />
                </label>
                <label>
                  <span className={MUSIC_LABEL}>Valid from (optional)</span>
                  <input
                    type="date"
                    className={MUSIC_FIELD}
                    value={entry.valid_from}
                    onChange={(event) =>
                      set(
                        "distributions",
                        form.distributions.map((item, i) =>
                          i === index ? { ...item, valid_from: event.target.value } : item
                        )
                      )
                    }
                  />
                </label>
                <label>
                  <span className={MUSIC_LABEL}>Valid to (optional)</span>
                  <input
                    type="date"
                    className={MUSIC_FIELD}
                    value={entry.valid_to}
                    onChange={(event) =>
                      set(
                        "distributions",
                        form.distributions.map((item, i) =>
                          i === index ? { ...item, valid_to: event.target.value } : item
                        )
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="justify-self-end rounded p-2 text-tertiary hover:bg-danger-subtle hover:text-danger-primary sm:col-span-2 2xl:col-span-3"
                  onClick={() =>
                    set(
                      "distributions",
                      form.distributions.filter((_, i) => i !== index)
                    )
                  }
                >
                  <Trash2 className="size-4 text-tertiary" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => setPicker({ resourceType: "company", target: "distributions", defaultKind: "AGGREGATOR" })}
            >
              <Building2 className="mr-1 size-4" /> Add aggregator
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setPicker({ resourceType: "company", target: "distributions", defaultKind: "DISTRIBUTOR" })
              }
            >
              <Plus className="mr-1 size-4" /> Add company
            </Button>
          </div>
        </Section>

        <Section
          title="TikTok audio preview"
          description="Use the player and range controls to choose the exact excerpt sent to TikTok."
        >
          {!audioPreview ? (
            <div className="rounded-lg border border-dashed border-subtle p-5 text-center text-12 text-secondary">
              <Music2 className="mx-auto mb-2 size-5" />
              Attach an audio file to preview the segment.
            </div>
          ) : (
            <AudioPreviewRange
              src={audioPreview}
              durationMs={duration}
              startMs={Number(form.tiktok_preview_start_ms || 0)}
              endMs={Number(form.tiktok_preview_end_ms || duration)}
              onDurationChange={(value) => set("duration_ms", String(value))}
              onChange={(start, end) =>
                setForm((current) => ({
                  ...current,
                  tiktok_preview_start_ms: String(Math.round(start)),
                  tiktok_preview_end_ms: String(Math.round(end)),
                }))
              }
            />
          )}
        </Section>

        <Section title="Legal and technical details">
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className={MUSIC_LABEL}>Country of recording (optional)</span>
              <input
                maxLength={2}
                className={MUSIC_FIELD}
                value={form.country_of_recording}
                onChange={(event) => set("country_of_recording", event.target.value.toUpperCase())}
              />
            </label>
            <label>
              <span className={MUSIC_LABEL}>Language (optional)</span>
              <input
                className={MUSIC_FIELD}
                value={form.language}
                onChange={(event) => set("language", event.target.value)}
              />
            </label>
            <label className="sm:col-span-2">
              <span className={MUSIC_LABEL}>Ownership / master rights (optional)</span>
              <textarea
                className={`${MUSIC_FIELD} min-h-20`}
                value={form.ownership}
                onChange={(event) => set("ownership", event.target.value)}
              />
            </label>
            <label className="sm:col-span-2">
              <span className={MUSIC_LABEL}>Lyrics (optional)</span>
              <textarea
                className={`${MUSIC_FIELD} min-h-28`}
                value={form.lyrics}
                onChange={(event) => set("lyrics", event.target.value)}
              />
            </label>
          </div>
        </Section>

        <footer className="sticky bottom-0 z-20 flex justify-end gap-2 border-t border-subtle bg-surface-1 px-5 py-4">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={isSaving}
            disabled={!form.title.trim()}
            onClick={() => void save()}
          >
            {track ? "Save changes" : "Create song"}
          </Button>
        </footer>
      </div>
      <MusicResourcePickerModal
        workspaceSlug={workspaceSlug}
        isOpen={Boolean(picker)}
        resourceType={picker?.resourceType ?? "party"}
        title={
          picker?.resourceType === "party"
            ? "Artists and contributors"
            : picker?.resourceType === "company"
              ? "Distribution companies"
              : picker?.resourceType === "release"
                ? "Releases"
                : "Genres"
        }
        items={
          picker?.resourceType === "party"
            ? parties
            : picker?.resourceType === "company"
              ? companies
              : picker?.resourceType === "release"
                ? releases
                : genres
        }
        selectedIds={
          picker?.target === "releases"
            ? form.release_ids
            : picker?.target === "genres"
              ? form.genre_ids
              : picker?.target === "credit" && picker.index !== undefined
                ? [form.credits[picker.index]?.party_id].filter(Boolean)
                : picker?.target === "distribution" && picker.index !== undefined
                  ? [form.distributions[picker.index]?.company_id].filter(Boolean)
                  : []
        }
        options={options}
        multiple={picker?.target === "releases" || picker?.target === "genres"}
        defaultKind={picker?.defaultKind}
        onClose={() => setPicker(undefined)}
        onSelect={applyPicker}
        onChanged={onResourcesChanged}
      />
    </BudgetPeekPanel>
  );
}
