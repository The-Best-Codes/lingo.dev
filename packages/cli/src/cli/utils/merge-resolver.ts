import * as fs from "fs";
import * as path from "path";
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
  constructor(private options: ResolverOptions) {}

  async resolveFile(filePath: string): Promise<ResolutionResult> {
    try {
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
        const backupPath = `${filePath}.backup.${Date.now()}`;
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
      const ours = this.parseJSON(conflict.ours);
      const theirs = this.parseJSON(conflict.theirs);

      if (!ours || !theirs) {
        // If either side is invalid JSON, prefer the valid one
        return ours ? conflict.ours : conflict.theirs;
      }

      // Merge meta.json intelligently
      const merged = this.mergeMeta(ours, theirs);
      return JSON.stringify(merged, null, 2);
    } catch (error) {
      // Fallback to ours if parsing fails
      return conflict.ours;
    }
  }

  private smartResolveDictionary(conflict: ConflictSection): string {
    try {
      // Parse JavaScript/TypeScript export default syntax
      const ours = this.parseDictionary(conflict.ours);
      const theirs = this.parseDictionary(conflict.theirs);

      if (!ours || !theirs) {
        return ours ? conflict.ours : conflict.theirs;
      }

      // Merge dictionary intelligently
      const merged = this.mergeDictionary(ours, theirs);
      return this.formatDictionary(merged);
    } catch (error) {
      return conflict.ours;
    }
  }

  private mergeMeta(ours: any, theirs: any): any {
    const merged = { ...ours };

    // Merge version (prefer higher version)
    if (theirs.version > ours.version) {
      merged.version = theirs.version;
    }

    // Merge files
    if (theirs.files) {
      merged.files = merged.files || {};

      for (const [fileName, fileData] of Object.entries(theirs.files)) {
        if (!merged.files[fileName]) {
          // New file from theirs
          merged.files[fileName] = fileData;
        } else {
          // Merge scopes
          const ourFile = merged.files[fileName] as any;
          const theirFile = fileData as any;

          if (theirFile.scopes) {
            ourFile.scopes = ourFile.scopes || {};

            for (const [scopeKey, scopeData] of Object.entries(
              theirFile.scopes,
            )) {
              if (!ourFile.scopes[scopeKey]) {
                // New scope from theirs
                ourFile.scopes[scopeKey] = scopeData;
              } else {
                // Merge scope data - prefer the one with different hash (likely newer)
                const ourScope = ourFile.scopes[scopeKey] as any;
                const theirScope = scopeData as any;

                if (theirScope.hash !== ourScope.hash) {
                  // Different hashes, prefer the one with more content or newer timestamp
                  if (
                    theirScope.content &&
                    theirScope.content.length > ourScope.content?.length
                  ) {
                    ourFile.scopes[scopeKey] = theirScope;
                  }
                }
              }
            }
          }
        }
      }
    }

    return merged;
  }

  private mergeDictionary(ours: any, theirs: any): any {
    const merged = { ...ours };

    // Merge version
    if (theirs.version > ours.version) {
      merged.version = theirs.version;
    }

    // Merge files
    if (theirs.files) {
      merged.files = merged.files || {};

      for (const [fileName, fileData] of Object.entries(theirs.files)) {
        if (!merged.files[fileName]) {
          merged.files[fileName] = fileData;
        } else {
          // Merge entries
          const ourFile = merged.files[fileName] as any;
          const theirFile = fileData as any;

          if (theirFile.entries) {
            ourFile.entries = ourFile.entries || {};

            for (const [entryKey, entryData] of Object.entries(
              theirFile.entries,
            )) {
              if (!ourFile.entries[entryKey]) {
                ourFile.entries[entryKey] = entryData;
              } else {
                // Merge translations
                const ourEntry = ourFile.entries[entryKey] as any;
                const theirEntry = entryData as any;

                if (theirEntry.content) {
                  ourEntry.content = ourEntry.content || {};

                  // Merge locale translations, preferring non-empty values
                  for (const [locale, translation] of Object.entries(
                    theirEntry.content,
                  )) {
                    if (
                      !ourEntry.content[locale] ||
                      (translation && String(translation).trim())
                    ) {
                      ourEntry.content[locale] = translation;
                    }
                  }
                }

                // Update hash if theirs is different
                if (theirEntry.hash && theirEntry.hash !== ourEntry.hash) {
                  ourEntry.hash = theirEntry.hash;
                }
              }
            }
          }
        }
      }
    }

    return merged;
  }

  private parseJSON(content: string): any {
    try {
      return JSON.parse(content.trim());
    } catch {
      return null;
    }
  }

  private parseDictionary(content: string): any {
    try {
      // Remove export default and evaluate as JavaScript object
      const objectContent = content
        .replace(/^export\s+default\s+/, "")
        .replace(/;?\s*$/, "");
      return eval(`(${objectContent})`);
    } catch {
      return null;
    }
  }

  private formatDictionary(data: any): string {
    return `export default ${JSON.stringify(data, null, 2)};`;
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
        // Basic syntax check for dictionary files
        this.parseDictionary(content);
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
