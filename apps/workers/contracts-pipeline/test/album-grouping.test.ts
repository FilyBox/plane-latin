import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cleanAlbums, groupingSummary, type GroupingAlbumResult } from "../src/lib/album-grouping.ts";
import { collectEntities } from "../src/lib/page-links.ts";

const TRACK = "2ae6ed26-1111-4222-8333-444455556666";
const RELEASE = "9bc1aa10-1111-4222-8333-444455556666";

describe("album grouping", () => {
  it("trims values, drops empty tracks and albums, never invents numbers", () => {
    const cleaned = cleanAlbums([
      {
        title: "  20 años VIP V1 ",
        artists: ["Banda VIP", "Banda VIP", " "],
        upc: " 0123456789012 ",
        tracks: [
          { title: " Canción 1 ", track_number: 1 },
          { title: "", isrc: "MXA112400002" },
          { title: "  " },
          { title: "Canción 3", track_number: 0, disc_number: 2.5 },
        ],
      },
      { title: " ", tracks: [{ title: "" }] },
    ]);
    assert.deepEqual(cleaned, [
      {
        title: "20 años VIP V1",
        artists: ["Banda VIP"],
        upc: "0123456789012",
        tracks: [{ title: "Canción 1", track_number: 1 }, { title: "", isrc: "MXA112400002" }, { title: "Canción 3" }],
      },
    ]);
  });

  it("keeps an album without tracks (merging duplicates only)", () => {
    assert.deepEqual(cleanAlbums([{ title: "Album Acustico", tracks: [] }]), [{ title: "Album Acustico", tracks: [] }]);
  });

  it("sums the albums for the reply and keeps songs and releases for the history", () => {
    const song = {
      id: TRACK,
      track_id: TRACK,
      title: "Canción 1",
      confidence: 0.9,
      match_type: "title_artist",
      path: `/ws/music?track=${TRACK}`,
    };
    const albums: GroupingAlbumResult[] = [
      {
        index: 0,
        album: { title: "20 años VIP V1" },
        release_candidates: [
          {
            id: RELEASE,
            title: "20 años VIP V1",
            track_count: 1,
            match_type: "title_artist",
            same_title_artist: true,
            path: `/ws/music?release=${RELEASE}`,
          },
        ],
        suggested_target_id: RELEASE,
        tracks: [
          { index: 0, match: song, candidates: [], ambiguous: false },
          { index: 1, match: null, candidates: [], ambiguous: false },
        ],
        summary: { tracks: 2, matched: 1, ambiguous: 0, unmatched: 1, duplicates: 6 },
      },
      {
        index: 1,
        album: { title: "Nuevo" },
        release_candidates: [],
        suggested_target_id: null,
        tracks: [],
        summary: { tracks: 3, matched: 2, ambiguous: 1, unmatched: 0, duplicates: 0 },
      },
    ];
    assert.deepEqual(groupingSummary(albums), {
      albums: 2,
      existing_albums: 1,
      new_albums: 1,
      tracks: 5,
      matched: 3,
      ambiguous: 1,
      unmatched: 1,
      duplicates: 6,
    });
    const kinds = collectEntities([{ albums }], ["music_track", "music_release"]).map((item) => item.kind);
    assert.deepEqual(kinds.sort(), ["music_release", "music_track"]);
  });
});
