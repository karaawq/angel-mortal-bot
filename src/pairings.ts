/** One pairing, plus the mortal's preferences (null when not given). */
export type Pair = [angel: string, mortal: string, roomNumber: string | null, preferences: string | null];

export interface ParseResult {
  pairs: Pair[];
  errors: string[];
  warnings: string[];
}

const USERNAME = /^[a-z0-9_]{4,32}$/;

/** Cells that mean "nothing", so the angel doesn't see an empty preference. */
const PLACEHOLDER = /^(nil|none|nothing|null|na|n\/a|-+|–|—)$/i;

/** Long enough for a few sentences, short enough that the welcome stays under Telegram's limit. */
export const MAX_INFO_LENGTH = 500;

/** Whether an already-normalised handle could be a Telegram username. */
export const isValidHandle = (handle: string) => USERNAME.test(handle);

export function normaliseHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/**
 * Splits CSV text into rows of cells: quoted cells may hold the delimiter, line breaks and ""
 * escapes, as Excel and Google Sheets write them.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && !cell.trim()) {
      quoted = true;
      cell = "";
    } else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

/** Tab for rows pasted from a spreadsheet, semicolon for CSVs from some Excel locales, else comma. */
function detectDelimiter(text: string): string {
  const first = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/"[^"]*"/g, "");
  if (first.includes("\t")) return "\t";
  if (!first.includes(",") && first.includes(";")) return ";";
  return ",";
}

/** A preferences cell, or null if it's empty or a placeholder like "nil". */
function infoCell(raw: string | undefined): string | null {
  const value = (raw ?? "").replace(/\r\n?/g, "\n").trim();
  return value && !PLACEHOLDER.test(value) ? value : null;
}

/**
 * Parses "angel,mortal[,room_number,preferences]" rows: a CSV file (comma or semicolon), rows pasted from a
 * spreadsheet (tab), or the older one-pair-per-line text (comma, tab, semicolon or space).
 * Errors block the upload; warnings are reported but allowed.
 */
export function parsePairings(text: string): ParseResult {
  const pairs: Pair[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  text = text.replace(/^﻿/, "");
  const rows = parseCsv(text, detectDelimiter(text));
  let seenRow = false;

  rows.forEach((cells, i) => {
    const row = `Row ${i + 1}`;
    while (cells.length && !cells[cells.length - 1].trim()) cells.pop();
    if (!cells.length || cells[0].trim().startsWith("#")) return;

    // A single cell is an older-style line like "alice bob" or "alice;bob".
    if (cells.length === 1) cells = cells[0].split(/[,\t;\s]+/).filter(Boolean);
    const [angel, mortal] = cells.slice(0, 2).map(normaliseHandle);

    // Header row: the first row, if it's "angel,mortal…" or its handles aren't usernames at all.
    const isFirst = !seenRow;
    seenRow = true;
    const looksLikeHeader = (/^angel/.test(angel ?? "") && /^mortal/.test(mortal ?? "")) || (!isValidHandle(angel ?? "") && !isValidHandle(mortal ?? ""));
    if (isFirst && looksLikeHeader) return;

    if (cells.length < 2) {
      errors.push(`${row}: expected "angel,mortal" but got "${cells.join(" ")}"`);
      return;
    }
    if (cells.length > 4) {
      errors.push(`${row}: expected 4 columns (angel, mortal, room_number, preferences) but found ${cells.length}`);
      return;
    }
    for (const h of [angel, mortal]) {
      if (!isValidHandle(h)) errors.push(`${row}: "@${h}" is not a valid Telegram username`);
    }
    if (angel === mortal) errors.push(`${row}: @${angel} is paired with themselves`);
    const roomNumber = infoCell(cells[2]);
    const preferences = infoCell(cells[3]);
    if (preferences && preferences.length > MAX_INFO_LENGTH) {
      errors.push(`${row}: @${mortal}'s preferences are ${preferences.length} characters long (max ${MAX_INFO_LENGTH})`);
    }
    pairs.push([angel, mortal, roomNumber, preferences]);
  });

  if (pairs.length === 0 && errors.length === 0) errors.push("No pairings found.");

  const angels = new Set<string>();
  const mortals = new Set<string>();
  for (const [a, m] of pairs) {
    if (angels.has(a)) errors.push(`@${a} is listed as an angel more than once`);
    if (mortals.has(m)) errors.push(`@${m} is listed as a mortal more than once`);
    angels.add(a);
    mortals.add(m);
  }

  for (const h of angels) if (!mortals.has(h)) warnings.push(`@${h} has a mortal but no angel`);
  for (const h of mortals) if (!angels.has(h)) warnings.push(`@${h} has an angel but no mortal`);

  const pairSet = new Set(pairs.map(([a, m]) => `${a}>${m}`));
  for (const [a, m] of pairs) {
    if (a < m && pairSet.has(`${m}>${a}`)) {
      warnings.push(`@${a} and @${m} are each other's angel AND mortal, so they can work out who their angel is`);
    }
  }

  return { pairs, errors, warnings };
}
