import { stripVTControlCharacters } from "node:util";

export function terminalText(value: string, limit = 160): string {
  const text = stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, Math.max(0, limit - 3)).join("")}...` : text;
}
