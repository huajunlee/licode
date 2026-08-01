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
      const prompt = this.buildPrompt(input.segments, input.date);
      const fields = this.parse(await this.config.generate(prompt));
      return { meta, raw, ...fields };
    } catch {
      return { meta, raw, summary: FALLBACK_SUMMARY, facts: [], decisions: [], emotions: [], people: [], futureMemory: [] };
    }
  }

  private buildPrompt(segments: Segment[], date: string): string {
    const transcript = segments.map((s) => `[${s.timestamp}] ${s.speaker}: ${s.content}`).join("\n");
    return [
      "你是一个日记结构化抽取器。从下面的用户日记原文抽取结构化字段。",
      "总原则：不臆造（没说留 null）、推断必标注、宁可少收不要错收、语言跟随用户（中文）。",
      `今天是 ${date}。所有相对时间（下个月、昨天、上周、下周等）一律转成绝对日期（基于今天 ${date}），写入 facts.when / futureMemory.content / decisions 等字段。`,
      "",
      "逐字段规则：",
      "- summary: 2-3 句叙事摘要，只叙事不解读。",
      "- facts: 离散事件，每条一句话，去重，跳过无关琐事。{what, when, tags}",
      "- decisions: 只收明确决定，不猜意图；有理由附 reasoning。{decision, reasoning, context}",
      "- emotions: 从内容推断，标 inferred=true，必带 trigger。{state, intensity:1-5, trigger, inferred}",
      "- people: 每个被提到的人都收；关系能推断就填并标 relationInferred；interaction 写这次互动；note 收暴露的喜好/特质；specific=true 表示专有名字（王总/妈妈/张三），false 表示泛称（朋友/同事/老板）。{name, relation, relationInferred, interaction, note, specific}",
      "- futureMemory: 只收“今天之后还可能重要”且“非例行流水账”的。type 语义：person_trait=某人的特质或喜好（王总爱喝茶）；preference=用户自己的偏好（我喜欢早起）；relationship=关系状态；decision=决定；goal=目标；other=其它。{content, type:person_trait|preference|relationship|decision|goal|other, importance:low|medium|high, promotability:low|medium|high, reason}",
      "",
      "原文：",
      transcript,
      "",
      "只返回一个 JSON 对象，不要任何额外文字：",
      '{"summary":"...","facts":[...],"decisions":[...],"emotions":[...],"people":[{"name":"...","relation":null,"relationInferred":false,"interaction":"...","note":null,"specific":true}],"futureMemory":[...]}',
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
