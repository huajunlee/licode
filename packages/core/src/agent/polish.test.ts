import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { polishAnswer, shouldPolish } from "./polish.js";
import { AgentLoop } from "./loop.js";
import { ConversationManager } from "../conversation/manager.js";
import { ToolRegistry } from "../tools/registry.js";
import { SkillLoader, type Skill } from "../extensions/skills/loader.js";
import type { LLMProvider, ChatRequest, StreamChunk, Message } from "../llm/provider.js";

const RULES = "改写规则：删掉加粗强调与填充语，其余原样保留。";

/** 记录 chat() 调用的假 provider；stream() 吐一段固定文本 */
function fakeLLM(opts: {
  answer?: string;
  polish?: string | (() => string);
  onChat?: (req: ChatRequest) => void;
  throwOnChat?: boolean;
}): LLMProvider {
  return {
    name: "fake",
    maxContextTokens: 100_000,
    countTokens: () => 0,
    async chat(req: ChatRequest) {
      opts.onChat?.(req);
      if (opts.throwOnChat) throw new Error("polish 调用失败");
      const p = opts.polish ?? "改写后的文本";
      return {
        content: typeof p === "function" ? p() : p,
        usage: { input: 1, output: 1 },
        stopReason: "end_turn",
      };
    },
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "token", text: opts.answer ?? "模型原始回答", index: 0 };
      yield { type: "stop", stopReason: "end_turn", usage: { input: 1, output: 1 } };
    },
  } as unknown as LLMProvider;
}

function makeLoop(llm: LLMProvider, skills: Skill[], seedRead?: string) {
  const conversation = new ConversationManager({ model: "m" });
  if (seedRead) {
    // 伪造一次「读过该技能的 SKILL.md」
    conversation.addToolMessages(
      [{ id: "tu1", name: "Read", input: { file_path: path.join(seedRead, "SKILL.md") } }],
      [{ status: "success", content: "技能正文" }]
    );
  }
  const loop = new AgentLoop({
    llm,
    conversation,
    tools: new ToolRegistry(),
    skills,
  });
  return { loop, conversation };
}

const DECIDE: Skill = { name: "decide", description: "决策", dir: "/x/decide", polishWith: "shuorenhua", polishBody: RULES };
const SHUO: Skill = { name: "shuorenhua", description: "说人话", dir: "/x/shuorenhua" };

describe("shouldPolish", () => {
  it("规则与草稿都在才改写", () => {
    expect(shouldPolish(DECIDE, "草稿")).toBe(true);
    expect(shouldPolish({ ...DECIDE, polishBody: undefined }, "草稿")).toBe(false);
    expect(shouldPolish(DECIDE, "   ")).toBe(false);
    expect(shouldPolish(undefined, "草稿")).toBe(false);
  });
});

describe("polishAnswer", () => {
  it("返回改写稿，且默认关掉思考（thinking 吃光预算会让正文为空）", async () => {
    let seen: ChatRequest | undefined;
    const out = await polishAnswer({
      skill: DECIDE,
      llm: fakeLLM({ polish: "改写稿", onChat: (r) => (seen = r) }),
      model: "m",
      draft: "原稿",
    });
    expect(out).toBe("改写稿");
    expect((seen!.extensions as { thinking?: { type: string } })?.thinking?.type).toBe("disabled");
  });

  it("第一道拿不到正文时，用大预算再试一次", async () => {
    let calls = 0;
    const llm = fakeLLM({
      polish: () => (++calls === 1 ? "" : "第二次的改写稿"),
    });
    const out = await polishAnswer({ skill: DECIDE, llm, model: "m", draft: "原稿" });
    expect(calls).toBe(2);
    expect(out).toBe("第二次的改写稿");
  });

  it("两道都拿不到正文时保留原稿——绝不交付空答案", async () => {
    const out = await polishAnswer({
      skill: DECIDE,
      llm: fakeLLM({ polish: () => "" }),
      model: "m",
      draft: "原稿",
    });
    expect(out).toBe("原稿");
  });

  it("调用抛错时也保留原稿", async () => {
    const out = await polishAnswer({
      skill: DECIDE,
      llm: fakeLLM({ throwOnChat: true }),
      model: "m",
      draft: "原稿",
    });
    expect(out).toBe("原稿");
  });
});

describe("交付前强制改写（harness 层保证）", () => {
  it("读过声明了 polishWith 的技能 → 最终回答被改写并落盘", async () => {
    const { loop, conversation } = makeLoop(fakeLLM({ answer: "原始回答", polish: "改写后的回答" }), [DECIDE, SHUO], DECIDE.dir);
    await loop.run("问题");
    const last = conversation.getMessages().at(-1) as { content: string };
    expect(last.content).toBe("改写后的回答");
  });

  it("没读过该技能 → 不改写（避免无关对话被无谓改写）", async () => {
    const { loop, conversation } = makeLoop(fakeLLM({ answer: "原始回答", polish: "改写后的回答" }), [DECIDE, SHUO]);
    await loop.run("问题");
    const last = conversation.getMessages().at(-1) as { content: string };
    expect(last.content).toBe("原始回答");
  });

  it("polishWith 指向的技能不存在 → 不改写，且不报错", async () => {
    const { loop, conversation } = makeLoop(fakeLLM({ answer: "原始回答" }), [DECIDE], DECIDE.dir);
    await loop.run("问题");
    const last = conversation.getMessages().at(-1) as { content: string };
    expect(last.content).toBe("原始回答");
  });

  it("改写调用抛错 → 回退到原稿，不打断交付", async () => {
    const { loop, conversation } = makeLoop(fakeLLM({ answer: "原始回答", throwOnChat: true }), [DECIDE, SHUO], DECIDE.dir);
    await loop.run("问题");
    const last = conversation.getMessages().at(-1) as { content: string };
    expect(last.content).toBe("原始回答");
  });
});

describe("SkillLoader 解析 polishWith", () => {
  it("读出 polishWith 并回填目标技能正文", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
    try {
      for (const [name, fm, body] of [
        ["decide", "name: decide\ndescription: 决策\npolishWith: shuorenhua", "决策正文"],
        ["shuorenhua", "name: shuorenhua\ndescription: 说人话", "改写规则正文"],
      ] as const) {
        fs.mkdirSync(path.join(dir, name));
        fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\n${fm}\n---\n\n${body}\n`);
      }
      const skills = await new SkillLoader().loadAll(dir);
      const decide = skills.find((s) => s.name === "decide")!;
      expect(decide.polishWith).toBe("shuorenhua");
      expect(decide.polishBody).toBe("改写规则正文");
      // 目标技能自身没有该声明
      expect(skills.find((s) => s.name === "shuorenhua")!.polishWith).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("没有 polishWith 声明的技能不受影响", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
    try {
      fs.mkdirSync(path.join(dir, "plain"));
      fs.writeFileSync(path.join(dir, "plain", "SKILL.md"), "---\nname: plain\ndescription: x\n---\n\n正文\n");
      const skills = await new SkillLoader().loadAll(dir);
      expect(skills[0].polishWith).toBeUndefined();
      expect(skills[0].polishBody).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
