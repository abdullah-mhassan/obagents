import { TargetAdapterEngine } from "./engine.js";

/** @deprecated Use `TargetAdapterEngine.buildStartMarker` instead. */
export function buildStartMarker(agentName: string, generatedIso?: string): string {
  return TargetAdapterEngine.buildStartMarker(agentName, generatedIso);
}

/** @deprecated Use `TargetAdapterEngine.buildEndMarker` instead. */
export function buildEndMarker(): string {
  return TargetAdapterEngine.buildEndMarker();
}

/** @deprecated Use `TargetAdapterEngine.buildBlock` instead. */
export function buildBlock(content: string, agentName: string, generatedIso?: string): string {
  return TargetAdapterEngine.buildBlock(content, agentName, generatedIso);
}

/** @deprecated Use `TargetAdapterEngine.hasBlock` instead. */
export function hasBlock(fileContent: string, agentName?: string): boolean {
  return TargetAdapterEngine.hasBlock(fileContent, agentName);
}

/** @deprecated Use `TargetAdapterEngine.hasLegacyBlock` instead. */
export function hasLegacyBlock(fileContent: string): boolean {
  return TargetAdapterEngine.hasLegacyBlock(fileContent);
}

/** @deprecated Use `TargetAdapterEngine.hasAgentScopedBlock` instead. */
export function hasAgentScopedBlock(fileContent: string): boolean {
  return TargetAdapterEngine.hasAgentScopedBlock(fileContent);
}

/** @deprecated Use `TargetAdapterEngine.removeLegacyBlock` instead. */
export function removeLegacyBlock(existingContent: string): string {
  return TargetAdapterEngine.removeLegacyBlock(existingContent);
}

/** @deprecated Use `TargetAdapterEngine.injectBlock` instead. */
export function injectBlock(existingContent: string, block: string, agentName?: string): string {
  return TargetAdapterEngine.injectBlock(existingContent, block, agentName);
}

/** @deprecated Use `TargetAdapterEngine.removeBlock` instead. */
export function removeBlock(existingContent: string, agentName?: string): string {
  return TargetAdapterEngine.removeBlock(existingContent, agentName);
}

/** @deprecated Use `TargetAdapterEngine.extractBlockContent` instead. */
export function extractBlockContent(fileContent: string, agentName?: string): string | null {
  return TargetAdapterEngine.extractBlockContent(fileContent, agentName);
}

/** @deprecated Use `TargetAdapterEngine.isStartMarker` instead. */
export function isStartMarker(line: string): boolean {
  return TargetAdapterEngine.isStartMarker(line);
}

/** @deprecated Use `TargetAdapterEngine.isEndMarker` instead. */
export function isEndMarker(line: string): boolean {
  return TargetAdapterEngine.isEndMarker(line);
}