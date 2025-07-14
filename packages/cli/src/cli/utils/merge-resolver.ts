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
      // The conflict sections contain just the scopes part, not full objects
      const oursScopes = this.parseJSON(`{${conflict.ours}}`);
      const theirsScopes = this.parseJSON(`{${conflict.theirs}}`);

      if (!oursScopes || !theirsScopes) {
        // If either side is invalid JSON, prefer the valid one
        return oursScopes ? conflict.ours : conflict.theirs;
      }

      // Merge the scopes
      const mergedScopes = { ...oursScopes, ...theirsScopes };

      // For conflicting keys, apply smart merge logic
      for (const [key, theirScope] of Object.entries(theirsScopes)) {
        if (oursScopes[key]) {
          const ourScope = oursScopes[key] as any;
          const theirScopeData = theirScope as any;

          // Prefer the scope with longer content or different hash
          if (theirScopeData.hash !== ourScope.hash) {
            if (
              theirScopeData.content &&
              (!ourScope.content ||
                theirScopeData.content.length > ourScope.content.length)
            ) {
              mergedScopes[key] = theirScopeData;
            } else {
              mergedScopes[key] = ourScope;
            }
          }
        }
      }

      // Convert back to the conflict section format
      const entries = Object.entries(mergedScopes).map(
        ([key, value]) =>
          `        "${key}": ${JSON.stringify(value, null, 10).replace(/\n/g, "\n        ")}`,
      );

      return entries.join(",\n");
    } catch (error) {
      // Fallback to ours if parsing fails
      return conflict.ours;
    }
  }

  private smartResolveDictionary(conflict: ConflictSection): string {
    try {
      // The conflict sections contain just the entries part
      const oursEntries = Function(
        `"use strict"; return ({${conflict.ours}})`,
      )();
      const theirsEntries = Function(
        `"use strict"; return ({${conflict.theirs}})`,
      )();

      if (!oursEntries || !theirsEntries) {
        return oursEntries ? conflict.ours : conflict.theirs;
      }

      // Merge the entries
      const mergedEntries = { ...oursEntries, ...theirsEntries };

      // For conflicting keys, merge the translations
      for (const [key, theirEntry] of Object.entries(theirsEntries)) {
        if (oursEntries[key]) {
          const ourEntry = oursEntries[key] as any;
          const theirEntryData = theirEntry as any;

          // Merge content translations
          if (theirEntryData.content && ourEntry.content) {
            const mergedContent = {
              ...ourEntry.content,
              ...theirEntryData.content,
            };

            // For same locale conflicts, prefer longer/more detailed translations
            for (const [locale, theirTranslation] of Object.entries(
              theirEntryData.content,
            )) {
              if (ourEntry.content[locale]) {
                const ourTranslation = ourEntry.content[locale];
                if (
                  theirTranslation &&
                  String(theirTranslation).trim().length >
                    String(ourTranslation).trim().length
                ) {
                  mergedContent[locale] = theirTranslation;
                } else {
                  mergedContent[locale] = ourTranslation;
                }
              }
            }

            mergedEntries[key] = {
              ...theirEntryData,
              content: mergedContent,
            };
          }
        }
      }

      // Convert back to the conflict section format
      const entries = Object.entries(mergedEntries).map(
        ([key, value]) =>
          `        "${key}": ${JSON.stringify(value, null, 10).replace(/\n/g, "\n        ")}`,
      );

      return entries.join(",\n");
    } catch (error) {
      return conflict.ours;
    }
  }

  private mergeMeta(ours: any, theirs: any): any {
    // Start with a deep copy of ours to preserve all existing data
    const merged = JSON.parse(JSON.stringify(ours));

    // Merge version (prefer higher version)
    if (theirs.version && theirs.version > merged.version) {
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

            // Add all scopes from theirs
            for (const [scopeKey, scopeData] of Object.entries(
              theirFile.scopes,
            )) {
              if (!ourFile.scopes[scopeKey]) {
                // New scope from theirs
                ourFile.scopes[scopeKey] = scopeData;
              } else {
                // Merge scope data - prefer the one with different hash or longer content
                const ourScope = ourFile.scopes[scopeKey] as any;
                const theirScope = scopeData as any;

                if (theirScope.hash !== ourScope.hash) {
                  // Different hashes, prefer the one with more content
                  if (
                    theirScope.content &&
                    (!ourScope.content ||
                      theirScope.content.length > ourScope.content.length)
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
    // Start with a deep copy of ours to preserve all existing data
    const merged = JSON.parse(JSON.stringify(ours));

    // Merge version
    if (theirs.version && theirs.version > merged.version) {
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

                  // Merge locale translations, keeping existing and adding new ones
                  for (const [locale, translation] of Object.entries(
                    theirEntry.content,
                  )) {
                    if (!ourEntry.content[locale]) {
                      // Add new locale translation
                      ourEntry.content[locale] = translation;
                    } else if (
                      translation &&
                      String(translation).trim() &&
                      String(translation).trim().length >
                        String(ourEntry.content[locale]).trim().length
                    ) {
                      // Prefer longer/more detailed translation
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
      return Function(`"use strict"; return (${objectContent})`)();
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
