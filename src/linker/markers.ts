import { OBAGENTS_END_MARKER, OBAGENTS_START_PREFIX } from "../utils/constants.js";

const START_REGEX = /<!--\s*obagents:start[^>]*?-->\n?/i;
const END_REGEX = /<!--\s*obagents:end\s*-->\n?/i;
const BLOCK_REGEX = /<!--\s*obagents:start[^>]*?-->[\s\S]*?<!--\s*obagents:end\s*-->\n?/i;

function blockRegexFor(agentName?: string): RegExp {
  if (!agentName) return BLOCK_REGEX;
  const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `<!--\\s*obagents:start[^>]*?agent="${escaped}"[^>]*?-->[\\s\\S]*?<!--\\s*obagents:end\\s*-->\\n?`,
    "i",
  );
}

export function buildStartMarker(agentName: string, generatedIso = new Date().toISOString()): string {
  return `<!-- obagents:start agent="${agentName}" generated="${generatedIso}" -->`;
}

export function buildEndMarker(): string {
  return OBAGENTS_END_MARKER;
}

export function buildBlock(content: string, agentName: string, generatedIso?: string): string {
  return `${buildStartMarker(agentName, generatedIso)}\n${content.trim()}\n${buildEndMarker()}`;
}

export function hasBlock(fileContent: string, agentName?: string): boolean {
  return blockRegexFor(agentName).test(fileContent);
}

function blockStartTag(block: string): string {
  return /<!--\s*obagents:start[^>]*?-->/.exec(block)?.[0] ?? "";
}

function firstLegacyBlock(content: string): { index: number; length: number } | null {
  const regex = new RegExp(BLOCK_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const agentAttr = /agent="([^"]*)"/i.exec(blockStartTag(match[0]));
    if (!agentAttr || agentAttr[1] === "hive") {
      return { index: match.index, length: match[0].length };
    }
  }
  return null;
}

export function hasLegacyBlock(fileContent: string): boolean {
  return firstLegacyBlock(fileContent) !== null;
}

export function hasAgentScopedBlock(fileContent: string): boolean {
  const regex = new RegExp(BLOCK_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(fileContent)) !== null) {
    const agentAttr = /agent="([^"]*)"/i.exec(blockStartTag(match[0]));
    if (agentAttr && agentAttr[1] !== "hive") {
      return true;
    }
  }
  return false;
}

export function removeLegacyBlock(existingContent: string): string {
  const found = firstLegacyBlock(existingContent);
  if (!found) {
    return existingContent;
  }
  const remaining =
    existingContent.slice(0, found.index) + existingContent.slice(found.index + found.length);
  return remaining.replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "").replace(/\s+$/, "") + "\n";
}

export function injectBlock(existingContent: string, block: string, agentName?: string): string {
  const trimmed = existingContent.replace(/\s+$/, "");
  if (hasBlock(existingContent, agentName)) {
    const regex = blockRegexFor(agentName);
    return existingContent.replace(regex, () => block + "\n");
  }
  const legacy = firstLegacyBlock(existingContent);
  if (legacy) {
    return (
      existingContent.slice(0, legacy.index) +
      block +
      "\n" +
      existingContent.slice(legacy.index + legacy.length)
    );
  }
  if (trimmed.length === 0) {
    return block + "\n";
  }
  return `${trimmed}\n\n${block}\n`;
}

export function removeBlock(existingContent: string, agentName?: string): string {
  const regex = new RegExp(blockRegexFor(agentName).source, "gi");
  const remaining = existingContent.replace(regex, "").replace(/\n{3,}/g, "\n\n");
  return remaining.replace(/^\s+/, "").replace(/\s+$/, "") + (remaining.endsWith("\n") ? "" : "\n");
}

export function extractBlockContent(fileContent: string, agentName?: string): string | null {
  const match = blockRegexFor(agentName).exec(fileContent);
  if (!match) return null;
  const block = match[0];
  const inner = block.replace(START_REGEX, "").replace(END_REGEX, "");
  return inner.trim();
}

export function isStartMarker(line: string): boolean {
  return line.trim().startsWith(OBAGENTS_START_PREFIX);
}

export function isEndMarker(line: string): boolean {
  return END_REGEX.test(line);
}