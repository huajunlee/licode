import type { Segment, DiaryEntry } from "./types.js";
import type { DiaryExtractorLike, ExtractInput } from "./extractor.js";

export class DiarySession {
  private date: string;
  private id: string;
  private createdAt: string;
  private segments: Segment[] = [];

  constructor(date: string, now: Date) {
    this.date = date;
    this.id = now.getTime().toString(36);
    this.createdAt = now.toISOString();
  }

  addSegment(content: string, now: Date): void {
    this.segments.push({ timestamp: now.toISOString(), speaker: "user", content });
  }

  async end(extractor: DiaryExtractorLike, now: Date): Promise<DiaryEntry> {
    const input: ExtractInput = {
      id: this.id,
      date: this.date,
      createdAt: this.createdAt,
      endedAt: now.toISOString(),
      segments: this.segments,
      content: this.segments.map((s) => s.content).join("\n"),
    };
    return extractor.extract(input);
  }
}
