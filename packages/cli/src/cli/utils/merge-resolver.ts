import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { ConflictParser, ConflictSection } from "./conflict-parser";

export interface ResolverOptions {
  strategy: "smart" | "ours" | "theirs";
  verbose: boolean;
  dryRun: boolean;
  backup: boolean;
}

export interface ResolutionResult {
  success: boolean;
  conflictsResolved: number;
  error?: string;
  details?: string;
}

export class ConflictResolver {
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit

  constructor(private options: ResolverOptions) {}

  async resolveFile(filePath: string): Promise<ResolutionResult> {
    try {
      // Check file size
      const stats = fs.statSync(filePath);
      if (stats.size > this.MAX_FILE_SIZE) {
        return {
          success: false,
          conflictsResolved: 0,
          error: `File too large: ${stats.size} bytes (max: ${this.MAX_FILE_SIZE})`,
        };
      }

      const content = fs.readFileSync(filePath, "utf-8");

      if (!ConflictParser.hasConflictMarkers(content)) {
        return {
          success: true,
          conflictsResolved: 0,
          details: "No conflicts found",
        };
      }

      const conflicts = ConflictParser.parseConflicts(content);

      if (conflicts.length === 0) {
        return {
          success: false,
          conflictsResolved: 0,
          error: "Invalid conflict markers detected",
        };
      }

      // Create backup if requested
      if (this.options.backup && !this.options.dryRun) {
        const backupPath = `${filePath}.backup.${randomUUID()}`;
        fs.writeFileSync(backupPath, content);
      }

      // Resolve conflicts
      const resolvedContent = ConflictParser.resolveConflicts(
        content,
        (conflict) => {
          return this.resolveConflict(conflict, filePath);
        },
      );

      // Validate the resolved content
      const validation = this.validateResolvedContent(
        resolvedContent,
        filePath,
      );
      if (!validation.valid) {
        return {
          success: false,
          conflictsResolved: 0,
          error: validation.error,
        };
      }

      // Write resolved content
      if (!this.options.dryRun) {
        fs.writeFileSync(filePath, resolvedContent);
      }

      return {
        success: true,
        conflictsResolved: conflicts.length,
        details: this.options.verbose
          ? this.getResolutionDetails(conflicts, filePath)
          : undefined,
      };
    } catch (error: any) {
      return {
        success: false,
        conflictsResolved: 0,
        error: error.message,
      };
    }
  }

  private resolveConflict(conflict: ConflictSection, filePath: string): string {
    const fileName = path.basename(filePath);

    switch (this.options.strategy) {
      case "ours":
        return conflict.ours;
      case "theirs":
        return conflict.theirs;
      case "smart":
      default:
        return this.smartResolve(conflict, fileName);
    }
  }

  private smartResolve(conflict: ConflictSection, fileName: string): string {
    if (fileName === "meta.json") {
      return this.smartResolveMeta(conflict);
    } else if (fileName.startsWith("dictionary.")) {
      return this.smartResolveDictionary(conflict);
    } else {
      // Default to ours for unknown file types
      return conflict.ours;
    }
  }

  private smartResolveMeta(conflict: ConflictSection): string {
    try {
      // Try to parse as complete JSON first
      const oursData = this.parseJSONFragment(conflict.ours);
      const theirsData = this.parseJSONFragment(conflict.theirs);

      if (!oursData && !theirsData) {
        // Both sides are invalid, return original
        return conflict.ours;
      }

      if (!oursData) return conflict.theirs;
      if (!theirsData) return conflict.ours;

      // Merge the data
      const merged = this.deepMerge(
        oursData,
        theirsData,
        (key, ours, theirs) => {
          // For conflicting keys, prefer the one with longer content or different hash
          if (typeof ours === "object" && typeof theirs === "object") {
            if (
              ours.content &&
              theirs.content &&
              typeof theirs.content === "string"
            ) {
              return theirs.content.length > ours.content.length
                ? theirs
                : ours;
            }
            if (ours.hash && theirs.hash && ours.hash !== theirs.hash) {
              return theirs;
            }
          }
          return theirs;
        },
      );

      // Convert back to the conflict section format
      return this.formatJSONFragment(merged);
    } catch (error) {
      // Fallback to ours if parsing fails
      return conflict.ours;
    }
  }

  private smartResolveDictionary(conflict: ConflictSection): string {
    try {
      // Parse the conflict sections as JavaScript object fragments
      const oursData = this.parseJSFragment(conflict.ours);
      const theirsData = this.parseJSFragment(conflict.theirs);

      if (!oursData && !theirsData) {
        // Both sides are invalid, return original
        return conflict.ours;
      }

      if (!oursData) return conflict.theirs;
      if (!theirsData) return conflict.ours;

      // Merge the data
      const merged = this.deepMerge(
        oursData,
        theirsData,
        (key, ours, theirs) => {
          // For conflicting keys, merge translations
          if (
            key === "content" &&
            typeof ours === "object" &&
            typeof theirs === "object"
          ) {
            const mergedContent = { ...ours };
            for (const [locale, translation] of Object.entries(theirs)) {
              if (
                !mergedContent[locale] ||
                (translation &&
                  typeof translation === "string" &&
                  String(translation).trim().length >
                    String(mergedContent[locale]).trim().length)
              ) {
                mergedContent[locale] = translation;
              }
            }
            return mergedContent;
          }
          return theirs;
        },
      );

      // Convert back to the conflict section format
      return this.formatJSFragment(merged);
    } catch (error) {
      return conflict.ours;
    }
  }

  private parseJSONFragment(fragment: string): any {
    try {
      // Try to parse as complete JSON object
      const trimmed = fragment.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        return JSON.parse(trimmed);
      }

      // Try to parse as JSON object with wrapping braces
      const wrapped = `{${trimmed}}`;
      return JSON.parse(wrapped);
    } catch {
      // Try to parse individual key-value pairs
      try {
        const result: any = {};
        const lines = fragment.split(/\n/);

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.includes(":")) {
            const match = trimmed.match(/"([^"]+)"\s*:\s*(.+)/);
            if (match) {
              try {
                result[match[1]] = JSON.parse(match[2]);
              } catch {
                // Remove quotes if present
                result[match[1]] = match[2]
                  .replace(/^["']|["']$/g, "")
                  .replace(/\\"/g, '"');
              }
            }
          }
        }

        return Object.keys(result).length > 0 ? result : null;
      } catch {
        return null;
      }
    }
  }

  private parseJSFragment(fragment: string): any {
    try {
      // Try to parse as JSON-like structure
      const cleaned = fragment
        .trim()
        .replace(/'/g, '"') // Convert single quotes to double
        .replace(/(\w+):/g, '"$1":') // Quote unquoted keys
        .replace(/,\s*\n\s*}/g, "}") // Remove trailing commas
        .replace(/,\s*\n\s*]/g, "]")
        .replace(/;$/g, "");

      return this.parseJSONFragment(cleaned);
    } catch {
      return null;
    }
  }

  private formatJSONFragment(data: any): string {
    if (!data || typeof data !== "object") {
      return "";
    }

    const entries = Object.entries(data).map(
      ([key, value]) =>
        `        "${key}": ${JSON.stringify(value, null, 10).replace(/\n/g, "\n        ")}`,
    );
    return entries.join(",\n");
  }

  private formatJSFragment(data: any): string {
    return this.formatJSONFragment(data);
  }

  private deepMerge(
    target: any,
    source: any,
    resolver?: (key: string, target: any, source: any) => any,
  ): any {
    if (!source || typeof source !== "object") return source;

    const result = Array.isArray(source)
      ? [...(target || [])]
      : { ...(target || {}) };

    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        result[key] = this.deepMerge(result[key], value, resolver);
      } else if (resolver && key in result) {
        result[key] = resolver(key, result[key], value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  private validateResolvedContent(
    content: string,
    filePath: string,
  ): { valid: boolean; error?: string } {
    const fileName = path.basename(filePath);

    try {
      if (fileName === "meta.json") {
        JSON.parse(content);
      } else if (fileName.startsWith("dictionary.")) {
        // Validate as JSON-like structure
        const jsonContent = content
          .replace(/^export\s+default\s+/, "")
          .replace(/;?\s*$/, "")
          .replace(/'/g, '"')
          .replace(/(\w+):/g, '"$1":')
          .replace(/,\s*\n\s*}/g, "}")
          .replace(/,\s*\n\s*]/g, "]");
        JSON.parse(jsonContent);
      }
      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        error: `Invalid syntax after resolution: ${error.message}`,
      };
    }
  }

  private getResolutionDetails(
    conflicts: ConflictSection[],
    filePath: string,
  ): string {
    const fileName = path.basename(filePath);
    return `Resolved ${conflicts.length} conflict(s) in ${fileName} using ${this.options.strategy} strategy`;
  }
}
