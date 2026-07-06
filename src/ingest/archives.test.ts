import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../db/index.ts";
import { importLinkedInExport, importXArchive, parseCsv } from "./archives.ts";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

describe("parseCsv", () => {
  test("quoted commas, escaped quotes, embedded newlines, CRLF", () => {
    const raw = 'a,b,c\r\n"1,5","he said ""hi""","line1\nline2"\r\nplain,2,3\n';
    expect(parseCsv(raw)).toEqual([
      ["a", "b", "c"],
      ["1,5", 'he said "hi"', "line1\nline2"],
      ["plain", "2", "3"],
    ]);
  });
});

describe("importXArchive", () => {
  test("parses tweets.js, keeps engagement, skips dupes on re-import", () => {
    const dir = mkdtempSync(join(tmpdir(), "foghorn-x-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    const tweets = [
      {
        tweet: {
          id_str: "111",
          full_text: "deterministic gates beat vibes",
          created_at: "Wed Oct 10 20:19:24 +0000 2018",
          favorite_count: "42",
          retweet_count: "7",
          in_reply_to_status_id_str: null,
        },
      },
      {
        tweet: {
          id_str: "112",
          full_text: "RT @someone: great thread",
          created_at: "Thu Oct 11 08:00:00 +0000 2018",
          favorite_count: "0",
          retweet_count: "0",
        },
      },
    ];
    writeFileSync(join(dir, "data", "tweets.js"), `window.YTD.tweets.part0 = ${JSON.stringify(tweets)}`);

    const db = freshDb();
    const report = importXArchive(db, dir);
    expect(report.inserted).toBe(2);

    const row = db
      .query<{ engagement_json: string; posted_at: string }, [string]>(
        "SELECT engagement_json, posted_at FROM corpus_docs WHERE external_id = ?",
      )
      .get("x:111");
    const engagement = JSON.parse(row!.engagement_json);
    expect(engagement.likes).toBe(42);
    expect(engagement.reposts).toBe(7);
    expect(engagement.isRetweet).toBe(false);
    expect(row!.posted_at).toBe("2018-10-10T20:19:24.000Z");

    const rt = db
      .query<{ engagement_json: string }, [string]>("SELECT engagement_json FROM corpus_docs WHERE external_id = ?")
      .get("x:112");
    expect(JSON.parse(rt!.engagement_json).isRetweet).toBe(true);

    const again = importXArchive(db, dir);
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(2);
    db.close();
  });

  test("fails loudly on a non-archive directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "foghorn-notx-"));
    const db = freshDb();
    expect(() => importXArchive(db, dir)).toThrow(/tweets\.js/);
    db.close();
  });
});

describe("importLinkedInExport", () => {
  test("parses Shares.csv including multiline quoted commentary", () => {
    const dir = mkdtempSync(join(tmpdir(), "foghorn-li-"));
    const csv =
      "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n" +
      '2026-05-01 10:00:00,https://www.linkedin.com/feed/update/urn:li:share:1,"Two lines here:\nand a ""quote"", with commas",,,"MEMBER_NETWORK"\n' +
      "2026-05-02 09:00:00,,,,,MEMBER_NETWORK\n";
    writeFileSync(join(dir, "Shares.csv"), csv);

    const db = freshDb();
    const report = importLinkedInExport(db, dir);
    expect(report.inserted).toBe(1); // empty-commentary row skipped
    const row = db
      .query<{ text: string; platform: string }, []>("SELECT text, platform FROM corpus_docs")
      .get();
    expect(row?.platform).toBe("linkedin");
    expect(row?.text).toContain('a "quote", with commas');
    db.close();
  });
});
