import type { DiaryEntry, Segment } from "./types.js";

export interface DiaryExtractorConfig {
  generate: (prompt: string) => Promise<string>;
}

export interface ExtractInput {
  id: string;
  date: string;
  createdAt: string;
  endedAt: string;
  segments: Segment[];
  content: string;
}

export interface DiaryExtractorLike {
  extract(input: ExtractInput): Promise<DiaryEntry>;
}

interface ExtractedFields {
  summary: string;
  facts: DiaryEntry["facts"];
  decisions: DiaryEntry["decisions"];
  emotions: DiaryEntry["emotions"];
  people: DiaryEntry["people"];
  futureMemory: DiaryEntry["futureMemory"];
}

const FALLBACK_SUMMARY = "（自动抽取失败，仅保留原文）";

export class DiaryExtractor implements DiaryExtractorLike {
  constructor(private config: DiaryExtractorConfig) {}

  async extract(input: ExtractInput): Promise<DiaryEntry> {
    const meta = { id: input.id, date: input.date, createdAt: input.createdAt, endedAt: input.endedAt };
    const raw = { content: input.content, segments: input.segments };
    try {
      const prompt = this.buildPrompt(input.segments);
      const fields = this.parse(await this.config.generate(prompt));
      return { meta, raw, ...fields };
    } catch {
      return { meta, raw, summary: FALLBACK_SUMMARY, facts: [], decisions: [], emotions: [], people: [], futureMemory: [] };
    }
  }

  private buildPrompt(segments: Segment[]): string {
    const transcript = segments.map((s) => `[${s.timestamp}] ${s.speaker}: ${s.content}`).join("\n");
    return [
      "你是一个日记结构化抽取器。从下面的用户日记原文抽取结构化字段。",
      "总原则：不臆造（没说留 null）、推断必标注、宁可少收不要错收、语言跟随用户（中文）。",
      "",
      "逐字段规则：",
      "- summary: 2-3 句叙事摘要，只叙事不解读。",
      "- facts: 离散事件，每条一句话，去重，跳过无关琐事。{what, when, tags}",
      "- decisions: 只收明确决定，不猜意图；有理由附 reasoning。{decision, reasoning, context}",
      "- emotions: 从内容推断，标 inferred=true，必带 trigger。{state, intensity:1-5, trigger, inferred}",
      "- people: 每个被提到的人都收；关系能推断就填并标 relationInferred；interaction 写这次互动；note 收暴露的喜好/特质。{name, relation, relationInferred, interaction, note}",
      "- futureMemory: 只收“今天之后还可能重要”且“非例行流水账”的。{content, type:person_trait|preference|relationship|decision|goal|other, importance:low|medium|high, promotability:low|medium|high, reason}",
      "",
      "原文：",
      transcript,
      "",
      "只返回一个 JSON 对象，不要任何额外文字：",
      '{"summary":"...","facts":[...],"decisions":[...],"emotions":[...],"people":[...],"futureMemory":[...]}',
    ].join("\n");
  }

  private parse(raw: string): ExtractedFields {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("no JSON object in extractor response");
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(s.slice(start, end + 1));
    } catch (e) {
      throw new Error(`invalid JSON in extractor response: ${(e as Error).message}`);
    }
    return {
      summary: typeof obj.summary === "string" ? obj.summary : "",
      facts: Array.isArray(obj.facts) ? (obj.facts as ExtractedFields["facts"]) : [],
      decisions: Array.isArray(obj.decisions) ? (obj.decisions as ExtractedFields["decisions"]) : [],
      emotions: Array.isArray(obj.emotions) ? (obj.emotions as ExtractedFields["emotions"]) : [],
      people: Array.isArray(obj.people) ? (obj.people as ExtractedFields["people"]) : [],
      futureMemory: Array.isArray(obj.futureMemory) ? (obj.futureMemory as ExtractedFields["futureMemory"]) : [],
    };
  }
}
