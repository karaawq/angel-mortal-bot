import assert from "node:assert/strict";
import { parseCsv, parsePairings } from "../src/pairings.ts";

// Older one-pair-per-line text: mixed separators, optional header.
let r = parsePairings("angel,mortal\n@Alice_Tan, bob_lim\nbob_lim\tcharlie_ng\n\ncharlie_ng;alice_tan\n");
assert.deepEqual(r.pairs, [
  ["alice_tan", "bob_lim", null],
  ["bob_lim", "charlie_ng", null],
  ["charlie_ng", "alice_tan", null],
]);
assert.deepEqual(r.errors, []);
assert.deepEqual(r.warnings, []);

r = parsePairings("alice_tan bob_lim\nbob_lim alice_tan");
assert.deepEqual(r.errors, []);
assert.equal(r.pairs.length, 2);

r = parsePairings("alice_tan,alice_tan");
assert.ok(r.errors.some((e) => e.includes("themselves")));

r = parsePairings("alice_tan,bob_lim\nalice_tan,charlie_ng");
assert.ok(r.errors.some((e) => e.includes("angel more than once")));

r = parsePairings("alice_tan,bob_lim\ncharlie_ng,bob_lim");
assert.ok(r.errors.some((e) => e.includes("mortal more than once")));

r = parsePairings("alice_tan,bob_lim,preferences,extra");
assert.ok(r.errors.some((e) => e.includes("expected 3 columns")));

r = parsePairings("alice_tan,bob_lim\nal!ce,bob_lim");
assert.ok(r.errors.some((e) => e.includes("not a valid")));

r = parsePairings("alice_tan,bob_lim\nbob_lim,alice_tan");
assert.deepEqual(r.errors, []);
assert.ok(r.warnings.some((w) => w.includes("each other's")));

r = parsePairings("alice_tan,bob_lim");
assert.equal(r.warnings.length, 2); // open chain: alice has no angel, bob has no mortal

r = parsePairings("\n\n");
assert.ok(r.errors.includes("No pairings found."));

// CSV quoting, as Excel writes it.
assert.deepEqual(parseCsv('a,"b, c","say ""hi""","line1\r\nline2"\r\nd,e\r\n', ","), [
  ["a", "b, c", 'say "hi"', "line1\r\nline2"],
  ["d", "e"],
]);

// Excel "CSV UTF-8" export of the organiser's sheet: BOM, any header wording, quoted commas,
// emoji, a multi-line cell, and "nil" / "-" meaning nothing.
const excel =
  "﻿Angel tele handle,Mortal tele handle,Preferences\r\n" +
  '@Alice_Tan,@bob_lim,"mala/acai/koi (u the goat if u get pokemon packs but no pressure HAHA) and no spicy food"\r\n' +
  '@bob_lim,@charlie_ng,"chagee, protein milk (meiji choco or banana etc), acai, chobani"\r\n' +
  '@charlie_ng,@dana_lee,nil\r\n' +
  '@dana_lee,@alice_tan,"bubble tea with pearls\r\nAcai or anything cold and sweet"\r\n';
r = parsePairings(excel);
assert.deepEqual(r.errors, []);
assert.deepEqual(r.warnings, []);
assert.deepEqual(r.pairs, [
  ["alice_tan", "bob_lim", "mala/acai/koi (u the goat if u get pokemon packs but no pressure HAHA) and no spicy food"],
  ["bob_lim", "charlie_ng", "chagee, protein milk (meiji choco or banana etc), acai, chobani"],
  ["charlie_ng", "dana_lee", null],
  ["dana_lee", "alice_tan", "bubble tea with pearls\nAcai or anything cold and sweet"],
]);

// Rows pasted from a spreadsheet are tab-separated; likes only, or nothing, is fine.
r = parsePairings("alice_tan\tbob_lim\tcoffee, tea\nbob_lim\talice_tan\t\t\n");
assert.deepEqual(r.errors, []);
assert.deepEqual(r.pairs[0], ["alice_tan", "bob_lim", "coffee, tea"]);
assert.deepEqual(r.pairs[1], ["bob_lim", "alice_tan", null]);

// Semicolon CSVs (Excel in some regions).
r = parsePairings('angel;mortal;preferences\nalice_tan;bob_lim;"cats, dogs"\nbob_lim;alice_tan;coffee\n');
assert.deepEqual(r.errors, []);
assert.deepEqual(r.pairs[0], ["alice_tan", "bob_lim", "cats, dogs"]);
assert.deepEqual(r.pairs[1], ["bob_lim", "alice_tan", "coffee"]);

// Errors point at the spreadsheet row.
r = parsePairings(`angel,mortal,likes\nalice_tan,bob_lim,${"x".repeat(501)}`);
assert.ok(r.errors.some((e) => e.startsWith("Row 2:") && e.includes("max 500")));

console.log("pairings tests passed");
