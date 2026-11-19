// Room contract shared by server and web (docs/design.md "Rooms").
export type RoomMember = "claude" | "codex";
export type SuggestionSource = "manual_import" | RoomMember;
export const ROOM_BRIEF_MAX = 4000;
export const ROOM_QUOTE_BYTES = 4000;
export const ROOM_EXCHANGE_TEXT = "Respond to the other participant's latest reply.";
export interface RoomOptions { documentId: string; brief?: string }
export interface RoomQuote { eventId: string; author: "user" | RoomMember; text: string; part: boolean }
export interface RoomSelection { baseRevisionId: string; startUtf16: number; endUtf16: number; originalText: string }
export interface RoomSuggestionEvent { suggestionId: string; documentId: string; agent: RoomMember; originalExcerpt: string; replacementExcerpt: string; reason?: string }
export interface RoomCreateInput { documentId: string; brief?: string; claudeModel?: string; codexModel?: string }
export interface RoomMessageInput { text: string; replyTo?: { eventId: string; part?: string }; selection?: RoomSelection }
