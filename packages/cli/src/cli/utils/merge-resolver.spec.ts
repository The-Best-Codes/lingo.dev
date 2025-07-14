import { describe, it, expect } from "vitest";
import { ConflictParser } from "./conflict-parser";
import { ConflictResolver } from "./merge-resolver";
import * as fs from "fs";
import * as path from "path";

describe("ConflictParser", () => {
  it("should detect conflict markers", () => {
    const content = `
{
  "version": 0.1,
<<<<<<< HEAD
  "ours": true
=======
  "theirs": true
>>>>>>> branch
}`;
    expect(ConflictParser.hasConflictMarkers(content)).toBe(true);
  });

  it("should parse simple conflict", () => {
    const content = `
{
  "version": 0.1,
<<<<<<< HEAD
  "ours": true
=======
  "theirs": true
>>>>>>> branch
}`;
    const conflicts = ConflictParser.parseConflicts(content);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].ours.trim()).toBe('"ours": true');
    expect(conflicts[0].theirs.trim()).toBe('"theirs": true');
  });

  it("should resolve conflicts with custom resolver", () => {
    const content = `
{
  "version": 0.1,
<<<<<<< HEAD
  "ours": true
=======
  "theirs": true
>>>>>>> branch
}`;
    const resolved = ConflictParser.resolveConflicts(
      content,
      () => '"merged": true',
    );
    expect(resolved).toContain('"merged": true');
    expect(resolved).not.toContain("<<<<<<<");
    expect(resolved).not.toContain("=======");
    expect(resolved).not.toContain(">>>>>>>");
  });
});

describe("ConflictResolver", () => {
  const mockMetaConflict = `{
  "version": 0.1,
  "files": {
    "App.tsx": {
      "scopes": {
<<<<<<< HEAD
        "existing-scope": {
          "type": "element",
          "hash": "old-hash",
          "content": "Old content"
        },
        "our-scope": {
          "type": "element", 
          "hash": "our-hash",
          "content": "Our content"
        }
=======
        "existing-scope": {
          "type": "element",
          "hash": "new-hash",
          "content": "Updated content with more details"
        },
        "their-scope": {
          "type": "element",
          "hash": "their-hash", 
          "content": "Their content"
        }
>>>>>>> branch
      }
    }
  }
}`;

  const mockDictionaryConflict = `export default {
  version: 0.1,
  files: {
    "App.tsx": {
      entries: {
<<<<<<< HEAD
        "scope-1": {
          content: {
            en: "English",
            es: "Español"
          },
          hash: "hash1"
        }
=======
        "scope-1": {
          content: {
            en: "English Updated",
            fr: "Français"
          },
          hash: "hash2"
        },
        "scope-2": {
          content: {
            en: "New entry"
          },
          hash: "hash3"
        }
>>>>>>> branch
      }
    }
  }
};`;

  it("should merge meta.json conflicts intelligently", () => {
    const resolver = new ConflictResolver({
      strategy: "smart",
      verbose: false,
      dryRun: true,
      backup: false,
    });

    const conflicts = ConflictParser.parseConflicts(mockMetaConflict);
    expect(conflicts).toHaveLength(1);

    // Test the full resolution flow
    const resolved = ConflictParser.resolveConflicts(
      mockMetaConflict,
      (conflict) => {
        return (resolver as any).smartResolveMeta(conflict);
      },
    );

    const parsed = JSON.parse(resolved);

    // Should contain both our-scope and their-scope
    expect(parsed.files["App.tsx"].scopes["our-scope"]).toBeDefined();
    expect(parsed.files["App.tsx"].scopes["their-scope"]).toBeDefined();

    // Should prefer the longer content for existing-scope
    expect(parsed.files["App.tsx"].scopes["existing-scope"].content).toBe(
      "Updated content with more details",
    );
  });

  it("should merge dictionary conflicts intelligently", () => {
    const resolver = new ConflictResolver({
      strategy: "smart",
      verbose: false,
      dryRun: true,
      backup: false,
    });

    const conflicts = ConflictParser.parseConflicts(mockDictionaryConflict);
    expect(conflicts).toHaveLength(1);

    // Test the full resolution flow
    const resolved = ConflictParser.resolveConflicts(
      mockDictionaryConflict,
      (conflict) => {
        return (resolver as any).smartResolveDictionary(conflict);
      },
    );

    // Should be valid JavaScript
    expect(resolved).toContain("export default");

    // Parse the resolved dictionary
    const objectContent = resolved
      .replace(/^export\s+default\s+/, "")
      .replace(/;?\s*$/, "");
    const parsed = Function(`"use strict"; return (${objectContent})`)();

    // Should contain both scopes
    expect(parsed.files["App.tsx"].entries["scope-1"]).toBeDefined();
    expect(parsed.files["App.tsx"].entries["scope-2"]).toBeDefined();

    // Should merge translations
    const scope1 = parsed.files["App.tsx"].entries["scope-1"];
    expect(scope1.content.en).toBe("English Updated"); // Prefer non-empty
    expect(scope1.content.es).toBe("Español"); // Keep from ours
    expect(scope1.content.fr).toBe("Français"); // Add from theirs
  });
});
