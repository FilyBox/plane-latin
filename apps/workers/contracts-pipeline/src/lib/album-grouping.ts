/**
 * Album grouping for the assistant: the albums the model read from a list
 * or a file (title, artists, codes, tracklist) are cleaned here, matched by
 * Django against the catalog (read-only), and summarized for the
 * confirmation card. Nothing is written until the user applies in the card.
 */

export type GroupingTrackInput = {
  title: string;
  isrc?: string;
  artists?: string[];
  disc_number?: number;
  track_number?: number;
  duration?: string;
};

export type GroupingAlbumInput = {
  title: string;
  artists?: string[];
  upc?: string;
  type?: string;
  release_date?: string;
  tracks: GroupingTrackInput[];
};

export type GroupingSong = {
  id: string;
  track_id: string;
  title: string;
  version?: string | null;
  isrc?: string | null;
  artists?: string[];
  confidence: number;
  match_type: string;
  releases?: { id: string; title: string }[];
  path?: string;
};

export type GroupingAlbumResult = {
  index: number;
  album: { title: string; artists?: string[]; upc?: string | null; type?: string | null; release_date?: string | null };
  release_candidates: {
    id: string;
    title: string;
    track_count: number;
    match_type: string;
    same_title_artist: boolean;
    path?: string;
  }[];
  suggested_target_id: string | null;
  tracks: {
    index: number;
    match: GroupingSong | null;
    candidates: GroupingSong[];
    ambiguous: boolean;
  }[];
  summary: { tracks: number; matched: number; ambiguous: number; unmatched: number; duplicates: number };
};

const text = (value: unknown, limit = 500) => (typeof value === "string" ? value.trim().slice(0, limit) : "");
const names = (value: unknown) =>
  Array.isArray(value) ? [...new Set(value.map((item) => text(item, 255)).filter(Boolean))].slice(0, 20) : [];
const positive = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 999 ? value : undefined;

/** Trims every value and drops tracks without a title or ISRC and albums
 * left with nothing; never invents numbers (Django numbers by list order). */
export function cleanAlbums(albums: GroupingAlbumInput[]): GroupingAlbumInput[] {
  return albums
    .map((album) => {
      const tracks = (album.tracks ?? [])
        .map((track) => {
          const clean: GroupingTrackInput = { title: text(track.title) };
          const isrc = text(track.isrc, 20);
          const artists = names(track.artists);
          if (isrc) clean.isrc = isrc;
          if (artists.length) clean.artists = artists;
          if (positive(track.disc_number)) clean.disc_number = positive(track.disc_number);
          if (positive(track.track_number)) clean.track_number = positive(track.track_number);
          if (text(track.duration, 20)) clean.duration = text(track.duration, 20);
          return clean;
        })
        .filter((track) => track.title || track.isrc);
      const clean: GroupingAlbumInput = { title: text(album.title), tracks };
      const artists = names(album.artists);
      if (artists.length) clean.artists = artists;
      if (text(album.upc, 32)) clean.upc = text(album.upc, 32);
      if (text(album.type, 30)) clean.type = text(album.type, 30);
      if (text(album.release_date, 30)) clean.release_date = text(album.release_date, 30);
      return clean;
    })
    .filter((album) => album.title || album.tracks.length);
}

/** Totals across albums, for the model's reply and the compacted history. */
export function groupingSummary(albums: GroupingAlbumResult[]) {
  const sum = (key: keyof GroupingAlbumResult["summary"]) =>
    albums.reduce((total, album) => total + (album.summary?.[key] ?? 0), 0);
  return {
    albums: albums.length,
    existing_albums: albums.filter((album) => album.suggested_target_id).length,
    new_albums: albums.filter((album) => !album.suggested_target_id).length,
    tracks: sum("tracks"),
    matched: sum("matched"),
    ambiguous: sum("ambiguous"),
    unmatched: sum("unmatched"),
    duplicates: sum("duplicates"),
  };
}
