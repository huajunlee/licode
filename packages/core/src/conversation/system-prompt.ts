import { TokenCounter } from "../llm/token-counter.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * System Prompt 分层定义。
 * always=true 的层永远发送，不参与 token 预算裁剪。
 * priority 越小越靠前。
 */export interface SystemPromptLayer {
  name: string;
  priority: number;
  always: boolean;
  content: string;
}

const LAYER_DEFINITIONS: Array<{
  name: string;
  priority: number;
  always: boolean;
  file: string;
}> = [
  { name: "role", priority: 0, always: true, file: "role.md" },
  { name: "safety", priority: 1, always: true, file: "safety.md" },
  { name: "tool-use", priority: 10, always: false, file: "tool-use.md" },
];

export function loadDefaultLayers(
  templatesDir?: string
): SystemPromptLayer[] {
  const dir =
    templatesDir ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "templates"
    );

  const layers: SystemPromptLayer[] = [];
  for (const def of LAYER_DEFINITIONS) {
    const filePath = path.join(dir, def.file);
    try {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) {
        layers.push({
          name: def.name,
          priority: def.priority,
          always: def.always,
          content,
        });
      }
    } catch {
      // Skip missing template files
    }
  }
  return layers;
}

export class SystemPrompt {
  private layers: SystemPromptLayer[] = [];
  private tokenCounter = new TokenCounter();

  addLayer(layer: SystemPromptLayer): void {
    this.removeLayer(layer.name);
    this.layers.push(layer);
    this.layers.sort((a, b) => a.priority - b.priority);
  }

  removeLayer(name: string): void {
    this.layers = this.layers.filter((l) => l.name !== name);
  }

  /**
   * 按 token 预算裁剪并拼接最终 System Prompt。
   *
   * 算法：
   * 1. 永远层（role, safety）优先保证
   * 2. 可裁剪层按 priority 升序填入
   * 3. 当剩余预算不足以容纳下一个完整层时，尝试截断填充
   */
  assemble(budget: number): string {
    if (this.layers.length === 0) return "";

    const alwaysLayers = this.layers.filter((l) => l.always);
    const optionalLayers = this.layers
      .filter((l) => !l.always)
      .sort((a, b) => a.priority - b.priority);

    const parts: string[] = [];
    let used = 0;

    for (const layer of alwaysLayers) {
      const tokens = this.tokenCounter.estimate(layer.content);
      parts.push(layer.content);
      used += tokens;
    }

    for (const layer of optionalLayers) {
      const tokens = this.tokenCounter.estimate(layer.content);
      if (used + tokens <= budget) {
        parts.push(layer.content);
        used += tokens;
      } else if (used < budget) {
        const available = budget - used;
        const truncated = this.truncateToTokens(layer.content, available);
        if (truncated.length > 0) {
          parts.push(truncated);
        }
        break;
      }
    }

    return parts.join("\n\n");
  }

  getLayers(): ReadonlyArray<SystemPromptLayer> {
    return this.layers;
  }

  private truncateToTokens(text: string, maxTokens: number): string {
    // Conservative truncation: estimate and cut
    const words = text.split(/\s+/);
    let result = "";
    for (const word of words) {
      const candidate = result ? result + " " + word : word;
      if (this.tokenCounter.estimate(candidate) > maxTokens) break;
      result = candidate;
    }
    return result;
  }
}
