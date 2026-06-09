import React from "react";
import { Box, Text } from "ink";

// ---- Purpose inference (pure function, testable) ----

// English stems + Chinese equivalents. \b only works for ASCII;
// Chinese characters match positionally without word boundaries.
const CATEGORIES: Array<[RegExp, string]> = [
  [/\b(read|look|view)|读取|看看|查看|浏览|阅读|检查/, "📖 正在读取代码"],
  [/\b(search|find|grep|locate)|搜索|查找|寻找|找找|定位/, "🔍 正在搜索代码库"],
  [/\b(edit|modify|writ|updat|chang|fix|refactor|implement)|修改|改|编辑|写|重写|更新|实现|修复|添加|删除/, "✏️ 正在编辑文件"],
  [/\b(analyz|analys|understand|debug|diagnos|investigat|think|reason)|分析|理解|了解|调试|思考|推理|排查/, "🤔 正在分析逻辑"],
];

const FALLBACK_PURPOSE = "🤔 思考中";

export function inferPurpose(reasoning: string): string {
  for (const [pattern, label] of CATEGORIES) {
    if (pattern.test(reasoning)) return label;
  }
  return FALLBACK_PURPOSE;
}

// ---- Component types ----

export interface ThinkingBlock {
  id: number;
  purpose: string;
  reasoning: string;
  isStreaming: boolean;
}

interface ThinkingAccordionProps {
  blocks: ThinkingBlock[];
  focusedIndex: number;
}

// ---- Component ----

export function ThinkingAccordion({ blocks, focusedIndex }: ThinkingAccordionProps) {
  if (blocks.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={1}>
      {blocks.map((block, i) => {
        const isFocused = i === focusedIndex;
        // Default collapsed: content only visible when explicitly focused.
        // During streaming, the spinner in the title signals activity.
        const isExpanded = isFocused;

        return (
          <Box key={block.id} flexDirection="column">
            <Box>
              <Text color={isFocused ? "cyan" : undefined} dimColor={!isFocused}>
                {isFocused ? "▸ " : "  "}
                {block.isStreaming ? "🤔 正在推理中..." : block.purpose}
                {block.isStreaming && (
                  <Text color="yellow"> ⏳</Text>
                )}
              </Text>
            </Box>
            {isExpanded && block.reasoning.length > 0 && (
              <Box marginLeft={4} marginBottom={1}>
                <Text dimColor>{block.reasoning}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
