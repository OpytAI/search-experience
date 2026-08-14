/**
 * Schema contract: the shipped index/schema.sql must declare the objects
 * guest configure postconditions require (FTS, VANN, three content triggers).
 *
 * Full MATCH/VANN runtime acceptance is browser-e2e against //:release.
 */
import { assert } from "./assert.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const schemaPath = resolve("index/schema.sql");
const schema = readFileSync(schemaPath, "utf8");

assert(schema.includes("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts"), "chunks_fts virtual table");
assert(schema.includes("USING fts5"), "fts5 engine");
assert(schema.includes("CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec"), "chunk_vec virtual table");
assert(schema.includes("USING vann"), "vann engine");
assert(schema.includes("CREATE TRIGGER IF NOT EXISTS chunks_fts_insert"), "fts insert trigger");
assert(schema.includes("CREATE TRIGGER IF NOT EXISTS chunks_fts_delete"), "fts delete trigger");
assert(schema.includes("CREATE TRIGGER IF NOT EXISTS chunks_fts_update"), "fts update trigger");

// Trigger bodies contain internal semicolons — naive split would break them.
const updateTrigger = schema.slice(schema.indexOf("CREATE TRIGGER IF NOT EXISTS chunks_fts_update"));
const endIdx = updateTrigger.indexOf("END;");
assert(endIdx > 0, "update trigger has END");
const body = updateTrigger.slice(0, endIdx);
const internalSemis = (body.match(/;/g) ?? []).length;
assert(internalSemis >= 2, "update trigger body has internal semicolons (must not be split-on-;)");

// Comment lines precede virtual-table DDL (the old split bug skipped these).
const ftsIdx = schema.indexOf("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts");
const beforeFts = schema.slice(0, ftsIdx);
assert(beforeFts.includes("-- External-content FTS"), "comment precedes chunks_fts");
const vecIdx = schema.indexOf("CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec");
const beforeVec = schema.slice(0, vecIdx);
assert(beforeVec.includes("-- VANN uses the same rowid"), "comment precedes chunk_vec");

console.log("schema-contract: ok");
